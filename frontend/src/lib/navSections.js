import { Bell, Building2, FileKey, KeyRound, KeySquare, LayoutDashboard, Lock, ScrollText, Server, Shield, SquareTerminal, Terminal } from 'lucide-react';

/**
 * The app's grouped navigation — the desktop sidebar and the phone "More"
 * sheet both render it. Visibility is canAccessRoute (ROUTE_ACCESS).
 */
export const NAV_SECTIONS = [
  {
    label: 'Overview',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, to: '/' },
      { id: 'terminals', label: 'Terminals', icon: SquareTerminal, to: '/terminals' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { id: 'customers', label: 'Customers', icon: Building2, to: '/customers' },
      { id: 'servers', label: 'Servers', icon: Server, to: '/servers' },
      { id: 'my-hosts', label: 'My hosts', icon: Lock, to: '/my-hosts' },
    ],
  },
  {
    label: 'Access',
    items: [
      { id: 'access-requests', label: 'Access requests', icon: KeyRound, to: '/access-requests' },
      { id: 'policies', label: 'Policies', icon: Shield, to: '/policies' },
      {
        id: 'certificates',
        label: 'Certificates',
        icon: FileKey,
        to: '/certificates',
      },
      {
        id: 'keystore',
        label: 'Keystore',
        icon: KeySquare,
        to: '/keystore',
      },
    ],
  },
  {
    label: 'Audit',
    items: [
      { id: 'sessions', label: 'Sessions', icon: Terminal, to: '/sessions' },
      { id: 'audit-log', label: 'Audit log', icon: ScrollText, to: '/audit-log' },
      { id: 'notifications', label: 'Notifications', icon: Bell, to: '/notifications' },
    ],
  },
];
