import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  ADMIN_SECTIONS,
  canSeeAdministration,
  filterSections,
  groupSections,
  legacyAdminPath,
  resolveAdminRoute,
  sectionKeyFromPath,
  visibleSections,
} from './adminSections';
import { ROUTE_ACCESS, NAV_ITEMS, isNavItemVisible, matchesNavItem, SEQUENCES, isSequenceVisible } from './commands';

const member = { role: 'member', permissions: ['servers.view', 'access.request'] };
const usersOnly = { role: 'member', permissions: ['users.view'] };
const emailAndRoles = { role: 'admin', permissions: ['settings.smtp', 'roles.view'] };
const everything = { role: 'super_admin', permissions: [...ADMIN_PERMISSIONS, 'ca.rotate'] };
// Role names are never trusted — only permissions count.
const nameOnly = { role: 'super_admin', permissions: [] };

const keys = (sections) => sections.map((s) => s.key);

describe('sections table', () => {
  it('matches the spec: groups, order, routes and permissions', () => {
    expect(ADMIN_SECTIONS.map((s) => [s.group, s.key, s.anyOf.join('|')])).toEqual([
      ['people', 'users', 'users.view'],
      ['people', 'roles', 'roles.view'],
      ['people', 'groups', 'groups.view'],
      ['people', 'policies', 'policies.view'],
      ['people', 'service-accounts', 'service_accounts.view'],
      ['authentication', 'sso', 'settings.sso'],
      ['authentication', 'mfa', 'settings.mfa'],
      ['authentication', 'access', 'org.access_settings'],
      ['organization', 'organization', 'org.update'],
      ['organization', 'ca', 'ca.view'],
      ['organization', 'quick-connect', 'quick_connect.settings'],
      ['organization', 'posture', 'posture.settings'],
      ['organization', 'audit-sinks', 'audit.sinks'],
      ['integrations', 'email', 'settings.smtp'],
      ['integrations', 'storage', 'settings.storage'],
    ]);
  });

  it("ROUTE_ACCESS['/admin'] is the union of every section's permissions", () => {
    expect([...ROUTE_ACCESS['/admin'].anyOf].sort()).toEqual([...new Set(ADMIN_SECTIONS.flatMap((s) => s.anyOf))].sort());
    expect(ROUTE_ACCESS['/settings']).toBeUndefined();
    expect(ROUTE_ACCESS['/users']).toBeUndefined();
  });
});

describe('visibility', () => {
  it('shows only the sections the viewer has permissions for', () => {
    expect(keys(visibleSections(member))).toEqual([]);
    expect(keys(visibleSections(nameOnly))).toEqual([]);
    expect(keys(visibleSections(usersOnly))).toEqual(['users']);
    expect(keys(visibleSections(emailAndRoles))).toEqual(['roles', 'email']);
    expect(keys(visibleSections(everything))).toEqual(keys(ADMIN_SECTIONS));
    expect(keys(visibleSections(null))).toEqual([]);
  });

  it('Administration entry appears only with at least one section', () => {
    expect(canSeeAdministration(member)).toBe(false);
    expect(canSeeAdministration(nameOnly)).toBe(false);
    expect(canSeeAdministration(usersOnly)).toBe(true);
  });

  it('groups visible sections in group order and drops empty groups', () => {
    const groups = groupSections(visibleSections(emailAndRoles));
    expect(groups.map((g) => [g.key, keys(g.sections)])).toEqual([
      ['people', ['roles']],
      ['integrations', ['email']],
    ]);
  });
});

describe('resolveAdminRoute', () => {
  it('sends viewers with no section to the dashboard', () => {
    expect(resolveAdminRoute(member)).toEqual({ redirect: '/' });
    expect(resolveAdminRoute(member, 'users')).toEqual({ redirect: '/' });
  });

  it('opens the first visible section for bare /admin', () => {
    expect(resolveAdminRoute(usersOnly)).toEqual({ redirect: '/admin/users' });
    expect(resolveAdminRoute(emailAndRoles)).toEqual({ redirect: '/admin/roles' });
    expect(resolveAdminRoute({ permissions: ['settings.storage'] })).toEqual({ redirect: '/admin/storage' });
  });

  it('shows the section list for bare /admin on phones (listOnBare)', () => {
    expect(resolveAdminRoute(usersOnly, undefined, { listOnBare: true })).toEqual({ list: true });
    // Everything else behaves the same.
    expect(resolveAdminRoute(member, undefined, { listOnBare: true })).toEqual({ redirect: '/' });
    expect(resolveAdminRoute(usersOnly, 'email', { listOnBare: true })).toEqual({ redirect: '/admin' });
    expect(resolveAdminRoute(usersOnly, 'users', { listOnBare: true }).section.key).toBe('users');
  });

  it('gives every section a one-line description for the phone list', () => {
    for (const s of ADMIN_SECTIONS) {
      expect(typeof s.description).toBe('string');
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.description.length).toBeLessThanOrEqual(60);
    }
  });

  it('bounces hidden or unknown sections back to /admin', () => {
    expect(resolveAdminRoute(usersOnly, 'email')).toEqual({ redirect: '/admin' });
    expect(resolveAdminRoute(usersOnly, 'nope')).toEqual({ redirect: '/admin' });
  });

  it('renders a visible section', () => {
    expect(resolveAdminRoute(emailAndRoles, 'email').section.key).toBe('email');
    expect(resolveAdminRoute(everything, 'quick-connect').section.label).toBe('Quick Connect');
  });

  it('reads the section key out of a path', () => {
    expect(sectionKeyFromPath('/admin')).toBeNull();
    expect(sectionKeyFromPath('/admin/')).toBeNull();
    expect(sectionKeyFromPath('/admin/roles/abc')).toBe('roles');
    expect(sectionKeyFromPath('/admin/email?connected=1')).toBe('email');
    expect(sectionKeyFromPath('/servers/admin')).toBeNull();
  });
});

