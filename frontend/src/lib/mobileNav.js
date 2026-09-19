import { LayoutDashboard, Cable, Inbox } from 'lucide-react';
import { canAccessRoute, QUICK_ACTIONS, isQuickActionVisible } from '@/lib/commands';

/**
 * Mobile shell logic (docs/plans/1.5.1-mobile.md §1) — pure functions so
 * they can be unit tested without rendering the layout.
 */

/**
 * The phone bottom navigation: Home, Connect, [+], Activity, More.
 *
 *   Home      the dashboard
 *   Connect   hub for getting onto a machine — Quick connect, open terminals,
 *             servers, My hosts, recent connections (pages/ConnectHub.jsx)
 *   Activity  hub for what needs attention — reviews, your requests, live
 *             sessions, notifications (pages/ActivityHub.jsx)
 *   More      a sheet with search, the account, every other page and the
 *             theme (components/mobile/MoreSheet.jsx)
 *
 * A tab stays highlighted on the pages it leads to (`sections`), so the bar
 * always says where you are. Both hubs show only what the viewer may open.
 */
export const BOTTOM_NAV_ITEMS = [
  { id: 'dashboard', label: 'Home', icon: LayoutDashboard, to: '/', sections: ['/dashboard'] },
  {
    id: 'connect',
    label: 'Connect',
    icon: Cable,
    to: '/connect',
    sections: ['/terminals', '/servers', '/my-hosts', '/connections'],
  },
  {
    id: 'activity',
    label: 'Activity',
    icon: Inbox,
    to: '/activity',
    sections: ['/access-requests', '/notifications', '/sessions'],
  },
];

/** Every page in the bottom-nav tabs' `sections` (the More tab covers the rest). */
const TAB_PATHS = BOTTOM_NAV_ITEMS.flatMap((i) => [i.to, ...i.sections]);

const underPath = (path, base) => (base === '/' ? path === '/' : path === base || path.startsWith(`${base}/`));

/** Is `item` the current tab? */
export function isBottomNavItemActive(item, pathname) {
  const path = String(pathname || '/').split(/[?#]/)[0];
  return [item.to, ...(item.sections || [])].some((base) => underPath(path, base));
}

/** Is the current page one the More sheet leads to (profile, admin, keystore, …)? */
export function isMoreActive(pathname) {
  const path = String(pathname || '/').split(/[?#]/)[0];
  return !TAB_PATHS.some((base) => underPath(path, base));
}

/** Split the tabs around the centre button: [Home, Connect] | [Activity] (+ More). */
export function splitAroundCentre(items) {
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}

/**
 * The More sheet's page groups: NAV_SECTIONS filtered by canAccessRoute,
 * empty groups dropped.
 */
export function moreSheetSections(user, sections) {
  return sections
    .map((s) => ({ ...s, items: s.items.filter((i) => canAccessRoute(user, i.to)) }))
    .filter((s) => s.items.length > 0);
}

/** Heights (CSS px) the on-screen keyboard takes before we call it "open". */
export const KEYBOARD_THRESHOLD = 150;

/**
 * Is the on-screen keyboard open? Compares the layout viewport with the
 * visual viewport (the keyboard shrinks only the latter).
 */
export function isKeyboardOpen(layoutHeight, visualHeight) {
  if (!layoutHeight || !visualHeight) return false;
  return layoutHeight - visualHeight > KEYBOARD_THRESHOLD;
}

/**
 * Should the bottom navigation be hidden? Always on the full-screen
 * terminal (/terminal); in the terminal workspace (/terminals) only while
 * the keyboard is open, so the terminal keeps the height.
 */
export function isBottomNavHidden(pathname, { keyboardOpen = false } = {}) {
  const path = String(pathname || '/');
  if (path === '/terminal' || path.startsWith('/terminal/')) return true;
  if (keyboardOpen && (path === '/terminals' || path.startsWith('/terminals/'))) return true;
  return false;
}

/** Quick actions that make no sense without a keyboard. */
const KEYBOARD_ONLY_ACTIONS = new Set(['shortcuts-help']);

/**
 * The centre button's sheet: Quick connect first (when allowed), then the
 * desktop Quick actions menu's list, grouped the same way (Create, Operate)
 * and with the same permission rules.
 */
export function centreSheetGroups(user, quickConnectAllowed, actions = QUICK_ACTIONS) {
  const visible = actions.filter(
    (a) => !KEYBOARD_ONLY_ACTIONS.has(a.id) && isQuickActionVisible(a, user, quickConnectAllowed)
  );
  const connect = visible.filter((a) => a.quickConnect);
  const rest = visible.filter((a) => !a.quickConnect);
  const groups = [];
  if (connect.length) groups.push({ key: 'connect', label: null, items: connect });
  for (const label of ['Create', 'Operate']) {
    const items = rest.filter((a) => a.group === label);
    if (items.length) groups.push({ key: label.toLowerCase(), label, items });
  }
  return groups;
}
