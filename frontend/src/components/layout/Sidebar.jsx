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
  Terminal,
  ScrollText,
  Bell,
  Cloud,
  Upload,
  ChevronUp,
  PanelLeft,
  PanelLeftClose,
  Menu,
  X,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useNotifications } from '@/context/NotificationContext';
import { cn } from '@/lib/utils';
import BrandLogo, { BrandMark } from '@/components/common/BrandLogo';
import UserMenu from '@/components/layout/UserMenu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLAPSED_KEY = 'shellius_sidebar_collapsed';
const EXPANDED_WIDTH = 'w-60';
const COLLAPSED_WIDTH = 'w-14';

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

// ---------------------------------------------------------------------------
// Grouped navigation config
// ---------------------------------------------------------------------------

const NAV_SECTIONS = [
  {
    label: 'Overview',
    items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, to: '/' }],
  },
  {
    label: 'Inventory',
    items: [
      { id: 'customers', label: 'Customers', icon: Building2, to: '/customers' },
      { id: 'servers', label: 'Servers', icon: Server, to: '/servers' },
    ],
  },
  {
    label: 'Access',
    items: [
      { id: 'access-requests', label: 'Access Requests', icon: KeyRound, to: '/access-requests' },
      { id: 'policies', label: 'Policies', icon: Shield, to: '/policies', minRole: 'admin' },
      {
        id: 'certificates',
        label: 'Certificates',
        icon: FileKey,
        to: '/certificates',
        minRole: 'admin',
      },
    ],
  },
  {
    label: 'Audit',
    items: [
      { id: 'sessions', label: 'Sessions', icon: Terminal, to: '/sessions', minRole: 'operator' },
      { id: 'audit-log', label: 'Audit Log', icon: ScrollText, to: '/audit-log', minRole: 'admin' },
      { id: 'notifications', label: 'Notifications', icon: Bell, to: '/notifications' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { id: 'users', label: 'Users', icon: Users, to: '/users' },
      { id: 'groups', label: 'Groups', icon: UsersRound, to: '/groups' },
      { id: 'bulk-import', label: 'Bulk Import', icon: Upload, to: '/bulk-import', minRole: 'admin' },
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

  const canSee = (item) => !item.minRole || isAtLeast(user, item.minRole);

  const renderItem = (item) => {
    if (!canSee(item)) return null;
    let badge = null;
    if (item.id === 'access-requests' && unreadCount > 0 && !collapsed) {
      badge = (
        <span className="ml-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
          {unreadCount > 9 ? '9+' : unreadCount}
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
              <BrandLogo size="sm" />
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
          topbar avatar uses. Profile / Settings / Theme / Install CLI /
          Sign out all live in the shared menu now. */}
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
                      className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
                    >
                      {user.name?.[0]?.toUpperCase() || 'U'}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <span className="font-medium">{user.name}</span>
                    {user.role && <span className="text-muted-foreground"> · {user.role}</span>}
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
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                    {user.name?.[0]?.toUpperCase() || 'U'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{user.name}</p>
                    <p className="truncate text-[10px] text-muted-foreground">{user.role}</p>
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

function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

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
