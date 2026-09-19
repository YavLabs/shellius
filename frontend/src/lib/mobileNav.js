import { LayoutDashboard, SquareTerminal, Server, KeyRound, Lock, KeySquare, Terminal, Bell } from 'lucide-react';
import { canAccessRoute, QUICK_ACTIONS, isQuickActionVisible } from '@/lib/commands';

/**
 * Mobile shell logic (docs/plans/1.5.1-mobile.md §1) — pure functions so
 * they can be unit tested without rendering the layout.
 */

/** Preferred bottom-nav items, in order. */
export const BOTTOM_NAV_PREFERRED = [
  { id: 'dashboard', label: 'Home', icon: LayoutDashboard, to: '/' },
  { id: 'terminals', label: 'Terminals', icon: SquareTerminal, to: '/terminals' },
  { id: 'servers', label: 'Servers', icon: Server, to: '/servers' },
  { id: 'access-requests', label: 'Requests', icon: KeyRound, to: '/access-requests' },
];

/** Used, in order, when one of the preferred items isn't allowed. */
export const BOTTOM_NAV_FALLBACKS = [
  { id: 'my-hosts', label: 'My hosts', icon: Lock, to: '/my-hosts' },
  { id: 'keystore', label: 'Keystore', icon: KeySquare, to: '/keystore' },
  { id: 'sessions', label: 'Sessions', icon: Terminal, to: '/sessions' },
  { id: 'notifications', label: 'Alerts', icon: Bell, to: '/notifications' },
];

export const BOTTOM_NAV_SLOTS = 4;

/**
 * The four items shown in the bottom navigation for `user`: the first four
 * pages they can open, preferred items first (in their order), then the
 * fallbacks. Visibility is always canAccessRoute (ROUTE_ACCESS).
 */
export function bottomNavItems(user) {
  return [...BOTTOM_NAV_PREFERRED, ...BOTTOM_NAV_FALLBACKS]
    .filter((item) => canAccessRoute(user, item.to))
    .slice(0, BOTTOM_NAV_SLOTS);
}

/** Split the items around the centre button: [left, right]. */
export function splitAroundCentre(items) {
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}

/** Is `item` the current page? "/" is also active on "/dashboard". */
export function isBottomNavItemActive(item, pathname) {
  const path = String(pathname || '/');
  if (item.to === '/') return path === '/' || path === '/dashboard';
  return path === item.to || path.startsWith(`${item.to}/`);
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
