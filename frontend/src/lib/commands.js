import { Cable,
  LayoutDashboard,
  Building2,
  Server,
  Users,
  UsersRound,
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
  ShieldCheck,
} from 'lucide-react';
import { can, canAny } from '@/lib/permissions';

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
    href: '/policies?action=new',
    shortcutHint: 'c p',
  },
  {
    id: 'invite-user',
    label: 'Invite user',
    group: 'Create',
    icon: Users,
    perm: 'users.invite',
    href: '/users?action=invite',
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
  '/policies': { anyOf: ['policies.view'] },
  '/certificates': { anyOf: ['certificates.view_all'] },
  '/keystore': { anyOf: ['keystore.view'] },
  '/sessions': { anyOf: ['sessions.view_all'] },
  '/audit-log': { anyOf: ['audit.view'] },
  '/users': { anyOf: ['users.view'] },
  '/groups': { anyOf: ['groups.view'] },
  '/roles': { anyOf: ['roles.view'] },
  '/bulk-import': { anyOf: ['import.run'] },
  '/settings': {
    anyOf: [
      'org.update',
      'org.access_settings',
      'ca.view',
      'settings.sso',
      'settings.mfa',
      'settings.smtp',
      'settings.storage',
      'quick_connect.settings',
    ],
  },
};

/** Can `user` open the page at `path` (first path segment decides)? */
export function canAccessRoute(user, path) {
  const base = '/' + String(path || '/').split(/[/?#]/)[1];
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
  { id: 'policies', label: 'Policies', icon: Shield, to: '/policies' },
  { id: 'certificates', label: 'Certificates', icon: FileKey, to: '/certificates' },
  { id: 'keystore', label: 'Keystore', icon: KeySquare, to: '/keystore' },
  { id: 'connections', label: 'Recent connections', icon: Cable, to: '/connections' },
  { id: 'sessions', label: 'Sessions', icon: Terminal, to: '/sessions' },
  { id: 'audit-log', label: 'Audit log', icon: ScrollText, to: '/audit-log' },
  { id: 'notifications', label: 'Notifications', icon: Bell, to: '/notifications' },
  { id: 'users', label: 'Users', icon: Users, to: '/users' },
  { id: 'roles', label: 'Roles', icon: ShieldCheck, to: '/roles' },
  { id: 'groups', label: 'Groups', icon: UsersRound, to: '/groups' },
  { id: 'bulk-import', label: 'Bulk import', icon: Upload, to: '/bulk-import' },
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
  { keys: ['g', 'p'], label: 'Go to policies', to: '/policies' },
  { keys: ['g', 'e'], label: 'Go to certificates', to: '/certificates' },
  { keys: ['g', 'i'], label: 'Go to sessions', to: '/sessions' },
  { keys: ['g', 'l'], label: 'Go to audit log', to: '/audit-log' },
  { keys: ['g', 'u'], label: 'Go to users', to: '/users' },
  { keys: ['g', 'g'], label: 'Go to groups', to: '/groups' },
  { keys: ['g', 'n'], label: 'Go to notifications', to: '/notifications' },
  { keys: ['g', 'q'], label: 'Open quick connect', action: 'quick-connect', quickConnect: true },
];

export const CREATE_SEQUENCES = [
  { keys: ['c', 's'], label: 'New server', to: '/servers?action=new', perm: 'servers.create' },
  { keys: ['c', 'c'], label: 'New customer', to: '/customers?action=new', perm: 'customers.create' },
  { keys: ['c', 'i'], label: 'New identity', to: '/keystore?tab=identities&action=new', perm: 'keystore.manage' },
  { keys: ['c', 'k'], label: 'Generate SSH key', to: '/keystore?tab=keys&action=generate', perm: 'keystore.manage' },
  { keys: ['c', 'u'], label: 'Invite user', to: '/users?action=invite', perm: 'users.invite' },
  { keys: ['c', 'p'], label: 'New policy', to: '/policies?action=new', perm: 'policies.manage' },
  { keys: ['c', 'r'], label: 'New access request', to: '/access-requests?action=new', perm: 'access.request' },
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
