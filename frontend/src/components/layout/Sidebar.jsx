import { useState, useEffect, useCallback } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
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
  SquareTerminal,
  ScrollText,
  Bell,
  Cloud,
  ChevronUp,
  PanelLeft,
  PanelLeftClose,
  Menu,
  X,
  ShieldCheck,
  Lock,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useNotifications } from '@/context/NotificationContext';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { cn } from '@/lib/utils';
import { canAccessRoute } from '@/lib/commands';
import BrandLogo, { BrandMark } from '@/components/common/BrandLogo';
import UserMenu from '@/components/layout/UserMenu';
import Avatar from '@/components/ui/Avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import usePendingReviewCount from '@/hooks/usePendingReviewCount';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLAPSED_KEY = 'shellius_sidebar_collapsed';
const EXPANDED_WIDTH = 'w-60';
const COLLAPSED_WIDTH = 'w-14';


// ---------------------------------------------------------------------------
// Grouped navigation config
// ---------------------------------------------------------------------------

const NAV_SECTIONS = [
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
  {
    label: 'Administration',
    items: [
      { id: 'users', label: 'Users', icon: Users, to: '/users' },
      { id: 'roles', label: 'Roles', icon: ShieldCheck, to: '/roles' },
      { id: 'groups', label: 'Groups', icon: UsersRound, to: '/groups' },
    ],
  },
];

// Phase 19: Profile + Settings moved into the shared UserMenu dropdown that
// opens from both the topbar avatar AND the sidebar user section. The
// sidebar no longer renders them as standalone nav items.

// ---------------------------------------------------------------------------
// SectionHeader
// ---------------------------------------------------------------------------

function SectionHeader({ label, collapsed }) {
  // Phase 18B: in collapsed mode, show a horizontal divider so the visual
  // grouping survives even though the text label is hidden.
  if (collapsed) {
    return (
      <div className="mx-2 my-2 h-px bg-border/60" aria-hidden="true" />
    );
  }
  return (
    <p className="mt-6 mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 select-none">
      {label}
    </p>
  );
}

// ---------------------------------------------------------------------------
// NavItem
// ---------------------------------------------------------------------------

function NavItem({ to, icon: Icon, label, badge, collapsed, exact = false, onNavigate }) {
  const item = (
    <NavLink
      to={to}
      end={exact}
      onClick={onNavigate}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          'group flex items-center py-1.5 text-sm transition-colors duration-150',
          // Phase 18B: in collapsed mode strip gap-3 (no label to space against)
          // and force-center the icon in the rail.
          collapsed
            ? 'mx-auto h-9 w-9 justify-center rounded-md'
            : 'gap-3 rounded-md px-3',
          isActive
            ? 'bg-accent/60 text-primary font-medium'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              'shrink-0 transition-colors duration-150',
              isActive
                ? 'text-primary'
                : 'text-muted-foreground group-hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          {!collapsed && (
            <span className="flex flex-1 items-center justify-between truncate">
              <span className="truncate">{label}</span>
              {badge ? badge : null}
            </span>
          )}
        </>
      )}
    </NavLink>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{item}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return item;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function SidebarBody({ collapsed, onToggle, onNavigate }) {
  const { user } = useAuth();
  const { unreadCount } = useNotifications();
  const { liveCount } = useTerminalWorkspace();
  // Requests waiting for this user's review, the same number as the page's
  // "Pending reviews" tab. (This used to show the unread notification count,
  // which matched nothing on the Access requests page.)
  const pendingReviews = usePendingReviewCount(unreadCount);

  // Visibility comes from ROUTE_ACCESS (lib/commands.js), same as the router.
  const canSee = (item) => canAccessRoute(user, item.to);

  const renderItem = (item) => {
    if (!canSee(item)) return null;
    let badge = null;
    if (item.id === 'access-requests' && pendingReviews > 0 && !collapsed) {
      badge = (
        <span
          className="ml-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
          title={`${pendingReviews} pending review${pendingReviews === 1 ? '' : 's'}`}
        >
          {pendingReviews > 9 ? '9+' : pendingReviews}
        </span>
      );
    }
    if (item.id === 'terminals' && liveCount > 0 && !collapsed) {
      badge = (
        <span className="ml-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500/20 px-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
          {liveCount > 9 ? '9+' : liveCount}
        </span>
      );
    }
    return (
      <NavItem
        key={item.id}
        to={item.to}
        icon={item.icon}
        label={item.label}
        badge={badge}
        collapsed={collapsed}
        exact={item.to === '/'}
        onNavigate={onNavigate}
      />
    );
  };

  return (
    <div
      className={cn(
        'flex h-full flex-col border-r border-border bg-card transition-all duration-200',
        collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH
      )}
    >
      {/* Logo + collapse toggle */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center border-b border-border px-3',
          collapsed ? 'justify-center' : 'justify-between'
        )}
      >
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggle}
                className="hover:opacity-90 transition-opacity"
                aria-label="Expand sidebar"
              >
                <BrandMark size="md" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Expand</TooltipContent>
          </Tooltip>
        ) : (
          <>
            <Link to="/">
              <BrandLogo size="sm" nudge />
            </Link>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onToggle}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
                  aria-label="Collapse sidebar"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Collapse</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      {/* Sections */}
      <nav
        aria-label="Main navigation"
        className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5"
      >
        {NAV_SECTIONS.map((section, idx) => {
          const visible = section.items.filter(canSee);
          if (visible.length === 0) return null;
          return (
            <div key={section.label}>
              {idx > 0 && <SectionHeader label={section.label} collapsed={collapsed} />}
              {idx === 0 && !collapsed && (
                <p className="mt-3 mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 select-none">
                  {section.label}
                </p>
              )}
              {visible.map(renderItem)}
            </div>
          );
        })}
      </nav>

      {/* Bottom: user — clickable, opens the same UserMenu dropdown the
          topbar avatar uses. Profile / Settings / Bulk import / Install CLI /
          Keyboard shortcuts / Sign out all live in the shared menu now.
          Theme selection lives in the topbar's standalone ThemeMenu. */}
      <div className="shrink-0 border-t border-border px-2 py-3">
        {user && (
          <UserMenu
            align="left"
            verticalAlign="above"
            trigger={({ open, onClick }) =>
              collapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onClick}
                      aria-haspopup="menu"
                      aria-expanded={open}
                      className="mx-auto flex items-center justify-center rounded-full hover:opacity-90 transition-opacity"
                    >
                      <Avatar name={user.name} email={user.email} src={user.avatarUrl} size="md" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <span className="font-medium">{user.name}</span>
                    {user.email && <span className="text-muted-foreground"> · {user.email}</span>}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <button
                  type="button"
                  onClick={onClick}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-accent transition-colors"
                >
                  <Avatar name={user.name} email={user.email} src={user.avatarUrl} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{user.name}</p>
                    <p className="truncate text-[10px] text-muted-foreground">{user.email}</p>
                  </div>
                  <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )
            }
          />
        )}
      </div>
    </div>
  );
}

