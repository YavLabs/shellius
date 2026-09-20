import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Server,
  Terminal,
  KeyRound,
  FileKey,
  ArrowRight,
  ChevronRight,
  LayoutDashboard,
  ShieldAlert,
  Radar,
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import MyAccessWidget from '@/components/dashboard/MyAccessWidget';
import MetricCard from '@/components/dashboard/MetricCard';
import RecentConnectionsWidget from '@/components/dashboard/RecentConnectionsWidget';
import QuickActionsWidget from '@/components/dashboard/QuickActionsWidget';
import { useAuth } from '@/context/AuthContext';
import { getServerStats } from '@/services/serverService';
import { listSessions } from '@/services/sessionService';
import { listAccessRequests } from '@/services/accessRequestService';
import { listCertificates, getMyCerts } from '@/services/certificateService';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { can } from '@/lib/permissions';
import { listAudit } from '@/services/auditService';
import { getPostureSummary } from '@/services/postureService';
import { POSTURE_ALERTS_EVENT } from '@/hooks/usePostureAlertCount';
import { relativeTime } from '@/utils/time';
import Skeleton from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/badge';
import { auditCategoryTone, environmentTone } from '@/lib/badgeTones';
import { describeAuditEvent, auditSentence, auditCategoryLabel } from '@/lib/auditFormat';
import Avatar from '@/components/ui/Avatar';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { QUICK_ACTIONS, isQuickActionVisible } from '@/lib/commands';
import { cn } from '@/lib/utils';
import useIsMobile from '@/hooks/useIsMobile';
import { SectionTitle, ViewAllLink } from '@/components/mobile/MobileNavList';


/**
 * Phone metric tile: icon + number on one row, label under it. Four fit in
 * a 2×2 grid in the height one desktop metric card takes.
 */
