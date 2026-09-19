import { describe, expect, it } from 'vitest';
import {
  BOTTOM_NAV_ITEMS,
  isMoreActive,
  moreSheetSections,
  centreSheetGroups,
  isBottomNavHidden,
  isBottomNavItemActive,
  isKeyboardOpen,
  splitAroundCentre,
} from './mobileNav';
import { QUICK_ACTIONS } from './commands';

const ids = (items) => items.map((i) => i.id);

// Permission sets — role names are never trusted.
const admin = {
  role: 'admin',
  permissions: ['servers.view', 'servers.create', 'keystore.view', 'keystore.manage', 'sessions.view_all', 'vault.hosts', 'access.request', 'customers.create', 'users.invite', 'policies.manage', 'import.run', 'keystore.deploy'],
};
const noServers = { role: 'member', permissions: ['vault.hosts', 'keystore.view'] };
const bare = { role: 'super_admin', permissions: [] };

describe('BOTTOM_NAV_ITEMS', () => {
  it('is Home, Connect, Activity (More and "+" are drawn by BottomNav)', () => {
    expect(ids(BOTTOM_NAV_ITEMS)).toEqual(['dashboard', 'connect', 'activity']);
  });

  it('keeps a tab lit on the pages it leads to', () => {
    const [home, connect, activity] = BOTTOM_NAV_ITEMS;
    expect(isBottomNavItemActive(home, '/dashboard')).toBe(true);
    expect(isBottomNavItemActive(connect, '/servers/abc')).toBe(true);
    expect(isBottomNavItemActive(connect, '/terminals')).toBe(true);
    expect(isBottomNavItemActive(activity, '/access-requests?tab=to-review')).toBe(true);
    expect(isBottomNavItemActive(activity, '/servers')).toBe(false);
    expect(isBottomNavItemActive(home, '/servers')).toBe(false);
  });

  it('lights More everywhere else', () => {
    expect(isMoreActive('/keystore')).toBe(true);
    expect(isMoreActive('/admin/users')).toBe(true);
    expect(isMoreActive('/servers')).toBe(false);
    expect(isMoreActive('/')).toBe(false);
  });
});

describe('moreSheetSections', () => {
  const sections = [
    { label: 'A', items: [{ id: 'servers', to: '/servers' }, { id: 'terminals', to: '/terminals' }] },
    { label: 'B', items: [{ id: 'audit', to: '/audit-log' }] },
  ];
  it('keeps only pages the viewer may open and drops empty groups', () => {
    const out = moreSheetSections(bare, sections);
    expect(out.map((s) => s.label)).toEqual(['A']);
    expect(ids(out[0].items)).toEqual(['terminals']);
    expect(moreSheetSections(admin, sections)[0].items).toHaveLength(2);
  });
});

describe('splitAroundCentre', () => {
  it('puts two items either side of the centre button', () => {
    const [left, right] = splitAroundCentre([1, 2, 3, 4]);
    expect(left).toEqual([1, 2]);
    expect(right).toEqual([3, 4]);
    expect(splitAroundCentre([1, 2, 3])).toEqual([[1, 2], [3]]);
  });
});

describe('isBottomNavItemActive', () => {
  const home = { to: '/', sections: ['/dashboard'] };
  const servers = { to: '/servers' };
  it('matches the page and its sub-pages', () => {
    expect(isBottomNavItemActive(home, '/')).toBe(true);
    expect(isBottomNavItemActive(home, '/dashboard')).toBe(true);
    expect(isBottomNavItemActive(home, '/servers')).toBe(false);
    expect(isBottomNavItemActive(servers, '/servers')).toBe(true);
    expect(isBottomNavItemActive(servers, '/servers/abc')).toBe(true);
    expect(isBottomNavItemActive(servers, '/servers-old')).toBe(false);
  });
});

describe('bottom nav visibility', () => {
  it('is hidden on the full-screen terminal', () => {
    expect(isBottomNavHidden('/terminal')).toBe(true);
    expect(isBottomNavHidden('/terminal', { keyboardOpen: false })).toBe(true);
  });
  it('hides in the terminal workspace only while the keyboard is open', () => {
    expect(isBottomNavHidden('/terminals')).toBe(false);
    expect(isBottomNavHidden('/terminals', { keyboardOpen: true })).toBe(true);
    // Elsewhere the keyboard doesn't matter.
    expect(isBottomNavHidden('/servers', { keyboardOpen: true })).toBe(false);
    expect(isBottomNavHidden('/')).toBe(false);
  });
  it('detects the on-screen keyboard from the viewport heights', () => {
    expect(isKeyboardOpen(844, 844)).toBe(false);
    expect(isKeyboardOpen(844, 780)).toBe(false); // browser bar, not a keyboard
    expect(isKeyboardOpen(844, 500)).toBe(true);
    expect(isKeyboardOpen(0, 0)).toBe(false);
    expect(isKeyboardOpen(844, undefined)).toBe(false);
  });
});

describe('centreSheetGroups', () => {
  const flat = (groups) => groups.flatMap((g) => g.items.map((a) => a.id));

  it('puts Quick connect first, then Create and Operate as in the desktop menu', () => {
    const groups = centreSheetGroups(admin, true);
    expect(groups.map((g) => g.key)).toEqual(['connect', 'create', 'operate']);
    expect(groups[0].items.map((a) => a.id)).toEqual(['quick-connect']);
    expect(groups[1].label).toBe('Create');
    expect(groups[2].label).toBe('Operate');
  });

  it('applies the same permission rules as the desktop Quick actions menu', () => {
    const groups = centreSheetGroups(bare, false);
    // Nothing gated by a permission, no Quick connect, no keyboard-only entries.
    expect(flat(groups)).toEqual(['command-palette']);
    expect(flat(centreSheetGroups(admin, false))).not.toContain('quick-connect');
    expect(flat(centreSheetGroups(admin, true))).toContain('new-server');
    expect(flat(centreSheetGroups(noServers, true))).not.toContain('new-server');
  });

  it('keeps the desktop order within each group and drops keyboard-only actions', () => {
    const create = QUICK_ACTIONS.filter((a) => a.group === 'Create').map((a) => a.id);
    const groups = centreSheetGroups({ permissions: ['*'] }, true, QUICK_ACTIONS);
    const sheetCreate = groups.find((g) => g.key === 'create')?.items.map((a) => a.id) || [];
    expect(create.filter((id) => sheetCreate.includes(id))).toEqual(sheetCreate);
    expect(flat(centreSheetGroups(admin, true))).not.toContain('shortcuts-help');
  });
});