// Pages that want the full width: the sidebar collapses automatically when
// you arrive. You can still expand it there (until you leave the page), and
// your saved preference for every other page is left untouched.
const AUTO_COLLAPSE_ROUTES = ['/terminals', '/admin'];
const isAutoCollapseRoute = (path) => AUTO_COLLAPSE_ROUTES.some((r) => path === r || path.startsWith(`${r}/`));

function Sidebar() {
  // Saved preference (persisted) — applies everywhere except the routes above.
  const [savedCollapsed, setSavedCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  // On an auto-collapse route: null = collapsed by default; true/false once
  // the user toggles it there. Reset each time they arrive from elsewhere.
  const [routeOverride, setRouteOverride] = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const onAutoCollapseRoute = isAutoCollapseRoute(location.pathname);
  const collapsed = onAutoCollapseRoute ? routeOverride ?? true : savedCollapsed;

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Arriving on (or leaving) an auto-collapse route starts fresh; moving
  // between its own sub-pages (e.g. Administration tabs) keeps the choice.
  useEffect(() => {
    setRouteOverride(null);
  }, [onAutoCollapseRoute]);

  const toggleCollapsed = useCallback(() => {
    if (onAutoCollapseRoute) {
      setRouteOverride(!collapsed);
      return;
    }
    setSavedCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [onAutoCollapseRoute, collapsed]);

  return (
    <TooltipProvider delayDuration={200}>
      {/* Mobile hamburger */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-4 z-40 flex items-center justify-center rounded-md border border-border bg-card p-2 text-muted-foreground shadow-sm md:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col transition-transform duration-200 md:hidden',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
        aria-label="Navigation"
      >
        <div className="relative">
          <button
            onClick={() => setMobileOpen(false)}
            className="absolute right-2 top-3 z-10 rounded-md p-1 text-muted-foreground hover:bg-accent transition-colors md:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <SidebarBody
          collapsed={false}
          onToggle={() => {}}
          onNavigate={() => setMobileOpen(false)}
        />
      </aside>

      {/* Desktop */}
      <aside className="hidden h-screen md:flex md:shrink-0" aria-label="Navigation">
        <SidebarBody collapsed={collapsed} onToggle={toggleCollapsed} />
      </aside>
    </TooltipProvider>
  );
}

export default Sidebar;
