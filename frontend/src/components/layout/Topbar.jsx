import { useLocation } from 'react-router-dom';
import { ChevronDown, Search } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useCommandPalette } from '@/context/CommandPaletteContext';
import NotificationBell from '@/components/layout/NotificationBell';
import UserMenu from '@/components/layout/UserMenu';
import QuickConnectButton from '@/components/quickConnect/QuickConnectButton';
import QuickActionsMenu from '@/components/command/QuickActionsMenu';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || '');
const MOD_LABEL = isMac ? '⌘' : 'Ctrl';

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
  '/keystore': 'Keystore',
};

function Topbar() {
  const location = useLocation();
  const { user } = useAuth();
  const { openPalette } = useCommandPalette();

  const pageName = routeNames[location.pathname] || 'Page';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-6">
      {/* Breadcrumb */}
      <div className="hidden items-center gap-2 text-sm sm:flex">
        <span className="text-muted-foreground">Shellius</span>
        <span className="text-muted-foreground/50">/</span>
        <span className="font-medium text-foreground">{pageName}</span>
      </div>

      {/* Global search trigger — opens the command palette */}
      <button
        type="button"
        onClick={openPalette}
        aria-label="Search servers, users, keys and more"
        className="hidden h-9 max-w-sm flex-1 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-accent md:flex"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate text-left">Search servers, users, keys…</span>
        <kbd className="inline-flex h-5 items-center gap-0.5 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          {MOD_LABEL}K
        </kbd>
      </button>
      <button
        type="button"
        onClick={openPalette}
        aria-label="Search"
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
      >
        <Search className="h-4 w-4" />
      </button>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* Quick actions */}
        <QuickActionsMenu />

        {/* Quick Connect */}
        <QuickConnectButton />

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