function StatTile({ icon: Icon, label, value, to, loading, tone = 'primary', children }) {
  const navigate = useNavigate();
  const tones = {
    primary: 'bg-[hsl(var(--brand)/0.12)] text-primary',
    emerald: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    amber: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
    violet: 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
    rose: 'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  };
  return (
    <button
      type="button"
      onClick={to ? () => navigate(to) : undefined}
      disabled={!to}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left transition-colors active:bg-accent disabled:opacity-100"
    >
      <span className="flex items-center justify-between gap-2">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', tones[tone])}>
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        {loading ? <Skeleton className="h-6 w-8" /> : <span className="text-xl font-semibold tabular-nums text-foreground">{value}</span>}
      </span>
      <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </button>
  );
}

// Badge for audit action verbs — reuses the shared audit category tone map.
function AuditRow({ item }) {
  const navigate = useNavigate();
  const { verb, object, target, category } = describeAuditEvent(item);
  const actor = item.actor || { name: item.actorName, email: item.actorEmail };
  const actorName = actor?.name || 'System';
  const handleClick = () => navigate(item.resourceLink || '/audit-log');
  return (
    <li>
      <button
        type="button"
        onClick={handleClick}
        title={auditSentence(item)}
        className="group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar name={actorName} email={actor?.email} avatarUrl={actor?.avatarUrl} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{actorName}</span> {verb}
            {object && <> {object}</>}
            {target && <> <span className="font-medium text-foreground">{target}</span></>}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <Badge tone={auditCategoryTone(category)}>{auditCategoryLabel(category)}</Badge>
            <span className="whitespace-nowrap">{relativeTime(item.createdAt)}</span>
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground" />
      </button>
    </li>
  );
}

// Static class names per card count (Tailwind can't see computed ones).
const METRIC_COLS = {
  1: '',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
  5: 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5',
};

function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = can(user, 'audit.view');
  const canViewPosture = can(user, 'posture.read');
  // Org-wide numbers need org-wide permissions; everyone else sees their own
  // (instead of a misleading 0 from a refused request).
  const allSessions = can(user, 'sessions.view_all');
  const allCerts = can(user, 'certificates.view_all');
  const { liveCount } = useTerminalWorkspace();
  const { allowed: quickConnectAllowed } = useQuickConnect();
  const isMobile = useIsMobile();

  const [statsLoading, setStatsLoading] = useState(true);
  const [serverStats, setServerStats] = useState({ total: 0, byEnv: {} });
  const [activeSessions, setActiveSessions] = useState(0);
  const [pendingRequests, setPendingRequests] = useState(0);
  const [activeCerts, setActiveCerts] = useState(0);

  const [posture, setPosture] = useState(null);

  const [auditItems, setAuditItems] = useState([]);
  const [auditLoading, setAuditLoading] = useState(true);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const [srvStats, sessResp, reqResp, certResp, postureResp] = await Promise.allSettled([
        getServerStats(),
        allSessions ? listSessions({ limit: 1, status: 'ACTIVE' }) : Promise.reject(new Error('own only')),
        listAccessRequests({ tab: 'to-review', status: 'PENDING', limit: 1 }),
        allCerts ? listCertificates({ status: 'ACTIVE', limit: 1 }) : getMyCerts({ status: 'ACTIVE', limit: 1 }),
        canViewPosture ? getPostureSummary() : Promise.reject(new Error('no posture access')),
      ]);
      // A refused request must stay null, not become a reassuring zero — an
      // unreadable fleet is unknown, not clean.
      if (postureResp.status === 'fulfilled') {
        setPosture(postureResp.value);
        window.dispatchEvent(
          new CustomEvent(POSTURE_ALERTS_EVENT, {
            detail:
              (postureResp.value?.findings?.critical || 0) + (postureResp.value?.findings?.high || 0),
          })
        );
      }

      if (srvStats.status === 'fulfilled') setServerStats(srvStats.value);
      if (sessResp.status === 'fulfilled') {
        const r = sessResp.value;
        setActiveSessions(r.meta?.total ?? r.data?.total ?? 0);
      }
      if (reqResp.status === 'fulfilled') {
        const r = reqResp.value;
        setPendingRequests(r.meta?.total ?? 0);
      }
      if (certResp.status === 'fulfilled') {
        const r = certResp.value;
        setActiveCerts(r.meta?.total ?? r.data?.total ?? 0);
      }
    } catch {
      // stats degrade gracefully
    } finally {
      setStatsLoading(false);
    }
  }, [allSessions, allCerts, canViewPosture]);

  const loadAudit = useCallback(async () => {
    if (!isAdmin) {
      setAuditLoading(false);
      return;
    }
    setAuditLoading(true);
    try {
      const resp = await listAudit({ limit: 10, page: 1 });
      setAuditItems(resp.data?.items || []);
    } catch {
      // ignore
    } finally {
      setAuditLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    loadStats();
    loadAudit();
  }, [loadStats, loadAudit]);

  const { byEnv } = serverStats;
  // Critical + high only: the same "needs attention" bar as the sidebar badge
  // and the Server Details tab dot. A tile that counts INFO too is never zero
  // on a real fleet, and a number that is never zero stops being read.
  const postureAlerts = posture ? (posture.findings?.critical || 0) + (posture.findings?.high || 0) : 0;
  const unmonitored = posture ? (posture.servers?.notInstalled || 0) + (posture.servers?.stale || 0) : 0;
  const showPosture = canViewPosture && !!posture;
  // Everything below renders only what this role can use, and each row's
  // grid adapts to the cards actually present, so nothing leaves a hole.
  const metricCount = showPosture ? 5 : 4;
  // Phones: the bottom navigation's "+" is the quick actions list.
  const showQuickActions = !isMobile && QUICK_ACTIONS.some((a) => isQuickActionVisible(a, user, quickConnectAllowed));

  return (
    <div className="space-y-6 p-6">
      {/* Page heading */}
      <PageHeader
        icon={LayoutDashboard}
        title="Dashboard"
        subtitle="Overview of your infrastructure and access management."
      helpKey="dashboard" />

      {/* Phones: the four metrics as a compact 2×2 grid. */}
      {isMobile && (
        <div className="grid grid-cols-2 gap-2">
          <StatTile icon={Server} label="Servers" value={serverStats.total} loading={statsLoading} to="/servers" />
          {allSessions ? (
            <StatTile icon={Terminal} label="Active sessions" value={activeSessions} loading={statsLoading} tone="emerald" to="/sessions?tab=active" />
          ) : (
            <StatTile icon={Terminal} label="My live sessions" value={liveCount} tone="emerald" to="/terminals" />
          )}
          <StatTile
            icon={KeyRound}
            label="To review"
            value={pendingRequests}
            loading={statsLoading}
            tone="amber"
            to="/access-requests?tab=to-review"
          />
          <StatTile
            icon={FileKey}
            label={allCerts ? 'Certificates' : 'My certificates'}
            value={activeCerts}
            loading={statsLoading}
            tone="violet"
            to={allCerts ? '/certificates?status=ACTIVE' : undefined}
          />
          {showPosture && (
            <StatTile
              icon={ShieldAlert}
              label="Needs attention"
              value={postureAlerts}
              loading={statsLoading}
              tone="rose"
              to="/posture?severity=critical"
            />
          )}
          {showPosture && (
            <StatTile
              icon={Radar}
              label="Unmonitored hosts"
              value={unmonitored}
              loading={statsLoading}
              tone="amber"
              to="/posture"
            />
          )}
        </div>
      )}

      {/* Metric cards — the grid follows however many render (permissions). */}
      <div className={cn('grid grid-cols-1 gap-4 max-md:hidden', METRIC_COLS[Math.min(metricCount, 5)])}>
        <MetricCard
          title="Total servers"
          value={serverStats.total}
          subtitle="Managed infrastructure"
          icon={Server}
          accent="primary"
          loading={statsLoading}
          to="/servers"
          footer={
            !statsLoading && Object.entries(byEnv).some(([, v]) => v > 0) ? (
              Object.entries(byEnv)
                .filter(([, v]) => v > 0)
                .map(([env, count]) => (
                  <Badge key={env} tone={environmentTone(env).tone} uppercase>
                    {env}
                    <span className="font-semibold normal-case tracking-normal tabular-nums">{count}</span>
                  </Badge>
                ))
            ) : null
          }
        />

        {allSessions ? (
          <MetricCard
            title="Active sessions"
            value={activeSessions}
            subtitle="Currently connected"
            icon={Terminal}
            accent="emerald"
            loading={statsLoading}
            to="/sessions?tab=active"
            footer={
              !statsLoading ? (
                <span>
                  {activeSessions === 0 ? 'No one online right now' : 'View live sessions →'}
                </span>
              ) : null
            }
          />
        ) : (
          <MetricCard
            title="My live sessions"
            value={liveCount}
            subtitle="Terminals you have open"
            icon={Terminal}
            accent="emerald"
            to="/terminals"
            footer={<span>{liveCount === 0 ? 'Nothing running' : 'Open terminals →'}</span>}
          />
        )}

        <MetricCard
          title="Pending requests"
          value={pendingRequests}
          subtitle="Awaiting your review"
          icon={KeyRound}
          accent="amber"
          loading={statsLoading}
          to="/access-requests?tab=to-review&status=PENDING"
          footer={
            !statsLoading ? (
              <span>
                {pendingRequests === 0 ? 'Queue clear' : 'Review now →'}
              </span>
            ) : null
          }
        />

        <MetricCard
          title={allCerts ? 'Certificates issued' : 'My certificates'}
          value={activeCerts}
          subtitle="Currently active"
          icon={FileKey}
          accent="violet"
          loading={statsLoading}
          to={allCerts ? '/certificates?status=ACTIVE' : undefined}
          footer={
            !statsLoading ? (
              <span>Signed by the org CA</span>
            ) : null
          }
        />

        {/* Posture, for anyone who can read it. Critical + high open findings
            with the unmonitored-host count underneath, because "0 findings"
            across a fleet where nothing reports is the one number on this
            page that could be read as good news while meaning the opposite. */}
        {showPosture && (
          <MetricCard
            title="Needs attention"
            value={postureAlerts}
            subtitle="Critical & high findings"
            icon={ShieldAlert}
            accent="rose"
            loading={statsLoading}
            to="/posture?severity=critical"
            footer={
              !statsLoading ? (
                unmonitored > 0 ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    {unmonitored} host{unmonitored === 1 ? '' : 's'} not reporting
                  </span>
                ) : (
                  <span>{postureAlerts === 0 ? 'Every host reporting, nothing urgent' : 'Review now →'}</span>
                )
              ) : null
            }
          />
        )}
      </div>

      {/* Recent connections (wide) + Quick actions (narrow). Without any
          quick action for this role, Recent connections takes the row. */}
      <div className={cn('grid grid-cols-1 gap-4', showQuickActions && 'lg:grid-cols-3')}>
        <div className={cn(showQuickActions && 'lg:col-span-2')}>
          <RecentConnectionsWidget />
        </div>
        {showQuickActions && (
          <div>
            <QuickActionsWidget />
          </div>
        )}
      </div>

      {/* Bottom row: My access + Recent activity (audit.view). Alone, My
          access spans the row and lays its servers out in two columns. */}
      <div className={cn('grid grid-cols-1 gap-4', isAdmin && 'lg:grid-cols-2')}>
        <MyAccessWidget wide={!isAdmin} />

        {isAdmin && (
          <div className="flex flex-col rounded-lg border border-border bg-card p-5 max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:p-0">
            {isMobile && <SectionTitle title="Recent activity" action={<ViewAllLink to="/audit-log" />} />}
            <div className="mb-3 flex items-center justify-between max-md:hidden">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Recent activity</h2>
                <p className="mt-0.5 text-xs text-muted-foreground max-md:hidden">Latest audit events across the organization</p>
              </div>
            </div>

            <div className="-mx-2 flex-1 max-md:mx-0 max-md:rounded-lg max-md:border max-md:border-border max-md:bg-card max-md:px-1 max-md:py-1">
              {auditLoading ? (
                <div className="space-y-3 px-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-7 w-7 rounded-full" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-3.5 w-3/4" />
                        <Skeleton className="h-3 w-1/3" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : auditItems.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No recent activity yet.</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {(isMobile ? auditItems.slice(0, 5) : auditItems).map((item) => (
                    <AuditRow key={item.id} item={item} />
                  ))}
                </ul>
              )}
            </div>

            <button
              type="button"
              onClick={() => navigate('/audit-log')}
              className="mt-4 flex h-9 w-full items-center justify-center gap-1 rounded-md border border-border max-md:hidden text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              View all activity
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default Dashboard;
