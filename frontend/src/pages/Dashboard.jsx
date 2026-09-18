import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Server,
  Terminal,
  KeyRound,
  FileKey,
  ArrowRight,
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

const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, member: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

// Badge for audit action verbs — reuses the shared audit category tone map.
function ActionBadge({ action }) {
  const prefix = (action || '').split('.')[0];
  return (
    <Badge tone={auditCategoryTone(prefix)} className="shrink-0">
      {action}
    </Badge>
  );
}

// Humanize an audit action like "access_request.submit" → "submitted an access request"
const ACTION_VERBS = {
  'access_request.submit': 'submitted access request',
  'access_request.approve': 'approved access request',
  'access_request.deny': 'denied access request',
  'access_request.revoke': 'revoked access request',
  'access_request.expire': 'expired access request',
  'access_request.break_glass': 'invoked break-glass access',
  'access_request.ssh_credentials': 'downloaded SSH credentials',
  'access_request.rdp_credentials': 'downloaded RDP credentials',
  'access_request.ssh_credentials_generated': 'opened web terminal',
  'certificate.issue': 'issued certificate',
  'certificate.revoke': 'revoked certificate',
  'certificate.key_downloaded': 'downloaded private key',
  'server.create': 'added server',
  'server.update': 'updated server',
  'server.delete': 'removed server',
  'server.bootstrap': 'bootstrapped server',
  'user.create': 'created user',
  'user.update': 'updated user',
  'user.delete': 'deleted user',
  'user.invite': 'invited user',
  'auth.login': 'signed in',
  'auth.logout': 'signed out',
  'auth.password_change': 'changed password',
  'policy.create': 'created policy',
  'policy.update': 'updated policy',
  'policy.delete': 'deleted policy',
  'session.terminate': 'terminated session',
  'group.create': 'created group',
  'group.update': 'updated group',
  'group.delete': 'deleted group',
};

function humanizeAction(action) {
  if (ACTION_VERBS[action]) return ACTION_VERBS[action];
  // Fallback: convert "resource.verb" → "verbed resource"
  const [, verb] = (action || '').split('.');
  return verb ? verb.replace(/_/g, ' ') : action || '';
}

function AuditRow({ item }) {
  const navigate = useNavigate();
  const verb = humanizeAction(item.action);
  const handleClick = () => {
    if (item.resourceLink) navigate(item.resourceLink);
    else navigate('/audit-log');
  };
  return (
    <li>
      <button
        type="button"
        onClick={handleClick}
        className="flex w-full items-start gap-3 border-b border-border py-2.5 text-left last:border-0 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm px-1 -mx-1"
      >
        <span className="mt-0.5 w-20 shrink-0 text-xs text-muted-foreground whitespace-nowrap">
          {relativeTime(item.createdAt)}
        </span>
        <ActionBadge action={item.action} />
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{item.actorName || 'System'}</span>
          {' '}
          {verb}
          {item.resourceLabel && item.resourceLabel !== item.resourceType && (
            <>
              {': '}
              <span className="text-foreground">{item.resourceLabel}</span>
            </>
          )}
        </span>
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
              <span className="text-[11px] text-muted-foreground">
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
              <span className="text-[11px] text-muted-foreground">
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
              <span className="text-[11px] text-muted-foreground">Signed by the org CA</span>
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
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Recent Activity</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Last 10 audit events</p>
              </div>
              <button
                type="button"
                onClick={() => navigate('/audit-log')}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                View all
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>

            {auditLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-5 w-28" />
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 flex-1" />
                  </div>
                ))}
              </div>
            ) : auditItems.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No recent activity found.
              </p>
            ) : (
              <ul className="space-y-0">
                {auditItems.map((item) => (
                  <AuditRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default Dashboard;
