import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Server,
  Terminal,
  KeyRound,
  FileKey,
  ArrowRight,
  ScrollText,
  LayoutDashboard,
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import MyAccessWidget from '@/components/dashboard/MyAccessWidget';
import { useAuth } from '@/context/AuthContext';
import { getServerStats } from '@/services/serverService';
import { listSessions } from '@/services/sessionService';
import { listAccessRequests } from '@/services/accessRequestService';
import { listCertificates } from '@/services/certificateService';
import { listAudit } from '@/services/auditService';
import { relativeTime } from '@/utils/time';
import Skeleton from '@/components/ui/Skeleton';

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

// Colour labels per environment
const ENV_COLORS = {
  prod: 'text-red-600 dark:text-red-400',
  staging: 'text-amber-600 dark:text-amber-400',
  dev: 'text-blue-600 dark:text-blue-400',
  demo: 'text-purple-600 dark:text-purple-400',
};

function StatCard({ title, value, description, icon: Icon, loading, children }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5 transition-colors">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <Icon className="h-4 w-4 text-muted-foreground/60" />
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-16" />
      ) : (
        <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
          {value}
        </p>
      )}
      {description && (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      )}
      {children}
    </div>
  );
}

// Badge for audit action verbs
const ACTION_BADGE_CLS = {
  auth: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  user: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
  server: 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20',
  access_request: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  cert: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
  session: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
};

function ActionBadge({ action }) {
  const prefix = (action || '').split('.')[0];
  const cls = ACTION_BADGE_CLS[prefix] || 'bg-muted text-foreground border-border';
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {action}
    </span>
  );
}

function QuickActionCard({ icon: Icon, label, description, to }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(to)}
      className="group flex items-center justify-between rounded-lg border border-border bg-card px-5 py-4 text-left transition-all hover:border-primary/40 hover:shadow-sm"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">{label}</p>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function Dashboard() {
  const { user } = useAuth();
  const isAdmin = isAtLeast(user, 'admin');

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

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Servers"
          value={serverStats.total}
          description="Managed infrastructure"
          icon={Server}
          loading={statsLoading}
        >
          {!statsLoading && Object.entries(byEnv).some(([, v]) => v > 0) && (
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
              {Object.entries(byEnv).map(([env, count]) =>
                count > 0 ? (
                  <span key={env} className={`text-xs font-medium ${ENV_COLORS[env] || 'text-muted-foreground'}`}>
                    {env} {count}
                  </span>
                ) : null
              )}
            </div>
          )}
        </StatCard>

        <StatCard
          title="Active Sessions"
          value={activeSessions}
          description="Currently connected"
          icon={Terminal}
          loading={statsLoading}
        />

        {/* Pending requests card — visible to admin+ or anyone who can be a reviewer */}
        <StatCard
          title="Pending Requests"
          value={pendingRequests}
          description="Awaiting your review"
          icon={KeyRound}
          loading={statsLoading}
        />

        <StatCard
          title="Certificates Issued"
          value={activeCerts}
          description="Currently active"
          icon={FileKey}
          loading={statsLoading}
        />
      </div>

      {/* Quick actions */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Quick Actions</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <QuickActionCard
            icon={KeyRound}
            label="Request Access"
            description="Open a new access request"
            to="/access-requests"
          />
          <QuickActionCard
            icon={FileKey}
            label="My Certificates"
            description="View active and past certificates"
            to="/certificates"
          />
          <QuickActionCard
            icon={Server}
            label="Browse Servers"
            description="Explore managed infrastructure"
            to="/servers"
          />
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
              <ScrollText className="h-4 w-4 text-muted-foreground/60" />
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
                  <li
                    key={item.id}
                    className="flex items-start gap-3 border-b border-border py-2.5 last:border-0"
                  >
                    <span className="mt-0.5 w-20 shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                      {relativeTime(item.createdAt)}
                    </span>
                    <ActionBadge action={item.action} />
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {item.resourceType}
                      {item.resourceId && (
                        <span className="ml-1 font-mono">
                          :{item.resourceId.slice(0, 8)}
                        </span>
                      )}
                    </span>
                  </li>
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