describe('search', () => {
  const all = visibleSections(everything);
  const find = (q) => keys(filterSections(all, q));

  it('matches labels, group names and keywords, case-insensitively', () => {
    expect(find('')).toEqual(keys(all));
    expect(find('  ')).toEqual(keys(all));
    expect(find('Users')).toEqual(['users']);
    for (const q of ['smtp', 'email', 'SendGrid', 'mailgun']) expect(find(q)).toContain('email');
    for (const q of ['okta', 'google', 'oidc', 'saml', 'github']) expect(find(q)).toContain('sso');
    for (const q of ['totp', '2fa', 'two-factor']) expect(find(q)).toContain('mfa');
    for (const q of ['certificate', 'ssh ca']) expect(find(q)).toContain('ca');
    expect(find('integrations')).toEqual(['email', 'storage']);
  });

  it('returns nothing for a query that matches no section', () => {
    expect(find('zzzz-no-such-setting')).toEqual([]);
  });

  it('only searches sections the viewer can see', () => {
    expect(keys(filterSections(visibleSections(usersOnly), 'smtp'))).toEqual([]);
  });
});

describe('legacy URLs', () => {
  it.each([
    ['/settings', '', '/admin'],
    ['/settings', '?tab=org', '/admin/organization'],
    ['/settings', '?tab=ca', '/admin/ca'],
    ['/settings', '?tab=sso', '/admin/sso'],
    ['/settings', '?tab=access', '/admin/access'],
    ['/settings', '?tab=storage', '/admin/storage'],
    ['/settings', '?tab=mfa', '/admin/mfa'],
    ['/settings', '?tab=quickconnect', '/admin/quick-connect'],
    ['/settings', '?tab=email', '/admin/email'],
    ['/settings', '?tab=EMAIL', '/admin/email'],
    ['/settings', '?tab=unknown', '/admin'],
    ['/settings', '?tab=email&connected=1', '/admin/email?connected=1'],
    ['/settings', '?tab=email&error=invalid_state', '/admin/email?error=invalid_state'],
    ['/users', '', '/admin/users'],
    ['/users', '?action=invite', '/admin/users?action=invite'],
    ['/users', '?highlight=u1', '/admin/users?highlight=u1'],
    ['/users/u1', '', '/admin/users/u1'],
    ['/roles', '', '/admin/roles'],
    ['/roles/r1', '', '/admin/roles/r1'],
    ['/groups', '', '/admin/groups'],
    ['/groups/g1', '', '/admin/groups/g1'],
  ])('%s%s → %s', (path, search, expected) => {
    expect(legacyAdminPath(path, search)).toBe(expected);
  });

  it('ignores paths that are not old admin URLs', () => {
    expect(legacyAdminPath('/servers')).toBeNull();
    expect(legacyAdminPath('/settings/extra')).toBeNull();
    expect(legacyAdminPath('/roles/r1/extra')).toBeNull();
  });
});

describe('palette and shortcuts', () => {
  it('has one palette entry per section, each gated by its own permission', () => {
    const ids = NAV_ITEMS.filter((i) => isNavItemVisible(i, usersOnly)).map((i) => i.id);
    expect(ids.filter((id) => id.startsWith('admin-'))).toEqual(['admin-users']);
    const entry = NAV_ITEMS.find((i) => i.id === 'admin-email');
    expect(entry.label).toBe('Administration › Email');
    expect(entry.to).toBe('/admin/email');
    expect(matchesNavItem(entry, 'smtp')).toBe(true);
    expect(matchesNavItem(entry, 'okta')).toBe(false);
  });

  it('g u / g g follow the Users / Groups section permissions', () => {
    const visible = (u) => SEQUENCES.filter((s) => isSequenceVisible(s, u, false)).map((s) => s.keys.join(''));
    expect(visible(usersOnly)).toContain('gu');
    expect(visible(usersOnly)).not.toContain('gg');
    expect(visible(emailAndRoles)).not.toContain('gu');
  });
});
