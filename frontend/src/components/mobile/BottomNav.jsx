import { useCallback, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { useCommandPalette } from '@/context/CommandPaletteContext';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import usePendingReviewCount from '@/hooks/usePendingReviewCount';
import { useNotifications } from '@/context/NotificationContext';
import { usePageActions } from '@/context/PageActionsContext';
import ActionSheet from '@/components/mobile/ActionSheet';
import { BOTTOM_NAV_ITEMS, centreSheetGroups, isBottomNavItemActive, isMoreActive, splitAroundCentre } from '@/lib/mobileNav';
import MoreSheet from '@/components/mobile/MoreSheet';
import Avatar from '@/components/ui/Avatar';
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

const TAB_CLS =
  'flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function NavTab({ item, active, badge }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      aria-current={active ? 'page' : undefined}
      className={cn(TAB_CLS, active ? 'text-[hsl(var(--brand))]' : 'text-muted-foreground active:text-foreground')}
    >
      <span className="relative">
        <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
        {badge}
      </span>
      <span className="max-w-full truncate leading-none">{item.label}</span>
    </NavLink>
  );
}

/** "More" tab: your avatar (the old top-bar avatar and menu button in one). */
function MoreTab({ user, active, open, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="More"
      aria-haspopup="dialog"
      aria-expanded={open}
      className={cn(TAB_CLS, active || open ? 'text-[hsl(var(--brand))]' : 'text-muted-foreground active:text-foreground')}
    >
      <span
        className={cn(
          'flex h-6 w-6 items-center justify-center overflow-hidden rounded-full ring-2 [&>*]:h-6 [&>*]:w-6 [&>*]:text-[10px]',
          active || open ? 'ring-[hsl(var(--brand))]' : 'ring-transparent'
        )}
      >
        <Avatar name={user?.name} email={user?.email} avatarUrl={user?.avatarUrl} size="sm" />
      </span>
      <span className="max-w-full truncate leading-none">More</span>
    </button>
  );
}

/**
 * BottomNav — the phone navigation bar (docs/plans/1.5.1-mobile.md §1), the
 * only app chrome on phones (no top bar): Home, Connect, the raised "+"
 * (this page's create actions, then Quick connect and the quick actions),
 * Activity, and More (your avatar: search, account, every other page,
 * theme). Rendered in the layout's column, not over the content.
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
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);

  const [left, right] = splitAroundCentre(BOTTOM_NAV_ITEMS);
  const groups = useMemo(() => centreSheetGroups(user, quickConnectAllowed), [user, quickConnectAllowed]);
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  const pageActions = usePageActions();
  // "Add Server" on the page and "New server" in Create are the same thing.
  const noun = (label) => label.trim().toLowerCase().replace(/^(add|new|create|invite)\s+(an?\s+)?/, '');
  const pageLabels = new Set(pageActions.map((a) => noun(a.label)));

  // "On this page" (the page's create actions) first, then Quick connect and
  // the global quick actions — without repeating what the page already offers.
  const globalGroups = groups
    .map((g) => ({ ...g, items: g.items.filter((a) => !pageLabels.has(noun(a.label))) }))
    .filter((g) => g.items.length > 0)
    .map((g) => ({
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
  const sheetGroups = [
    ...(pageActions.length > 0
      ? [
          {
            key: 'page',
            label: 'On this page',
            items: pageActions.map((a) => ({
              key: a.key,
              label: a.label,
              icon: a.icon,
              emphasis: true,
              disabled: a.disabled,
              onSelect: () => {
                closeSheet();
                a.run();
              },
            })),
          },
        ]
      : []),
    ...globalGroups.map((g, i) =>
      // Only one emphasised block: page actions win over Quick connect.
      pageActions.length > 0 && i === 0 ? { ...g, items: g.items.map((it) => ({ ...it, emphasis: false })) } : g
    ),
  ];

  const badgeFor = (item) => {
    // The old bell's unread count now sits on Activity; live terminals on Connect.
    if (item.id === 'activity') return <CountBadge count={Math.max(unreadCount, pendingReviews)} />;
    if (item.id === 'connect') return <CountBadge count={liveCount} tone="live" />;
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
          <div className="flex flex-1 items-stretch">
            {right.map(renderTab)}
            <MoreTab user={user} active={isMoreActive(location.pathname)} open={moreOpen} onClick={() => setMoreOpen(true)} />
          </div>
        </div>
      </nav>
      <MoreSheet open={moreOpen} onClose={closeMore} pathname={location.pathname} pendingReviews={pendingReviews} />
      <ActionSheet open={sheetOpen} onClose={closeSheet} title="Quick actions" groups={sheetGroups} />
    </>
  );
}

export default BottomNav;
