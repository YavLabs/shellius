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
} from 'lucide-react';
import { roleAtLeast } from '@/lib/permissions';

/**
 * Single source of truth for "Quick actions" — used by both the Topbar
 * Quick Actions dropdown (components/layout/Topbar.jsx) and the command
 * palette (components/command/CommandPalette.jsx).
 *
 * `minRole` gates visibility via roleAtLeast(user, minRole). Two items
 * (`quick-connect`, `command-palette`) are gated separately: Quick Connect
 * by the org's `quickConnect` setting (fetched once in QuickConnectContext),
 * Command palette is always visible to any authenticated user.
 */
export const QUICK_ACTIONS = [
  {
    id: 'new-customer',
    label: 'New customer',
    group: 'Create',
    icon: Building2,
    minRole: 'manager',
    href: '/customers?action=new',
    shortcutHint: 'c c',
  },
  {
    id: 'new-server',
    label: 'New server',
    group: 'Create',
    icon: Server,
    minRole: 'manager',
    href: '/servers?action=new',
    shortcutHint: 'c s',
  },
  {
    id: 'new-identity',
    label: 'New identity',
    group: 'Create',
    icon: UserPlus,
    minRole: 'admin',
    href: '/keystore?tab=identities&action=new',
    shortcutHint: 'c i',
  },
  {
    id: 'generate-ssh-key',
    label: 'Generate SSH key',
    group: 'Create',
    icon: KeySquare,
    minRole: 'admin',
    href: '/keystore?tab=keys&action=generate',
    shortcutHint: 'c k',
  },
  {
    id: 'import-ssh-key',
    label: 'Import SSH key',
    group: 'Create',
    icon: Upload,
    minRole: 'admin',
    href: '/keystore?tab=keys&action=import',
  },
  {
    id: 'new-policy',
    label: 'New policy',
    group: 'Create',
    icon: Shield,
    minRole: 'admin',
    href: '/policies?action=new',
    shortcutHint: 'c p',
  },
  {
    id: 'invite-user',
    label: 'Invite user',
    group: 'Create',
    icon: Users,
    minRole: 'admin',
    href: '/users?action=invite',
    shortcutHint: 'c u',
  },
  {
    id: 'new-access-request',
    label: 'New access request',
    group: 'Create',
    icon: KeyRound,
    minRole: 'member',
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
    minRole: 'admin',
    href: '/keystore?tab=deployments&action=deploy',
  },
  {
    id: 'bulk-import',
    label: 'Bulk import',
    group: 'Operate',
    icon: Upload,
    minRole: 'admin',
    href: '/bulk-import',
  },
  {
    id: 'command-palette',
    label: 'Command palette',
    group: 'Operate',
    icon: CommandIcon,
    minRole: 'member',
    action: 'command-palette',
  },
  {
    id: 'shortcuts-help',
    label: 'Keyboard shortcuts',
    group: 'Operate',
    icon: Keyboard,
    minRole: 'member',
    action: 'shortcuts-help',
    shortcutHint: '?',
  },
];

/**
 * Flat nav list mirroring Sidebar's NAV_SECTIONS role gating
 * (components/layout/Sidebar.jsx). Kept in sync manually — Sidebar owns the
 * canonical grouping/order; this is a flattened copy for search/palette use.
 */
export const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, to: '/', minRole: 'member' },
  { id: 'terminals', label: 'Terminals', icon: SquareTerminal, to: '/terminals', minRole: 'member' },
  { id: 'customers', label: 'Customers', icon: Building2, to: '/customers', minRole: 'member' },
  { id: 'servers', label: 'Servers', icon: Server, to: '/servers', minRole: 'member' },
  { id: 'access-requests', label: 'Access requests', icon: KeyRound, to: '/access-requests', minRole: 'member' },
  { id: 'policies', label: 'Policies', icon: Shield, to: '/policies', minRole: 'admin' },
  { id: 'certificates', label: 'Certificates', icon: FileKey, to: '/certificates', minRole: 'admin' },
  { id: 'keystore', label: 'Keystore', icon: KeySquare, to: '/keystore', minRole: 'manager' },
  { id: 'connections', label: 'Recent connections', icon: Cable, to: '/connections', minRole: 'member' },
  { id: 'sessions', label: 'Sessions', icon: Terminal, to: '/sessions', minRole: 'manager' },
  { id: 'audit-log', label: 'Audit log', icon: ScrollText, to: '/audit-log', minRole: 'admin' },
  { id: 'notifications', label: 'Notifications', icon: Bell, to: '/notifications', minRole: 'member' },
  { id: 'users', label: 'Users', icon: Users, to: '/users', minRole: 'admin' },
  { id: 'groups', label: 'Groups', icon: UsersRound, to: '/groups', minRole: 'admin' },
  { id: 'bulk-import', label: 'Bulk import', icon: Upload, to: '/bulk-import', minRole: 'admin' },
];

export function isQuickActionVisible(action, user, quickConnectAllowed) {
  if (action.quickConnect) return !!quickConnectAllowed;
  if (!action.minRole) return true;
  return roleAtLeast(user, action.minRole);
}

export function isNavItemVisible(item, user) {
  if (!item.minRole) return true;
  return roleAtLeast(user, item.minRole);
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
 *   minRole   optional role gate (roleAtLeast)
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
  { keys: ['g', 'k'], label: 'Go to keystore', to: '/keystore', minRole: 'manager' },
  { keys: ['g', 'p'], label: 'Go to policies', to: '/policies', minRole: 'admin' },
  { keys: ['g', 'e'], label: 'Go to certificates', to: '/certificates', minRole: 'admin' },
  { keys: ['g', 'i'], label: 'Go to sessions', to: '/sessions', minRole: 'manager' },
  { keys: ['g', 'l'], label: 'Go to audit log', to: '/audit-log', minRole: 'admin' },
  { keys: ['g', 'u'], label: 'Go to users', to: '/users', minRole: 'admin' },
  { keys: ['g', 'g'], label: 'Go to groups', to: '/groups', minRole: 'admin' },
  { keys: ['g', 'n'], label: 'Go to notifications', to: '/notifications' },
  { keys: ['g', 'q'], label: 'Open quick connect', action: 'quick-connect', quickConnect: true },
];

export const CREATE_SEQUENCES = [
  { keys: ['c', 's'], label: 'New server', to: '/servers?action=new', minRole: 'manager' },
  { keys: ['c', 'c'], label: 'New customer', to: '/customers?action=new', minRole: 'manager' },
  { keys: ['c', 'i'], label: 'New identity', to: '/keystore?tab=identities&action=new', minRole: 'admin' },
  { keys: ['c', 'k'], label: 'Generate SSH key', to: '/keystore?tab=keys&action=generate', minRole: 'admin' },
  { keys: ['c', 'u'], label: 'Invite user', to: '/users?action=invite', minRole: 'admin' },
  { keys: ['c', 'p'], label: 'New policy', to: '/policies?action=new', minRole: 'admin' },
  { keys: ['c', 'r'], label: 'New access request', to: '/access-requests?action=new', minRole: 'member' },
];

export const SEQUENCES = [...NAV_SEQUENCES, ...CREATE_SEQUENCES];

export function isSequenceVisible(seq, user, quickConnectAllowed) {
  if (seq.quickConnect) return !!quickConnectAllowed;
  if (!seq.minRole) return true;
  return roleAtLeast(user, seq.minRole);
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
