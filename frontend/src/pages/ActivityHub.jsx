import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox, KeyRound, Bell, Terminal, ScrollText, CheckCheck } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import { NavGroup, NavRow } from '@/components/mobile/MobileNavList';
import { MobileEmptyCard } from '@/components/mobile/MobileCard';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { useNotifications } from '@/context/NotificationContext';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import usePendingReviewCount from '@/hooks/usePendingReviewCount';
import { listAccessRequests } from '@/services/accessRequestService';
import { canAccessRoute } from '@/lib/commands';
import { can } from '@/lib/permissions';
import { RELATED_ROUTE } from '@/lib/notificationRoutes';
import { relativeTime } from '@/utils/time';
import { cn } from '@/lib/utils';

const LATEST = 8;

/** Your requests still waiting for a decision. */
function useMyPendingCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    listAccessRequests({ tab: 'mine', status: 'PENDING', limit: 1 })
      .then((resp) => !cancelled && setCount(resp.meta?.total ?? 0))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return count;
}

/**
 * One column of the summary strip: number on top, label under it, tap to
 * open the page behind it. Amber / green when there's something to see.
 */
function Stat({ label, value, to, tone = 'neutral' }) {
  const navigate = useNavigate();
  const lit = value > 0 && tone !== 'neutral';
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 py-3.5 text-center transition-colors active:bg-accent"
    >
      <span
        className={cn(
          'text-2xl font-semibold leading-none tabular-nums',
          lit && tone === 'attention' && 'text-amber-600 dark:text-amber-300',
          lit && tone === 'live' && 'text-emerald-600 dark:text-emerald-300',
          !lit && 'text-foreground'
        )}
      >
        {value > 99 ? '99+' : value}
      </span>
      <span className="max-w-full truncate text-[11px] font-medium text-muted-foreground">{label}</span>
    </button>
  );
}

/**
 * Activity — the phone bottom navigation's "Activity" tab: what needs your
 * attention, from several pages at once. Counts for reviews waiting on you,
 * your pending requests, live terminal sessions and unread notifications,
 * then the latest notifications and links to the full pages. Every entry
 * follows ROUTE_ACCESS; works on desktop too.
 */
function ActivityHub() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { notifications = [], unreadCount = 0, markRead, markAllRead } = useNotifications();
  const { liveCount = 0 } = useTerminalWorkspace();
  const pendingReviews = usePendingReviewCount(unreadCount);
  const myPending = useMyPendingCount();

  // Reviewers see the review tile; everyone else only once something is waiting.
  const showReviews = pendingReviews > 0 || can(user, 'access_requests.view_all');
  const latest = notifications.slice(0, LATEST);

  const openNotification = async (n) => {
    if (!n.isRead) {
      try {
        await markRead(n.id);
      } catch {
        /* ignore */
      }
    }
    const route = RELATED_ROUTE[n.relatedType]?.(n.relatedId);
    navigate(route || '/notifications');
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={Inbox} title="Activity" subtitle="Requests, sessions and notifications in one place." />

      {/* One summary card, split into equal columns (3 or 4), so nothing sits alone. */}
      <div className="flex divide-x divide-border overflow-hidden rounded-lg border border-border bg-card">
        {showReviews && <Stat label="To review" value={pendingReviews} tone="attention" to="/access-requests?tab=to-review" />}
        <Stat label="My requests" value={myPending} to="/access-requests" />
        <Stat label="Live" value={liveCount} tone="live" to="/terminals" />
        <Stat label="Unread" value={unreadCount} tone="attention" to="/notifications" />
      </div>

      <section>
        <div className="mb-1.5 flex items-center justify-between px-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Latest</h2>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" className="-mr-2 h-8 gap-1.5 text-xs text-muted-foreground" onClick={() => markAllRead?.()}>
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </Button>
          )}
        </div>
        {latest.length === 0 ? (
          <MobileEmptyCard>You're all caught up.</MobileEmptyCard>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {latest.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => openNotification(n)}
                  className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors active:bg-accent hover:bg-accent/50"
                >
                  <span
                    className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.isRead ? 'bg-transparent' : 'bg-primary')}
                    aria-label={n.isRead ? undefined : 'Unread'}
                  />
                  <span className="min-w-0 flex-1">
                    <span className={cn('line-clamp-2 text-sm', n.isRead ? 'text-muted-foreground' : 'font-medium text-foreground')}>
                      {n.body || n.title || '—'}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{relativeTime(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <NavGroup label="All activity">
        <NavRow icon={KeyRound} label="Access requests" description="Yours, and the ones you review" to="/access-requests" />
        <NavRow icon={Bell} label="Notifications" description="Everything sent to you" count={unreadCount} countTone="attention" to="/notifications" />
        {canAccessRoute(user, '/sessions') && (
          <NavRow icon={Terminal} label="Sessions" description="Who is connected, and recordings" to="/sessions" />
        )}
        {canAccessRoute(user, '/audit-log') && (
          <NavRow icon={ScrollText} label="Audit log" description="Every action in the organization" to="/audit-log" />
        )}
      </NavGroup>
    </div>
  );
}

export default ActivityHub;
