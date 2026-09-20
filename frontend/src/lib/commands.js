import { Cable,
  Inbox,
  LayoutDashboard,
  Building2,
  Server,
  Users,
  Shield,
  KeyRound,
  FileKey,
  KeySquare,
  Terminal,
  SquareTerminal,
  ScrollText,
  Bell,
  Upload,
  UserPlus,
  Send,
  Zap,
  Command as CommandIcon,
  Keyboard,
  Lock,
  Radar,
} from 'lucide-react';
import { can, canAny } from '@/lib/permissions';
import { ADMIN_PERMISSIONS, ADMIN_SECTIONS, canSeeSection, sectionKeyFromPath, sectionPath } from '@/lib/adminSections';

/**
 * Single source of truth for "Quick actions" — used by both the Topbar
 * Quick Actions dropdown (components/layout/Topbar.jsx) and the command
 * palette (components/command/CommandPalette.jsx).
 *
 * `perm` gates visibility via can(user, perm) (a permission key from the
 * user's role). Quick Connect is gated by QuickConnectContext's `allowed`
 * (org switch + quick_connect.use); palette / shortcuts are for everyone.
 */
export const QUICK_ACTIONS = [
  {
    id: 'new-customer',
    label: 'New customer',
    group: 'Create',
    icon: Building2,
    perm: 'customers.create',
    href: '/customers?action=new',
    shortcutHint: 'c c',
  },
  {
    id: 'new-server',
    label: 'New server',
    group: 'Create',
    icon: Server,
    perm: 'servers.create',
    href: '/servers?action=new',
    shortcutHint: 'c s',
  },
  {
    id: 'new-identity',
    label: 'New identity',
    group: 'Create',
    icon: UserPlus,
    perm: 'keystore.manage',
    href: '/keystore?tab=identities&action=new',
    shortcutHint: 'c i',
  },
  {
    id: 'generate-ssh-key',
    label: 'Generate SSH key',
    group: 'Create',
    icon: KeySquare,
    perm: 'keystore.manage',
    href: '/keystore?tab=keys&action=generate',
    shortcutHint: 'c k',
  },
  {
    id: 'import-ssh-key',
    label: 'Import SSH key',
    group: 'Create',
    icon: Upload,
    perm: 'keystore.manage',
    href: '/keystore?tab=keys&action=import',
  },
  {
    id: 'new-policy',
    label: 'New policy',
    group: 'Create',
    icon: Shield,
    perm: 'policies.manage',
    href: '/admin/policies?action=new',
    shortcutHint: 'c p',
  },
  {
    id: 'invite-user',
    label: 'Invite user',
    group: 'Create',
    icon: Users,
    perm: 'users.invite',
    href: '/admin/users?action=invite',
    shortcutHint: 'c u',
  },
  {
    id: 'new-access-request',
    label: 'New access request',
    group: 'Create',
    icon: KeyRound,
    perm: 'access.request',
    href: '/access-requests?action=new',
    shortcutHint: 'c r',
  },
  {
    id: 'quick-connect',
    label: 'Quick connect',
    group: 'Operate',
    icon: Zap,
    quickConnect: true,
    action: 'quick-connect',
    shortcutHint: 'g q',
  },
  {
    id: 'add-my-host',
    label: 'Add host to My hosts',
    group: 'Create',
    icon: Lock,
    perm: 'vault.hosts',
    href: '/my-hosts?action=new',
  },
  {
    id: 'deploy-ssh-key',
    label: 'Export key to servers',
    group: 'Operate',
    icon: Send,
    perm: 'keystore.deploy',
    href: '/keystore?tab=deployments&action=deploy',
  },
  {
    id: 'bulk-import',
    label: 'Bulk import',
    group: 'Operate',
    icon: Upload,
    perm: 'import.run',
    href: '/bulk-import',
  },
  {
    id: 'command-palette',
    label: 'Command palette',
    group: 'Operate',
    icon: CommandIcon,
    action: 'command-palette',
  },
  {
    id: 'shortcuts-help',
    label: 'Keyboard shortcuts',
    group: 'Operate',
    icon: Keyboard,
    action: 'shortcuts-help',
    shortcutHint: '?',
  },
];

