import { Link, useLocation } from 'react-router-dom';
import { Home, Menu, Search } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useBreadcrumbContext } from '@/context/BreadcrumbContext';
import { useCommandPalette } from '@/context/CommandPaletteContext';
import NotificationBell from '@/components/layout/NotificationBell';
import ThemeMenu from '@/components/layout/ThemeMenu';
import UserMenu from '@/components/layout/UserMenu';
import QuickConnectButton from '@/components/quickConnect/QuickConnectButton';
import QuickActionsMenu from '@/components/command/QuickActionsMenu';
import Avatar from '@/components/ui/Avatar';
import useIsMobile from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';
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
  '/connect': 'Connect',
  '/activity': 'Activity',
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

function AccountButton({ user, className }) {
  return (
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
                className={cn(
                  'flex shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  className
                )}
              >
                <Avatar name={user?.name} email={user?.email} avatarUrl={user?.avatarUrl} size="md" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Account menu ({user?.name || 'User'})</TooltipContent>
          </Tooltip>
        )}
      />
    </TooltipProvider>
  );
}

/**
 * Top bar (desktop and tablet). Phones have no top bar: navigation, search,
 * notifications and the account live in the bottom navigation (Connect,
 * Activity, More) and the "+" sheet (docs/plans/1.5.1-mobile.md).
 */
function Topbar({ onOpenNav }) {
  const location = useLocation();
  const { user } = useAuth();
  const { openPalette } = useCommandPalette();
  const isMobile = useIsMobile();

  const pageName = pageNameFor(location.pathname);
  // Pages publish their own trail (names, never ids). Without one we fall
  // back to the section name, which is what the bar always showed.
  const { crumbs } = useBreadcrumbContext();
  const trail = crumbs.length > 0 ? crumbs : [{ label: pageName }];

  if (isMobile) return null;

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
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 md:gap-2">
          <Link
            to="/"
            aria-label="Dashboard"
            title="Dashboard"
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground md:inline-flex"
          >
            <Home className="h-4 w-4" />
          </Link>
          {trail.map((crumb, i) => {
            const last = i === trail.length - 1;
            return (
              <span key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1 md:gap-2">
                <span className="hidden text-muted-foreground/50 md:inline">/</span>
                {last || !crumb.to ? (
                  <span
                    aria-current={last ? 'page' : undefined}
                    className={
                      last
                        ? 'truncate text-base font-semibold text-foreground md:text-sm md:font-medium'
                        : 'hidden truncate text-muted-foreground md:inline'
                    }
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <Link
                    to={crumb.to}
                    className="hidden max-w-[12rem] truncate text-muted-foreground transition-colors hover:text-foreground md:inline"
                  >
                    {crumb.label}
                  </Link>
                )}
              </span>
            );
          })}
        </nav>
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
        <AccountButton user={user} className="h-9 w-9" />
      </div>
    </header>
  );
}

export default Topbar;
