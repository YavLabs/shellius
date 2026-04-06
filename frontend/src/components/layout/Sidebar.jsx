import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Building2,
  Server,
  Users,
  UsersRound,
  Shield,
  KeyRound,
  FileKey,
  Terminal,
  ScrollText,
  Cloud,
  Settings,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useNotifications } from '@/context/NotificationContext';
import { cn } from '@/lib/utils';

const navItems = [
  { label: 'Dashboard', icon: LayoutDashboard, path: '/' },
  { label: 'Customers', icon: Building2, path: '/customers' },
  { label: 'Servers', icon: Server, path: '/servers' },
  { label: 'Users', icon: Users, path: '/users' },
  { label: 'Groups', icon: UsersRound, path: '/groups' },
  { label: 'Policies', icon: Shield, path: '/policies', minRole: 'admin' },
  { label: 'Access Requests', icon: KeyRound, path: '/access-requests' },
  { label: 'Certificates', icon: FileKey, path: '/certificates', minRole: 'admin' },
  { label: 'Sessions', icon: Terminal, path: '/sessions', minRole: 'operator' },
  { label: 'Audit Log', icon: ScrollText, path: '/audit-log' },
  { label: 'Cloud Connectors', icon: Cloud, path: '/cloud-connectors' },
  { label: 'Settings', icon: Settings, path: '/settings' },
];

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const { user } = useAuth();
  const { unreadCount } = useNotifications();
  const location = useLocation();

  return (
    <aside
      className={cn(
        'flex h-screen flex-col border-r border-border bg-card transition-all duration-200',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-border px-4">
        <Terminal className="h-5 w-5 shrink-0 text-foreground" />
        {!collapsed && (
          <span className="ml-2 text-sm font-semibold tracking-tight text-foreground">
            Shellius
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="space-y-0.5">
          {navItems.filter((item) => !item.minRole || isAtLeast(user, item.minRole)).map((item) => {
            const Icon = item.icon;
            const isActive =
              item.path === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(item.path);

            return (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  )}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && (
                    <span className="flex flex-1 items-center justify-between">
                      {item.label}
                      {item.path === '/access-requests' && unreadCount > 0 && (
                        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1 text-xs font-semibold text-amber-600 dark:text-amber-400">
                          {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                      )}
                    </span>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User + Collapse */}
      <div className="border-t border-border p-3">
        {!collapsed && user && (
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
              {user.name?.[0]?.toUpperCase() || 'U'}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user.role}</p>
            </div>
          </div>
        )}
        <button
          onClick={() => setCollapsed((prev) => !prev)}
          className="flex w-full items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <PanelLeft className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>
    </aside>
  );
}

export default Sidebar;