/**
 * ROUTE_ACCESS — the one table of which permission(s) a page needs. Read by
 * the router (PermissionRoute in App.jsx), the Sidebar, NAV_ITEMS below and
 * the keyboard shortcuts, so they can never disagree. `anyOf` = at least one.
 * Routes not listed are open to every signed-in user.
 */
export const ROUTE_ACCESS = {
  '/customers': { anyOf: ['customers.view'] },
  '/servers': { anyOf: ['servers.view'] },
  '/certificates': { anyOf: ['certificates.view_all'] },
  '/posture': { anyOf: ['posture.read'] },
  '/keystore': { anyOf: ['keystore.view', 'vault.use'] },
  '/my-hosts': { anyOf: ['vault.hosts'] },
  '/sessions': { anyOf: ['sessions.view_all'] },
  '/audit-log': { anyOf: ['audit.view'] },
  '/bulk-import': { anyOf: ['import.run'] },
  // Administration: any section's permission opens the page; each section
  // (/admin/<key>) is checked on its own — see lib/adminSections.js.
  '/admin': { anyOf: ADMIN_PERMISSIONS },
};

/**
 * Can `user` open the page at `path`? The first path segment decides, except
 * inside Administration, where /admin/<section> needs that section's own
 * permission.
 */
export function canAccessRoute(user, path) {
  const base = '/' + String(path || '/').split(/[/?#]/)[1];
  if (base === '/admin') {
    const key = sectionKeyFromPath(path);
    if (key) return canSeeSection(user, key);
  }
  const rule = ROUTE_ACCESS[base];
  return !rule || canAny(user, ...rule.anyOf);
}

/**
 * Flat nav list for search/palette use (Sidebar owns grouping/order).
 * Visibility comes from ROUTE_ACCESS.
 */
export const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, to: '/' },
  { id: 'terminals', label: 'Terminals', icon: SquareTerminal, to: '/terminals' },
  { id: 'customers', label: 'Customers', icon: Building2, to: '/customers' },
  { id: 'servers', label: 'Servers', icon: Server, to: '/servers' },
  { id: 'access-requests', label: 'Access requests', icon: KeyRound, to: '/access-requests' },
  { id: 'policies', label: 'Policies', icon: Shield, to: '/admin/policies' },
  { id: 'certificates', label: 'Certificates', icon: FileKey, to: '/certificates' },
  { id: 'posture', label: 'Posture', icon: Radar, to: '/posture' },
  { id: 'keystore', label: 'Keystore', icon: KeySquare, to: '/keystore' },
  { id: 'my-hosts', label: 'My hosts', icon: Lock, to: '/my-hosts' },
  { id: 'connections', label: 'Recent connections', icon: Cable, to: '/connections' },
  { id: 'connect', label: 'Connect', icon: Cable, to: '/connect' },
  { id: 'activity', label: 'Activity', icon: Inbox, to: '/activity' },
  { id: 'sessions', label: 'Sessions', icon: Terminal, to: '/sessions' },
  { id: 'audit-log', label: 'Audit log', icon: ScrollText, to: '/audit-log' },
  { id: 'notifications', label: 'Notifications', icon: Bell, to: '/notifications' },
  { id: 'bulk-import', label: 'Bulk import', icon: Upload, to: '/bulk-import' },
  // One entry per Administration section ("Administration › Users", …),
  // each visible only with that section's permission.
  ...ADMIN_SECTIONS.map((s) => ({
    id: `admin-${s.key}`,
    label: `Administration › ${s.label}`,
    icon: s.icon,
    to: sectionPath(s.key),
    keywords: ['administration', 'admin', 'settings', ...(s.keywords || [])],
  })),
];

export function isQuickActionVisible(action, user, quickConnectAllowed) {
  if (action.quickConnect) return !!quickConnectAllowed;
  if (!action.perm) return true;
  return can(user, action.perm);
}

export function isNavItemVisible(item, user) {
  return canAccessRoute(user, item.to);
}

export function matchesQuery(label, query) {
  if (!query) return true;
  return label.toLowerCase().includes(query.trim().toLowerCase());
}

