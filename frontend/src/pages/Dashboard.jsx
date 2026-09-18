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
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import MyAccessWidget from '@/components/dashboard/MyAccessWidget';
import MetricCard from '@/components/dashboard/MetricCard';
import RecentQuickConnectsWidget from '@/components/dashboard/RecentQuickConnectsWidget';
import QuickActionsWidget from '@/components/dashboard/QuickActionsWidget';
import { useAuth } from '@/context/AuthContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { getServerStats } from '@/services/serverService';
import { listSessions } from '@/services/sessionService';
import { listAccessRequests } from '@/services/accessRequestService';
import { listCertificates } from '@/services/certificateService';
import { listAudit } from '@/services/auditService';
import { relativeTime } from '@/utils/time';
import Skeleton from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/badge';
import { auditCategoryTone, environmentTone } from '@/lib/badgeTones';
import { describeAuditEvent, auditSentence, auditCategoryLabel } from '@/lib/auditFormat';
import Avatar from '@/components/ui/Avatar';

const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, member: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
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

function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = isAtLeast(user, 'admin');
  const { allowed: quickConnectAllowed } = useQuickConnect();

  const [statsLoading, setStatsLoading] = useState(true);
  const [serverStats, setServerStats] = useState({ total: 0, byEnv: {} });
  const [activeSessions, setActiveSessions] = useState(0);
  const [pendingRequests, setPendingRequests] = useState(0);
  const [activeCerts, setActiveCerts] = useState(0);

  const [auditItems, setAuditItems] = useState([]);
  const [auditLoading, setAuditLoading] = useState(true);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const [srvStats, sessResp, reqResp, certResp] = await Promise.allSettled([
        getServerStats(),
        listSessions({ limit: 1, status: 'ACTIVE' }),
        listAccessRequests({ tab: 'to-review', status: 'PENDING', limit: 1 }),
        listCertificates({ status: 'ACTIVE', limit: 1 }),
      ]);

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
  }, []);

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

  return (
    <div className="space-y-6 p-6">
      {/* Page heading */}
      <PageHeader
        icon={LayoutDashboard}
        title="Dashboard"
        subtitle="Overview of your infrastructure and access management."
      helpKey="dashboard" />

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Total Servers"
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
                    <span className="normal-case tracking-normal text-foreground tabular-nums">{count}</span>
                  </Badge>
                ))
            ) : null
          }
        />

        <MetricCard
          title="Active Sessions"
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

        <MetricCard
          title="Pending Requests"
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
          title="Certificates Issued"
          value={activeCerts}
          subtitle="Currently active"
          icon={FileKey}
          accent="violet"
          loading={statsLoading}
          to="/certificates?status=ACTIVE"
          footer={
            !statsLoading ? (
              <span>Signed by the org CA</span>
            ) : null
          }
        />
      </div>

      {/* Recent Quick Connects (wide) + Quick actions (narrow) */}
      <div className={`grid grid-cols-1 gap-4 ${quickConnectAllowed ? 'lg:grid-cols-3' : ''}`}>
        {quickConnectAllowed && (
          <div className="lg:col-span-2">
            <RecentQuickConnectsWidget />
          </div>
        )}
        <div>
          <QuickActionsWidget />
        </div>
      </div>

      {/* Bottom row: MyAccess + Recent Activity */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MyAccessWidget />

        {isAdmin && (
          <div className="flex flex-col rounded-lg border border-border bg-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Recent activity</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Latest audit events across the organization</p>
              </div>
            </div>

            <div className="-mx-2 flex-1">
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
                  {auditItems.map((item) => (
                    <AuditRow key={item.id} item={item} />
                  ))}
                </ul>
              )}
            </div>

            <button
              type="button"
              onClick={() => navigate('/audit-log')}
              className="mt-4 flex h-9 w-full items-center justify-center gap-1 rounded-md border border-border text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
