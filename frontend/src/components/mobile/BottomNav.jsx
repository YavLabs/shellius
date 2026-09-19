import { useCallback, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { useCommandPalette } from '@/context/CommandPaletteContext';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import usePendingReviewCount from '@/hooks/usePendingReviewCount';
import { useNotifications } from '@/context/NotificationContext';
import ActionSheet from '@/components/mobile/ActionSheet';
import { bottomNavItems, centreSheetGroups, isBottomNavItemActive, splitAroundCentre } from '@/lib/mobileNav';
import { runQuickAction } from '@/lib/runQuickAction';
import { cn } from '@/lib/utils';

function CountBadge({ count, tone }) {
  if (!count) return null;
  return (
    <span
      className={cn(
        'absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none ring-2 ring-card',
        tone === 'live' ? 'bg-emerald-500 text-white' : 'bg-amber-500 text-white'
      )}
    >
      {count > 9 ? '9+' : count}
    </span>
  );
}

function NavTab({ item, active, badge }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'text-[hsl(var(--brand))]' : 'text-muted-foreground active:text-foreground'
      )}
    >
      <span className="relative">
        <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
        {badge}
      </span>
      <span className="max-w-full truncate leading-none">{item.label}</span>
    </NavLink>
  );
}

/**
 * BottomNav — phone-only navigation bar (docs/plans/1.5.1-mobile.md §1):
 * two nav items, a raised centre "+" button that opens the actions sheet
 * (Quick connect, then the Quick actions list), two nav items. Rendered in
 * the layout's flex column (not over the content) so pages and the
 * terminal keep their full usable height above it.
 */
function BottomNav() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { allowed: quickConnectAllowed, openQuickConnect } = useQuickConnect();
  const { openPalette } = useCommandPalette();
  const { liveCount } = useTerminalWorkspace();
  const { unreadCount } = useNotifications();
  const pendingReviews = usePendingReviewCount(unreadCount);
  const [sheetOpen, setSheetOpen] = useState(false);

  const items = useMemo(() => bottomNavItems(user), [user]);
  const [left, right] = splitAroundCentre(items);
  const groups = useMemo(() => centreSheetGroups(user, quickConnectAllowed), [user, quickConnectAllowed]);
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  const sheetGroups = groups.map((g) => ({
    key: g.key,
    label: g.label,
    items: g.items.map((a) => ({
      key: a.id,
      label: a.label,
      icon: a.icon,
      emphasis: !!a.quickConnect,
      onSelect: () => runQuickAction(a, { navigate, openQuickConnect, openPalette, onBeforeRun: closeSheet }),
    })),
  }));

  const badgeFor = (item) => {
    if (item.id === 'access-requests') return <CountBadge count={pendingReviews} />;
    if (item.id === 'terminals') return <CountBadge count={liveCount} tone="live" />;
    return null;
  };
  const renderTab = (item) => (
    <NavTab key={item.id} item={item} active={isBottomNavItemActive(item, location.pathname)} badge={badgeFor(item)} />
  );

  return (
    <>
      <nav
        aria-label="Primary"
        className="relative z-30 shrink-0 border-t border-border/70 bg-card/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md supports-[backdrop-filter]:bg-card/75 md:hidden"
      >
        <div className="mx-auto flex h-16 max-w-md items-stretch px-2">
          <div className="flex flex-1 items-stretch">{left.map(renderTab)}</div>
          <div className="flex w-16 shrink-0 items-start justify-center">
            {sheetGroups.length > 0 && (
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                aria-label="Quick actions"
                aria-haspopup="dialog"
                aria-expanded={sheetOpen}
                className="bg-brand-gradient -mt-5 flex h-14 w-14 items-center justify-center rounded-full text-[color:var(--brand-on-gradient)] shadow-lg ring-4 ring-background transition-transform focus-visible:outline-none focus-visible:ring-ring active:scale-95"
              >
                <Plus className="h-6 w-6" strokeWidth={2.5} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="flex flex-1 items-stretch">{right.map(renderTab)}</div>
        </div>
      </nav>
      <ActionSheet open={sheetOpen} onClose={closeSheet} title="Quick actions" groups={sheetGroups} />
    </>
  );
}

export default BottomNav;