/** Palette match for a NAV_ITEMS entry: its label or any of its keywords. */
export function matchesNavItem(item, query) {
  if (!query || matchesQuery(item.label, query)) return true;
  return (item.keywords || []).some((k) => matchesQuery(k, query));
}

/**
 * SEQUENCES — single source of truth for every "press key, then key" chord
 * (hooks/useKeyboardShortcuts.js is generic and just walks this list; it
 * knows nothing about routes or Quick Actions itself). Each entry:
 *
 *   keys      [firstKey, secondKey] — both lowercase, no modifiers
 *   label     human label (shown in the Quick Actions menu / palette / help)
 *   perm      optional permission gate (defaults to the route's ROUTE_ACCESS)
 *   quickConnect  true if gated by the org's Quick Connect setting instead
 *   to        route to navigate to
 *   action    'quick-connect' | 'command-palette' | 'shortcuts-help' — handled
 *             by the caller instead of navigating
 */
export const NAV_SEQUENCES = [
  { keys: ['g', 'd'], label: 'Go to dashboard', to: '/dashboard' },
  { keys: ['g', 't'], label: 'Go to terminals', to: '/terminals' },
  { keys: ['g', 's'], label: 'Go to servers', to: '/servers' },
  { keys: ['g', 'c'], label: 'Go to customers', to: '/customers' },
  { keys: ['g', 'a'], label: 'Go to access requests', to: '/access-requests' },
  { keys: ['g', 'k'], label: 'Go to keystore', to: '/keystore' },
  { keys: ['g', 'h'], label: 'Go to my hosts', to: '/my-hosts' },
  { keys: ['g', 'p'], label: 'Go to policies', to: '/admin/policies' },
  { keys: ['g', 'e'], label: 'Go to certificates', to: '/certificates' },
  { keys: ['g', 'i'], label: 'Go to sessions', to: '/sessions' },
  { keys: ['g', 'l'], label: 'Go to audit log', to: '/audit-log' },
  { keys: ['g', 'u'], label: 'Go to users', to: '/admin/users' },
  { keys: ['g', 'g'], label: 'Go to groups', to: '/admin/groups' },
  { keys: ['g', 'n'], label: 'Go to notifications', to: '/notifications' },
  { keys: ['g', 'q'], label: 'Open quick connect', action: 'quick-connect', quickConnect: true },
];

export const CREATE_SEQUENCES = [
  { keys: ['c', 's'], label: 'New server', to: '/servers?action=new', perm: 'servers.create' },
  { keys: ['c', 'c'], label: 'New customer', to: '/customers?action=new', perm: 'customers.create' },
  { keys: ['c', 'i'], label: 'New identity', to: '/keystore?tab=identities&action=new', perm: 'keystore.manage' },
  { keys: ['c', 'k'], label: 'Generate SSH key', to: '/keystore?tab=keys&action=generate', perm: 'keystore.manage' },
  { keys: ['c', 'u'], label: 'Invite user', to: '/admin/users?action=invite', perm: 'users.invite' },
  { keys: ['c', 'p'], label: 'New policy', to: '/admin/policies?action=new', perm: 'policies.manage' },
  { keys: ['c', 'r'], label: 'New access request', to: '/access-requests?action=new', perm: 'access.request' },
  { keys: ['c', 'h'], label: 'Add host to My hosts', to: '/my-hosts?action=new', perm: 'vault.hosts' },
];

export const SEQUENCES = [...NAV_SEQUENCES, ...CREATE_SEQUENCES];

export function isSequenceVisible(seq, user, quickConnectAllowed) {
  if (seq.quickConnect) return !!quickConnectAllowed;
  if (seq.perm) return can(user, seq.perm);
  return seq.to ? canAccessRoute(user, seq.to) : true;
}

export function sequenceLabel(keys) {
  return keys.join(' then ');
}

/**
 * GENERAL_SHORTCUTS — single-key / modifier shortcuts not part of a 2-key
 * sequence, shown in the Keyboard Shortcuts help dialog.
 */
export const GENERAL_SHORTCUTS = [
  { keys: ['Mod', 'K'], label: 'Open command palette' },
  { keys: ['/'], label: 'Open command palette' },
  { keys: ['?'], label: 'Show keyboard shortcuts' },
];
