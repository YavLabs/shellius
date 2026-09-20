/**
 * Group accessScope (docs/rbac/customer-scope-spec.md §2, "groups get their
 * own ALL/CUSTOMERS switch" decision) — every combination of user
 * accessScope x group accessScope x direct grant that `resolveScope()` and
 * `userService.getEffectiveScope()` must agree on, plus group-side editing
 * (`groupService.assignGroupScope`) and user-side group membership editing
 * (`userService.createUser`/`updateUser` `groupIds`).
 *
 * DB tests use the dbReachable() skip pattern (see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import { assignUserScope, createUser, updateUser, getUser, getEffectiveScope } from '../userService.js';
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

describe('group accessScope — combination matrix (DB)', () => {
  let reachable;
  let org;
  let roles;
  let adminUser;
  let adminActor;
  let customerA;
  let customerB;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] group accessScope DB tests: no live DB');
      return;
    }
    org = await createTestOrg();
    adminUser = await createTestUser(org.id, { role: 'admin' });
    await syncSystemRoles(org.id);
    roles = Object.fromEntries((await prisma.role.findMany({ where: { orgId: org.id } })).map((r) => [r.key, r]));
    await prisma.user.update({ where: { id: adminUser.id }, data: { roleId: roles.admin.id } });
    adminActor = await actorFor(adminUser.id);
    customerA = await createCustomer(org.id, 'Acme');
    customerB = await createCustomer(org.id, 'Beta');
  });

  afterAll(async () => {
    if (!reachable) return;
    await prisma.groupMembership.deleteMany({ where: { group: { orgId: org.id } } });
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

  async function actorFor(userId) {
    const u = await prisma.user.findUnique({ where: { id: userId }, include: { assignedRole: true } });
    return { userId: u.id, roleId: u.roleId, tier: u.role, permissions: new Set(permissionsOfRole(u.assignedRole)) };
  }

  async function memberUser(overrides = {}) {
    return createTestUser(org.id, { role: 'member', data: { roleId: roles.member.id }, ...overrides });
  }

  async function makeGroup(name, accessScope, customerIds = []) {
    const group = await prisma.group.create({ data: { orgId: org.id, name: `${name} ${unique()}` } });
    await assignGroupScope(org.id, group.id, { accessScope, customerIds }, adminActor, null);
    return group;
  }

  // ---------------------------------------------------------------------
  // Group-side: accessScope switch itself
  // ---------------------------------------------------------------------

  dbTest('group defaults to CUSTOMERS and is additive/empty until assigned', async () => {
    const group = await prisma.group.create({ data: { orgId: org.id, name: `Fresh ${unique()}` } });
    expect(group.accessScope).toBe('CUSTOMERS');
    const fetched = await getGroup(org.id, group.id);
    expect(fetched.accessScope).toBe('CUSTOMERS');
    expect(fetched.customerIds).toEqual([]);
  });

  dbTest('assignGroupScope(ALL) clears customer rows and audits the accessScope transition', async () => {
    const group = await makeGroup('Widen', 'CUSTOMERS', [customerA.id]);
    expect((await getGroup(org.id, group.id)).customerIds).toEqual([customerA.id]);

    const widened = await assignGroupScope(org.id, group.id, { accessScope: 'ALL', customerIds: [customerB.id] }, adminActor, null);
    expect(widened.accessScope).toBe('ALL');
    // ALL always normalizes customerIds to empty — they'd be dead weight.
    expect(widened.customerIds).toEqual([]);
    expect((await getGroup(org.id, group.id)).customerIds).toEqual([]);

    const audited = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'group.scope.updated', resourceId: group.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audited).toBeTruthy();
    expect(audited.metadata.accessScope).toEqual({ from: 'CUSTOMERS', to: 'ALL' });
  });

  // ---------------------------------------------------------------------
  // The combination matrix
  // ---------------------------------------------------------------------

  dbTest('user ALL + no groups -> ALL, reason user_all, no sources', async () => {
    const user = await memberUser({ data: { roleId: roles.member.id, accessScope: 'ALL' } });
    const scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'ALL' });
    expect(scope).toEqual({ mode: 'all', customerIds: [] });

    const eff = await getEffectiveScope(org.id, user.id);
    expect(eff.kind).toBe('all');
    expect(eff.reason).toBe('user_all');
    expect(eff.sources.direct).toEqual([]);
    expect(eff.sources.groups).toEqual([]);
  });

  dbTest('user ALL + scoped (CUSTOMERS) group -> still ALL, reason user_all, group surfaced in sources', async () => {
    const group = await makeGroup('StillAll', 'CUSTOMERS', [customerA.id]);
    const user = await memberUser({ data: { roleId: roles.member.id, accessScope: 'ALL' } });
    await prisma.groupMembership.create({ data: { groupId: group.id, userId: user.id } });

    const scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'ALL' });
    expect(scope).toEqual({ mode: 'all', customerIds: [] });

    const eff = await getEffectiveScope(org.id, user.id);
    expect(eff.kind).toBe('all');
    expect(eff.reason).toBe('user_all');
    expect(eff.sources.groups).toHaveLength(1);
    expect(eff.sources.groups[0]).toMatchObject({
      id: group.id,
      accessScope: 'CUSTOMERS',
      customers: [{ id: customerA.id, name: customerA.name }],
    });
  });

  dbTest('user CUSTOMERS + no groups + no direct -> empty, sees nothing', async () => {
    const user = await memberUser({ data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' } });
    const scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'CUSTOMERS' });
    expect(scope).toEqual({ mode: 'customers', customerIds: [] });

    const eff = await getEffectiveScope(org.id, user.id);
    expect(eff.kind).toBe('customers');
    expect(eff.customerIds).toEqual([]);
    expect(eff.reason).toBe('empty');
  });

  dbTest('user CUSTOMERS + direct only -> union is just the direct grant', async () => {
    const user = await memberUser({ data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' } });
    await assignUserScope(org.id, user.id, { accessScope: 'CUSTOMERS', customerIds: [customerA.id] }, adminActor, null);

    const scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'CUSTOMERS' });
    expect(scope.customerIds).toEqual([customerA.id]);

    const eff = await getEffectiveScope(org.id, user.id);
    expect(eff.kind).toBe('customers');
    expect(eff.reason).toBe('union');
    expect(eff.customerIds).toEqual([customerA.id]);
    expect(eff.sources.direct).toEqual([{ id: customerA.id, name: customerA.name }]);
    expect(eff.sources.groups).toEqual([]);
  });

  dbTest('user CUSTOMERS + group only -> union is just the group grant', async () => {
    const group = await makeGroup('GroupOnly', 'CUSTOMERS', [customerB.id]);
    const user = await memberUser({ data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' } });
    await prisma.groupMembership.create({ data: { groupId: group.id, userId: user.id } });

    const scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'CUSTOMERS' });
    expect(scope.customerIds).toEqual([customerB.id]);

    const eff = await getEffectiveScope(org.id, user.id);
    expect(eff.reason).toBe('union');
    expect(eff.customerIds).toEqual([customerB.id]);
    expect(eff.sources.direct).toEqual([]);
    expect(eff.sources.groups).toHaveLength(1);
  });

  dbTest('user CUSTOMERS + direct AND group -> true union, deduped', async () => {
    const group = await makeGroup('UnionGroup', 'CUSTOMERS', [customerA.id, customerB.id]);
    const user = await memberUser({ data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' } });
    await assignUserScope(org.id, user.id, { accessScope: 'CUSTOMERS', customerIds: [customerA.id] }, adminActor, null);
    await prisma.groupMembership.create({ data: { groupId: group.id, userId: user.id } });

    const scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'CUSTOMERS' });
    expect([...scope.customerIds].sort()).toEqual([customerA.id, customerB.id].sort());

    const eff = await getEffectiveScope(org.id, user.id);
    expect(eff.reason).toBe('union');
    // customerA appears once even though it's granted both directly AND via the group.
    expect([...eff.customerIds].sort()).toEqual([customerA.id, customerB.id].sort());
    expect(eff.customerIds.filter((id) => id === customerA.id)).toHaveLength(1);
  });

  dbTest('user CUSTOMERS + a group set to ALL -> becomes unscoped (asserted explicitly)', async () => {
    const allGroup = await makeGroup('WideningGroup', 'ALL');
    const user = await memberUser({ data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' } });
    // Give the user a direct grant too, to prove the group's ALL wins over it.
    await assignUserScope(org.id, user.id, { accessScope: 'CUSTOMERS', customerIds: [customerA.id] }, adminActor, null);
    await prisma.groupMembership.create({ data: { groupId: allGroup.id, userId: user.id } });

    const scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'CUSTOMERS' });
    expect(scope.mode).toBe('all');
    expect(scope).toEqual({ mode: 'all', customerIds: [] });

    const eff = await getEffectiveScope(org.id, user.id);
    expect(eff.kind).toBe('all');
    expect(eff.reason).toBe('group_all');
    expect(eff.sources.groups.find((g) => g.id === allGroup.id).accessScope).toBe('ALL');
  });

  dbTest('user in two groups with overlapping customers -> dedup', async () => {
    const g1 = await makeGroup('Overlap1', 'CUSTOMERS', [customerA.id, customerB.id]);
    const g2 = await makeGroup('Overlap2', 'CUSTOMERS', [customerA.id]);
    const user = await memberUser({ data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' } });
    await prisma.groupMembership.create({ data: { groupId: g1.id, userId: user.id } });
    await prisma.groupMembership.create({ data: { groupId: g2.id, userId: user.id } });

    const scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'CUSTOMERS' });
    expect([...scope.customerIds].sort()).toEqual([customerA.id, customerB.id].sort());
    expect(scope.customerIds).toHaveLength(2);

    const eff = await getEffectiveScope(org.id, user.id);
    expect(eff.customerIds).toHaveLength(2);
    expect(eff.sources.groups).toHaveLength(2);
  });

  dbTest('removing the last group falls back to direct only', async () => {
    const group = await makeGroup('Removable', 'CUSTOMERS', [customerB.id]);
    const user = await memberUser({ data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' } });
    await assignUserScope(org.id, user.id, { accessScope: 'CUSTOMERS', customerIds: [customerA.id] }, adminActor, null);
    await prisma.groupMembership.create({ data: { groupId: group.id, userId: user.id } });

    let scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'CUSTOMERS' });
    expect([...scope.customerIds].sort()).toEqual([customerA.id, customerB.id].sort());

    await prisma.groupMembership.deleteMany({ where: { groupId: group.id, userId: user.id } });

    scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'CUSTOMERS' });
    expect(scope.customerIds).toEqual([customerA.id]);

    const eff = await getEffectiveScope(org.id, user.id);
    expect(eff.customerIds).toEqual([customerA.id]);
    expect(eff.sources.groups).toEqual([]);
  });

  dbTest('deleting a customer cascades out of both UserCustomerScope and GroupCustomerScope', async () => {
    const customerZ = await createCustomer(org.id, 'CascadeZ');
    const group = await makeGroup('CascadeGroup', 'CUSTOMERS', [customerZ.id]);
    const user = await memberUser({ data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' } });
    await assignUserScope(org.id, user.id, { accessScope: 'CUSTOMERS', customerIds: [customerZ.id] }, adminActor, null);
    await prisma.groupMembership.create({ data: { groupId: group.id, userId: user.id } });

    expect(await prisma.userCustomerScope.count({ where: { customerId: customerZ.id } })).toBe(1);
    expect(await prisma.groupCustomerScope.count({ where: { customerId: customerZ.id } })).toBe(1);

    await prisma.customer.delete({ where: { id: customerZ.id } });

    expect(await prisma.userCustomerScope.count({ where: { customerId: customerZ.id } })).toBe(0);
    expect(await prisma.groupCustomerScope.count({ where: { customerId: customerZ.id } })).toBe(0);

    const scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'CUSTOMERS' });
    expect(scope.customerIds).toEqual([]);
  });

  dbTest('an unscoped (ALL) user is unaffected by any of the above', async () => {
    const allGroup = await makeGroup('Irrelevant', 'ALL');
    const scopedGroup = await makeGroup('AlsoIrrelevant', 'CUSTOMERS', [customerA.id]);
    const user = await memberUser({ data: { roleId: roles.member.id, accessScope: 'ALL' } });
    await prisma.groupMembership.create({ data: { groupId: allGroup.id, userId: user.id } });
    await prisma.groupMembership.create({ data: { groupId: scopedGroup.id, userId: user.id } });

    const scope = await resolveScope({ id: user.id, role: 'member', accessScope: 'ALL' });
    expect(scope).toEqual({ mode: 'all', customerIds: [] });

    const eff = await getEffectiveScope(org.id, user.id);
    expect(eff.kind).toBe('all');
    expect(eff.reason).toBe('user_all');
  });

  // ---------------------------------------------------------------------
  // Group membership, editable from the user side (createUser/updateUser
  // groupIds)
  // ---------------------------------------------------------------------

  dbTest('createUser accepts groupIds, gated on groups.manage, and audits the add', async () => {
    const group = await makeGroup('CreateSide', 'CUSTOMERS', [customerA.id]);
    const created = await createUser(
      org.id,
      { email: `withgroup-${unique()}@example.com`, name: 'With Group', groupIds: [group.id] },
      adminActor,
      null
    );
    const fetched = await getUser(org.id, created.id);
    expect(fetched.groups).toEqual([{ id: group.id, name: group.name }]);

    const audited = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'user.groups.updated', resourceId: created.id },
    });
    expect(audited).toBeTruthy();
    expect(audited.metadata.added).toEqual([{ id: group.id, name: group.name }]);
    expect(audited.metadata.removed).toEqual([]);
  });

  dbTest('createUser rejects groupIds without groups.manage', async () => {
    const group = await makeGroup('NoPerm', 'CUSTOMERS', []);
    const weakActor = { userId: adminUser.id, roleId: roles.member.id, tier: 'member', permissions: new Set() };
    await expect(
      createUser(org.id, { email: `nogroup-${unique()}@example.com`, name: 'No Perm', groupIds: [group.id] }, weakActor, null)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  dbTest('createUser 404s on an unknown groupId rather than silently dropping it', async () => {
    await expect(
      createUser(org.id, { email: `badgroup-${unique()}@example.com`, name: 'Bad Group', groupIds: ['does-not-exist'] }, adminActor, null)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  dbTest('updateUser replaces group membership transactionally and audits add + remove deltas', async () => {
    const groupOld = await makeGroup('Old', 'CUSTOMERS', []);
    const groupNew = await makeGroup('New', 'CUSTOMERS', []);
    const user = await memberUser();
    await prisma.groupMembership.create({ data: { groupId: groupOld.id, userId: user.id } });

    await updateUser(org.id, user.id, { groupIds: [groupNew.id] }, adminActor, {});

    const fetched = await getUser(org.id, user.id);
    expect(fetched.groups).toEqual([{ id: groupNew.id, name: groupNew.name }]);

    const audited = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'user.groups.updated', resourceId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audited.metadata.added).toEqual([{ id: groupNew.id, name: groupNew.name }]);
    expect(audited.metadata.removed).toEqual([{ id: groupOld.id, name: groupOld.name }]);
  });

  dbTest('updateUser can change ONLY group membership (no other field)', async () => {
    const group = await makeGroup('OnlyGroups', 'CUSTOMERS', []);
    const user = await memberUser();
    const result = await updateUser(org.id, user.id, { groupIds: [group.id] }, adminActor, {});
    expect(result.id).toBe(user.id);
    const fetched = await getUser(org.id, user.id);
    expect(fetched.groups).toEqual([{ id: group.id, name: group.name }]);
  });

  dbTest('a user cannot set their own group membership via updateUser (self-service is name-only)', async () => {
    const group = await makeGroup('SelfAttempt', 'CUSTOMERS', []);
    const selfActor = await actorFor(adminUser.id);
    await expect(
      updateUser(org.id, adminUser.id, { groupIds: [group.id] }, selfActor, {})
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  dbTest('GET /users/:id (getUser) returns groups: [{id,name}]; list shape is untouched by group scope', async () => {
    const group = await makeGroup('ListShape', 'CUSTOMERS', []);
    const user = await memberUser();
    await prisma.groupMembership.create({ data: { groupId: group.id, userId: user.id } });

    const fetched = await getUser(org.id, user.id);
    expect(fetched.groups).toEqual([{ id: group.id, name: group.name }]);
  });
});
