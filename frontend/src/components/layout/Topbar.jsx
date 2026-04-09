import { useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import NotificationBell from '@/components/layout/NotificationBell';
import UserMenu from '@/components/layout/UserMenu';

const routeNames = {
  '/': 'Dashboard',
  '/customers': 'Customers',
  '/servers': 'Servers',
  '/users': 'Users',
  '/groups': 'Groups',
  '/policies': 'Policies',
  '/access-requests': 'Access Requests',
  '/certificates': 'Certificates',
  '/sessions': 'Sessions',
  '/audit-log': 'Audit Log',
  '/cloud-connectors': 'Cloud Connectors',
  '/settings': 'Settings',
  '/install-cli': 'Install CLI',
};

function Topbar() {
  const location = useLocation();
  const { user } = useAuth();

  const pageName = routeNames[location.pathname] || 'Page';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Shellius</span>
        <span className="text-muted-foreground/50">/</span>
        <span className="font-medium text-foreground">{pageName}</span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* Notifications */}
        <NotificationBell />

        {/* User dropdown — Profile / Settings / Theme / Install CLI / Sign out */}
        <UserMenu
          align="right"
          verticalAlign="below"
          trigger={({ open, onClick }) => (
            <button
              type="button"
              onClick={onClick}
              aria-haspopup="menu"
              aria-expanded={open}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                {user?.name?.[0]?.toUpperCase() || 'U'}
              </div>
              <span className="hidden sm:inline">{user?.name || 'User'}</span>
              <ChevronDown className="h-3 w-3" />
            </button>
          )}
        />
      </div>
    </header>
  );
}

export default Topbar;
