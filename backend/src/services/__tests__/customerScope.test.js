/**
 * Customer scope assignment (docs/rbac/customer-scope-spec.md) — the
 * `users.assign_scope` write paths (`userService.assignUserScope`,
 * `groupService.assignGroupScope`) plus `lib/scope.js#resolveScope` picking
 * up a group's contribution and the cascade-delete guarantee the spec
 * leans on (§5.3 "Deleting a customer").
 *
 * DB tests use the dbReachable() skip pattern (see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import { assignUserScope, getUser, createUser } from '../userService.js';
import { assignGroupScope, getGroup } from '../groupService.js';
import { syncSystemRoles, permissionsOfRole } from '../roleService.js';
import { resolveScope } from '../../lib/scope.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

async function createCustomer(orgId, name) {
  const suffix = unique();
  return prisma.customer.create({ data: { orgId, name, slug: `${name.toLowerCase()}-${suffix}` } });
}

describe('customer scope assignment — DB', () => {
  let reachable;
  let org;
  let roles;
  let adminUser;
  let adminActor;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] customer scope DB tests: no live DB');
      return;
    }
    org = await createTestOrg();
    adminUser = await createTestUser(org.id, { role: 'admin' });
    await syncSystemRoles(org.id);
    roles = Object.fromEntries((await prisma.role.findMany({ where: { orgId: org.id } })).map((r) => [r.key, r]));
    await prisma.user.update({ where: { id: adminUser.id }, data: { roleId: roles.admin.id } });
    adminActor = await actorFor(adminUser.id);
  });

  afterAll(async () => {
    if (!reachable) return;
    await prisma.groupCustomerScope.deleteMany({ where: { group: { orgId: org.id } } });
    await prisma.userCustomerScope.deleteMany({ where: { user: { orgId: org.id } } });
    await prisma.group.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.role.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const dbTest = (name, fn) => test(name, async () => {
    if (!reachable) return;
    await fn();
  });

  // actorFromReq shape: { userId, roleId, tier, permissions }
  async function actorFor(userId) {
    const u = await prisma.user.findUnique({ where: { id: userId }, include: { assignedRole: true } });
    return { userId: u.id, roleId: u.roleId, tier: u.role, permissions: new Set(permissionsOfRole(u.assignedRole)) };
  }

  dbTest('scopes a user: accessScope + customerIds are set and readable back', async () => {
    const customerA = await createCustomer(org.id, 'Acme');
    const target = await createTestUser(org.id, { role: 'member', data: { roleId: roles.member.id } });

    const result = await assignUserScope(
      org.id,
      target.id,
      { accessScope: 'CUSTOMERS', customerIds: [customerA.id] },
      adminActor,
      null,
      { ipAddress: '127.0.0.1', userAgent: 'jest' }
    );
    expect(result.accessScope).toBe('CUSTOMERS');
    expect(result.customerIds).toEqual([customerA.id]);

    const fetched = await getUser(org.id, target.id);
    expect(fetched.accessScope).toBe('CUSTOMERS');
    expect(fetched.customerIds).toEqual([customerA.id]);

    // Re-assigning replaces the set rather than adding to it.
    const customerB = await createCustomer(org.id, 'Beta');
    const replaced = await assignUserScope(
      org.id,
      target.id,
      { accessScope: 'CUSTOMERS', customerIds: [customerB.id] },
      adminActor,
      null
    );
    expect(replaced.customerIds).toEqual([customerB.id]);

    const audited = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'user.scope.updated', resourceId: target.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audited).toBeTruthy();
    expect(audited.metadata.after).toEqual([{ id: customerB.id, name: 'Beta' }]);
  });

  dbTest('nobody may change their own scope', async () => {
    await expect(
      assignUserScope(org.id, adminUser.id, { accessScope: 'CUSTOMERS', customerIds: [] }, adminActor, null)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  dbTest('super_admin targets can never be scoped', async () => {
    const sa = await createTestUser(org.id, { role: 'super_admin', data: { roleId: roles.super_admin.id } });
    await expect(
      assignUserScope(org.id, sa.id, { accessScope: 'CUSTOMERS', customerIds: [] }, adminActor, null)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  dbTest('a scoped caller may only grant customers within their own scope', async () => {
    const customerA = await createCustomer(org.id, 'InScope');
    const customerB = await createCustomer(org.id, 'OutOfScope');
    const target = await createTestUser(org.id, { role: 'member', data: { roleId: roles.member.id } });
    const callerScope = { mode: 'customers', customerIds: [customerA.id] };

    await expect(
      assignUserScope(
        org.id,
        target.id,
        { accessScope: 'CUSTOMERS', customerIds: [customerB.id] },
        adminActor,
        callerScope
      )
      // 404, NOT a 403 "that exists but you may not grant it": distinguishing
      // the two would let a scoped admin enumerate every customer id in the
      // org one guess at a time (customer-scope-spec.md §2.3.2). The caller's
      // own scope is folded into the existence check for exactly this reason.
    ).rejects.toMatchObject({ statusCode: 404 });

    // The in-scope customer is fine.
    const ok = await assignUserScope(
      org.id,
      target.id,
      { accessScope: 'CUSTOMERS', customerIds: [customerA.id] },
      adminActor,
      callerScope
    );
    expect(ok.customerIds).toEqual([customerA.id]);
  });

  dbTest('an unknown customerId 404s rather than silently dropping', async () => {
    const target = await createTestUser(org.id, { role: 'member', data: { roleId: roles.member.id } });
    await expect(
      assignUserScope(org.id, target.id, { accessScope: 'CUSTOMERS', customerIds: ['does-not-exist'] }, adminActor, null)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  dbTest('createUser accepts an optional scope grant, gated the same way', async () => {
    const customerA = await createCustomer(org.id, 'CreateCo');
    const created = await createUser(
      org.id,
      { email: `scoped-${unique()}@example.com`, name: 'Scoped At Create', accessScope: 'CUSTOMERS', customerIds: [customerA.id] },
      adminActor,
      null
    );
    expect(created.accessScope).toBe('CUSTOMERS');
    expect(created.customerIds).toEqual([customerA.id]);
  });

  dbTest('group scope contributes to a member\'s effective scope via resolveScope', async () => {
    const customerX = await createCustomer(org.id, 'GroupCo');
    const group = await prisma.group.create({ data: { orgId: org.id, name: `Support ${unique()}` } });

    const assigned = await assignGroupScope(org.id, group.id, { accessScope: 'CUSTOMERS', customerIds: [customerX.id] }, adminActor, null);
    expect(assigned.customerIds).toEqual([customerX.id]);
    expect((await getGroup(org.id, group.id)).customerIds).toEqual([customerX.id]);

    const auditedGroup = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'group.scope.updated', resourceId: group.id },
    });
    expect(auditedGroup).toBeTruthy();

    // The member has no UserCustomerScope rows of their own — only the group's.
    const member = await createTestUser(org.id, {
      role: 'member',
      data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' },
    });
    await prisma.groupMembership.create({ data: { groupId: group.id, userId: member.id } });

    const scope = await resolveScope({ id: member.id, role: 'member', accessScope: 'CUSTOMERS' });
    expect(scope.mode).toBe('customers');
    expect(scope.customerIds).toEqual([customerX.id]);
  });

  dbTest('deleting a customer cascades its scope rows (schema onDelete: Cascade)', async () => {
    const customerY = await createCustomer(org.id, 'CascadeCo');
    const target = await createTestUser(org.id, { role: 'member', data: { roleId: roles.member.id } });
    const group = await prisma.group.create({ data: { orgId: org.id, name: `Cascade ${unique()}` } });

    await assignUserScope(org.id, target.id, { accessScope: 'CUSTOMERS', customerIds: [customerY.id] }, adminActor, null);
    await assignGroupScope(org.id, group.id, { accessScope: 'CUSTOMERS', customerIds: [customerY.id] }, adminActor, null);

    expect(await prisma.userCustomerScope.count({ where: { customerId: customerY.id } })).toBe(1);
    expect(await prisma.groupCustomerScope.count({ where: { customerId: customerY.id } })).toBe(1);

    await prisma.customer.delete({ where: { id: customerY.id } });

    expect(await prisma.userCustomerScope.count({ where: { customerId: customerY.id } })).toBe(0);
    expect(await prisma.groupCustomerScope.count({ where: { customerId: customerY.id } })).toBe(0);
  });
});
