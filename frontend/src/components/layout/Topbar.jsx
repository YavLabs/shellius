import { useLocation } from 'react-router-dom';
import { Menu, Search } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useCommandPalette } from '@/context/CommandPaletteContext';
import NotificationBell from '@/components/layout/NotificationBell';
import ThemeMenu from '@/components/layout/ThemeMenu';
import UserMenu from '@/components/layout/UserMenu';
import QuickConnectButton from '@/components/quickConnect/QuickConnectButton';
import QuickActionsMenu from '@/components/command/QuickActionsMenu';
import Avatar from '@/components/ui/Avatar';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || '');
const MOD_LABEL = isMac ? '⌘' : 'Ctrl';

const routeNames = {
  '/': 'Dashboard',
  '/customers': 'Customers',
  '/servers': 'Servers',
  '/policies': 'Policies',
  '/access-requests': 'Access Requests',
  '/certificates': 'Certificates',
  '/sessions': 'Sessions',
  '/audit-log': 'Audit Log',
  '/cloud-connectors': 'Cloud Connectors',
  '/admin': 'Administration',
  '/install-cli': 'Install CLI',
  '/keystore': 'Keystore',
  '/terminals': 'Terminals',
  '/connections': 'Recent connections',
  '/dashboard': 'Dashboard',
  '/profile': 'Profile',
  '/notifications': 'Notifications',
  '/bulk-import': 'Bulk Import',
};

// Exact match first, then the top-level section (e.g. /servers/:id → Servers).
function pageNameFor(pathname) {
  if (routeNames[pathname]) return routeNames[pathname];
  const section = `/${pathname.split('/')[1] || ''}`;
  return routeNames[section] || 'Shellius';
}

/**
 * Top bar. Phones (below md) get a single 56px row: menu button (opens the
 * navigation drawer), page title, search, notifications, avatar — Quick
 * actions, Quick connect and the theme menu move to the bottom navigation's
 * centre button, the drawer and the account menu (docs/plans/1.5.1-mobile.md).
 */
function Topbar({ onOpenNav }) {
  const location = useLocation();
  const { user } = useAuth();
  const { openPalette } = useCommandPalette();

  const pageName = pageNameFor(location.pathname);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-1 border-b border-border bg-card pl-1 pr-1 md:gap-3 md:pl-6 md:pr-4">
      {/* Breadcrumb (phones: menu button + page title) */}
      <div className="flex min-w-0 items-center gap-1 text-sm md:gap-2">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="Open navigation"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="hidden text-muted-foreground md:inline">Shellius</span>
        <span className="hidden text-muted-foreground/50 md:inline">/</span>
        <span className="truncate text-base font-semibold text-foreground md:text-sm md:font-medium">{pageName}</span>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center md:gap-2">
        {/* Global search trigger — opens the command palette. */}
        <button
          type="button"
          onClick={openPalette}
          aria-label="Search servers, users, keys and more"
          className="hidden h-9 w-64 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-accent md:flex lg:w-72"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate text-left">Search…</span>
          <kbd className="inline-flex h-5 items-center gap-0.5 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            {MOD_LABEL}K
          </kbd>
        </button>
        <button
          type="button"
          onClick={openPalette}
          aria-label="Search"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
        >
          <Search className="h-[18px] w-[18px]" />
        </button>

        <div aria-hidden="true" className="mx-1 hidden h-6 w-px shrink-0 bg-border md:block" />

        {/* Quick actions (secondary) and Quick Connect (primary). Phones:
            both live in the bottom navigation's centre sheet. The Quick
            Connect button stays mounted (display: none) for its g q shortcut. */}
        <div className="hidden md:contents">
          <QuickActionsMenu />
        </div>
        <div className="hidden md:contents">
          <QuickConnectButton />
        </div>

        <div aria-hidden="true" className="mx-1 hidden h-6 w-px shrink-0 bg-border md:block" />

        {/* Theme (phones: in the menu drawer and the account menu) */}
        <div className="hidden md:contents">
          <ThemeMenu />
        </div>

        {/* Notifications */}
        <NotificationBell />

        <div aria-hidden="true" className="mx-1 hidden h-6 w-px shrink-0 bg-border md:block" />

        {/* User dropdown — avatar only trigger. Profile / Administration / Bulk
            import / Install CLI / Keyboard shortcuts / Sign out live inside. */}
        <TooltipProvider delayDuration={300}>
          <UserMenu
            align="right"
            verticalAlign="below"
            trigger={({ open, onClick }) => (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onClick}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-label={`Account menu (${user?.name || 'User'})`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none md:h-9 md:w-9 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <Avatar name={user?.name} email={user?.email} avatarUrl={user?.avatarUrl} size="md" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Account menu ({user?.name || 'User'})</TooltipContent>
              </Tooltip>
            )}
          />
        </TooltipProvider>
      </div>
    </header>
  );
}

export default Topbar;
