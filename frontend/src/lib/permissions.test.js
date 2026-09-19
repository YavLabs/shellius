import { describe, expect, it } from 'vitest';
import { can, canAny, canAll, roleName } from './permissions';
import { canAccessRoute, isNavItemVisible, isQuickActionVisible, isSequenceVisible, NAV_ITEMS, QUICK_ACTIONS, SEQUENCES } from './commands';

const member = { role: 'member', permissions: ['customers.view', 'servers.view', 'access.request'] };
const custom = {
  role: 'admin',
  roleInfo: { name: 'Senior admin' },
  permissions: ['servers.view', 'users.view', 'settings.smtp', 'roles.view'],
};

describe('permission helpers', () => {
  it('can / canAny / canAll read user.permissions only', () => {
    expect(can(member, 'servers.view')).toBe(true);
    expect(can(member, 'users.view')).toBe(false);
    expect(can({ role: 'super_admin' }, 'users.view')).toBe(false); // role name is never trusted
    expect(canAny(member, 'users.view', 'servers.view')).toBe(true);
    expect(canAll(member, 'users.view', 'servers.view')).toBe(false);
    expect(can(null, 'servers.view')).toBe(false);
  });

  it('roleName prefers the custom role name', () => {
    expect(roleName(custom)).toBe('Senior admin');
    expect(roleName(member)).toBe('Member');
  });
});

describe('route access', () => {
  it('open pages need nothing, gated pages need their permission', () => {
    expect(canAccessRoute(member, '/dashboard')).toBe(true);
    expect(canAccessRoute(member, '/terminals')).toBe(true);
    expect(canAccessRoute(member, '/servers/abc')).toBe(true);
    expect(canAccessRoute(member, '/admin')).toBe(false);
    expect(canAccessRoute(member, '/admin/users')).toBe(false);
    expect(canAccessRoute(custom, '/admin')).toBe(true); // any section's permission
    expect(canAccessRoute(custom, '/admin/roles/xyz')).toBe(true);
    expect(canAccessRoute(custom, '/admin/email?connected=1')).toBe(true);
    expect(canAccessRoute(custom, '/admin/sso')).toBe(false); // each section checks its own
    expect(canAccessRoute(custom, '/policies?action=new')).toBe(false);
  });

  it('nav, quick actions and shortcuts follow the same rules', () => {
    const visible = NAV_ITEMS.filter((i) => isNavItemVisible(i, member)).map((i) => i.id);
    expect(visible).toContain('servers');
    expect(visible).not.toContain('admin-users');
    const adminNav = NAV_ITEMS.filter((i) => isNavItemVisible(i, custom)).map((i) => i.id).filter((id) => id.startsWith('admin-'));
    expect(adminNav).toEqual(['admin-users', 'admin-roles', 'admin-email']);
    const actions = QUICK_ACTIONS.filter((a) => isQuickActionVisible(a, member, false)).map((a) => a.id);
    expect(actions).toContain('new-access-request');
    expect(actions).not.toContain('new-server');
    expect(actions).not.toContain('quick-connect');
    const keys = SEQUENCES.filter((s) => isSequenceVisible(s, member, false)).map((s) => s.keys.join(''));
    expect(keys).toContain('gs');
    expect(keys).not.toContain('gu');
    expect(keys).not.toContain('cs');
  });
});
