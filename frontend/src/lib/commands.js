import {
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
  ScrollText,
  Bell,
  Upload,
  UserPlus,
  Send,
  Zap,
  Command as CommandIcon,
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
  },
  {
    id: 'new-server',
    label: 'New server',
    group: 'Create',
    icon: Server,
    minRole: 'manager',
    href: '/servers?action=new',
  },
  {
    id: 'new-identity',
    label: 'New identity',
    group: 'Create',
    icon: UserPlus,
    minRole: 'admin',
    href: '/keystore?tab=identities&action=new',
  },
  {
    id: 'generate-ssh-key',
    label: 'Generate SSH key',
    group: 'Create',
    icon: KeySquare,
    minRole: 'admin',
    href: '/keystore?tab=keys&action=generate',
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
  },
  {
    id: 'invite-user',
    label: 'Invite user',
    group: 'Create',
    icon: Users,
    minRole: 'admin',
    href: '/users?action=invite',
  },
  {
    id: 'new-access-request',
    label: 'New access request',
    group: 'Create',
    icon: KeyRound,
    minRole: 'member',
    href: '/access-requests?action=new',
  },
  {
    id: 'quick-connect',
    label: 'Quick Connect',
    group: 'Operate',
    icon: Zap,
    quickConnect: true,
    action: 'quick-connect',
    shortcutHint: 'g q',
  },
  {
    id: 'deploy-ssh-key',
    label: 'Deploy SSH key',
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
];

/**
 * Flat nav list mirroring Sidebar's NAV_SECTIONS role gating
 * (components/layout/Sidebar.jsx). Kept in sync manually — Sidebar owns the
 * canonical grouping/order; this is a flattened copy for search/palette use.
 */
export const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, to: '/', minRole: 'member' },
  { id: 'customers', label: 'Customers', icon: Building2, to: '/customers', minRole: 'member' },
  { id: 'servers', label: 'Servers', icon: Server, to: '/servers', minRole: 'member' },
  { id: 'access-requests', label: 'Access Requests', icon: KeyRound, to: '/access-requests', minRole: 'member' },
  { id: 'policies', label: 'Policies', icon: Shield, to: '/policies', minRole: 'admin' },
  { id: 'certificates', label: 'Certificates', icon: FileKey, to: '/certificates', minRole: 'admin' },
  { id: 'keystore', label: 'Keystore', icon: KeySquare, to: '/keystore', minRole: 'manager' },
  { id: 'sessions', label: 'Sessions', icon: Terminal, to: '/sessions', minRole: 'manager' },
  { id: 'audit-log', label: 'Audit Log', icon: ScrollText, to: '/audit-log', minRole: 'admin' },
  { id: 'notifications', label: 'Notifications', icon: Bell, to: '/notifications', minRole: 'member' },
  { id: 'users', label: 'Users', icon: Users, to: '/users', minRole: 'admin' },
  { id: 'groups', label: 'Groups', icon: UsersRound, to: '/groups', minRole: 'admin' },
  { id: 'bulk-import', label: 'Bulk Import', icon: Upload, to: '/bulk-import', minRole: 'admin' },
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
