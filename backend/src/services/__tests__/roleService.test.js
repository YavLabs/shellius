/**
 * roleService — custom roles, the no-escalation rules, the system-role sync
 * (including the migration of the legacy role-keyed org settings) and the
 * user-management target checks built on it (docs/rbac F-01/F-02).
 *
 * Pure-function tests always run; DB tests use the dbReachable() skip
 * pattern (see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import {
  canActOnRole,
  permissionsOfRole,
  syncSystemRoles,
  createRole,
  updateRole,
  deleteRole,
  resetRole,
  isAutoAssignable,
} from '../roleService.js';
import { updateUser, createUser } from '../userService.js';
import { canBypassProdApproval, updateAccessSettings } from '../orgService.js';
import { PERMISSION_KEYS, defaultPermissionsFor } from '../../config/permissions.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

const actor = (tier, extra = {}) => ({
  userId: `u-${tier}`,
  roleId: `r-${tier}`,
  tier,
  permissions: new Set(tier === 'super_admin' ? PERMISSION_KEYS : defaultPermissionsFor(tier)),
  ...extra,
});

describe('roleService — pure rules', () => {
  test('super_admin system role always has every permission, whatever is stored', () => {
    expect(permissionsOfRole({ key: 'super_admin', isSystem: true, permissions: [] })).toEqual(PERMISSION_KEYS);
    // a custom role that happens to be keyed super_admin is NOT the owner role
    expect(permissionsOfRole({ key: 'super_admin', isSystem: false, permissions: ['servers.view'] })).toEqual([
      'servers.view',
    ]);
  });

  test('unknown permission keys are dropped', () => {
    expect(permissionsOfRole({ key: 'x', isSystem: false, permissions: ['servers.view', 'bogus.perm'] })).toEqual([
      'servers.view',
    ]);
  });

  test('admin can act on manager/member roles but not on super_admin or stronger custom roles', () => {
    const admin = actor('admin');
    expect(canActOnRole(admin, { key: 'manager', isSystem: true, baseRole: 'manager', permissions: defaultPermissionsFor('manager') })).toBe(true);
    expect(canActOnRole(admin, { key: 'super_admin', isSystem: true, baseRole: 'super_admin', permissions: [] })).toBe(false);
    const senior = { key: 'senior', isSystem: false, baseRole: 'admin', permissions: [...defaultPermissionsFor('admin'), 'settings.smtp'] };
    expect(canActOnRole(admin, senior)).toBe(false);
  });

  test('a role with a higher base tier is out of reach even with fewer permissions', () => {
    const manager = actor('manager', { permissions: new Set([...defaultPermissionsFor('manager'), 'roles.manage']) });
    expect(canActOnRole(manager, { key: 'x', isSystem: false, baseRole: 'admin', permissions: [] })).toBe(false);
  });

  test('roles with sensitive permissions are never auto-assignable (SSO)', () => {
    expect(isAutoAssignable({ key: 'member', isSystem: true, permissions: defaultPermissionsFor('member') })).toBe(true);
    expect(isAutoAssignable({ key: 'admin', isSystem: true, permissions: defaultPermissionsFor('admin') })).toBe(false);
    expect(isAutoAssignable({ key: 'super_admin', isSystem: true, permissions: [] })).toBe(false);
  });
});

describe('roleService — DB', () => {
  let reachable;
  let org;
  let roles;
  let sa;
  let adminUser;
  let member;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] roleService DB tests: no live DB');
      return;
    }
    // Legacy settings: only super admins bypass prod; Quick Connect for admins+.
    org = await createTestOrg();
    await prisma.organization.update({
      where: { id: org.id },
      data: { settings: { access: { prodApprovalBypassMinRole: 'super_admin' }, quickConnect: { enabled: true, minRole: 'admin' } } },
    });
    sa = await createTestUser(org.id, { role: 'super_admin' });
    adminUser = await createTestUser(org.id, { role: 'admin' });
    member = await createTestUser(org.id, { role: 'member' });
    await syncSystemRoles(org.id);
    roles = Object.fromEntries((await prisma.role.findMany({ where: { orgId: org.id } })).map((r) => [r.key, r]));
  });

  afterAll(async () => {
    if (!reachable) return;
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.role.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const dbTest = (name, fn) => test(name, async () => {
    if (!reachable) return;
    await fn();
  });

  const actorFor = async (user) => {
    const u = await prisma.user.findUnique({ where: { id: user.id }, include: { assignedRole: true } });
    return { userId: u.id, roleId: u.roleId, tier: u.role, permissions: new Set(permissionsOfRole(u.assignedRole)) };
  };

  dbTest('sync creates the four system roles and links every user', async () => {
    expect(Object.keys(roles).sort()).toEqual(['admin', 'manager', 'member', 'super_admin']);
    const unlinked = await prisma.user.count({ where: { orgId: org.id, roleId: null } });
    expect(unlinked).toBe(0);
  });

  dbTest('legacy settings migrate onto the built-in roles', async () => {
    expect(roles.admin.permissions).not.toContain('access.prod_bypass'); // bypass was super_admin-only
    expect(roles.admin.permissions).toContain('quick_connect.use'); // minRole admin
    expect(roles.manager.permissions).not.toContain('quick_connect.use');
  });

  dbTest('sync is idempotent and keeps edits', async () => {
    await prisma.role.update({ where: { id: roles.member.id }, data: { permissions: ['servers.view'] } });
    await syncSystemRoles(org.id);
    const again = await prisma.role.findUnique({ where: { id: roles.member.id } });
    expect(again.permissions).toEqual(['servers.view']);
    expect(await prisma.role.count({ where: { orgId: org.id } })).toBe(4);
    await prisma.role.update({ where: { id: roles.member.id }, data: { permissions: defaultPermissionsFor('member') } });
  });

  dbTest('admin cannot touch a super admin (F-01)', async () => {
    const a = await actorFor(adminUser);
    await expect(updateUser(org.id, sa.id, { name: 'x' }, a)).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateUser(org.id, sa.id, { status: 'suspended' }, a)).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateUser(org.id, member.id, { password: 'Another-Password-1' }, a)).rejects.toMatchObject({ statusCode: 400 });
  });

  dbTest('the last active super admin cannot be demoted or suspended', async () => {
    const s = await actorFor(sa);
    const other = await createTestUser(org.id, { role: 'admin', data: { roleId: roles.admin.id } });
    // promote someone, then demote them is fine; demoting the only SA is not
    const second = await actorFor(other);
    second.tier = 'super_admin';
    second.permissions = new Set(PERMISSION_KEYS);
    await expect(updateUser(org.id, sa.id, { roleId: roles.admin.id }, second)).rejects.toMatchObject({ statusCode: 409 });
    await expect(updateUser(org.id, sa.id, { status: 'suspended' }, second)).rejects.toMatchObject({ statusCode: 409 });
    await prisma.user.delete({ where: { id: other.id } });
    expect(s.tier).toBe('super_admin');
  });

  dbTest('custom role: subset rule on create, assign and edit', async () => {
    const s = await actorFor(sa);
    const a = await actorFor(adminUser);
    const senior = await createRole(org.id, s, { name: 'Senior admin', copyFromRoleId: roles.admin.id });
    await updateRole(org.id, s, senior.id, { permissions: [...senior.permissions, 'settings.smtp'] });

    await expect(createRole(org.id, a, { name: 'Sneaky', permissions: ['settings.smtp'] })).rejects.toMatchObject({ statusCode: 403 });
    await expect(createRole(org.id, a, { name: 'Sneaky', copyFromRoleId: senior.id })).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateRole(org.id, a, senior.id, { description: 'x' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateUser(org.id, member.id, { roleId: senior.id }, a)).rejects.toMatchObject({ statusCode: 403 });
    await expect(createUser(org.id, { email: `n-${Date.now()}@example.com`, name: 'N', roleId: senior.id }, a)).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateRole(org.id, a, roles.admin.id, { permissions: [] })).rejects.toMatchObject({ statusCode: 403 });

    // Super admin assigns it; the user's tier follows the role's base
    const updated = await updateUser(org.id, member.id, { roleId: senior.id }, s);
    expect(updated.role).toBe('admin');
    expect(updated.roleInfo.name).toBe('Senior admin');

    // Deleting needs a target role; users move and their tier follows
    await expect(deleteRole(org.id, s, senior.id)).rejects.toMatchObject({ statusCode: 409 });
    const res = await deleteRole(org.id, s, senior.id, { reassignToRoleId: roles.member.id });
    expect(res.usersMoved).toBe(1);
    const back = await prisma.user.findUnique({ where: { id: member.id } });
    expect(back.roleId).toBe(roles.member.id);
    expect(back.role).toBe('member');
  });

  dbTest('built-in roles can be reset to defaults; super admin role is locked', async () => {
    const s = await actorFor(sa);
    await updateRole(org.id, s, roles.manager.id, { permissions: ['servers.view'] });
    const reset = await resetRole(org.id, s, roles.manager.id);
    expect(reset.permissions).toEqual(defaultPermissionsFor('manager'));
    await expect(updateRole(org.id, s, roles.super_admin.id, { permissions: [] })).rejects.toMatchObject({ statusCode: 403 });
    await expect(deleteRole(org.id, s, roles.member.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  dbTest('prod bypass = permission AND org switch', async () => {
    const s = await actorFor(sa);
    expect(await canBypassProdApproval(org.id, s.permissions)).toBe(true);
    await updateAccessSettings(org.id, { prodBypassEnabled: false });
    expect(await canBypassProdApproval(org.id, s.permissions)).toBe(false);
    await updateAccessSettings(org.id, { prodApprovalBypassMinRole: 'admin' }); // legacy: on + admin gets it
    const adminRole = await prisma.role.findUnique({ where: { id: roles.admin.id } });
    expect(adminRole.permissions).toContain('access.prod_bypass');
    expect(await canBypassProdApproval(org.id, new Set(adminRole.permissions))).toBe(true);
  });
});
