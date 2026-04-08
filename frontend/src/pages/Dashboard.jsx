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

function StatCard({ title, value, description, icon: Icon, loading, children, to, onClick }) {
  const navigate = useNavigate();
  const interactive = !!to || !!onClick;
  const handleClick = () => {
    if (onClick) onClick();
    else if (to) navigate(to);
  };
  const Wrapper = interactive ? 'button' : 'div';
  // flex column w/ fixed structure: header row on top, value next,
  // description fills the middle, extras (env badges) anchor to bottom.
  // h-full + auto-rows-fr on the parent grid makes all four cards
  // identical height regardless of how much content they carry.
  const wrapperProps = interactive
    ? {
        type: 'button',
        onClick: handleClick,
        className:
          'group flex h-full w-full flex-col rounded-lg border border-border bg-card p-5 text-left transition-all hover:border-primary/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      }
    : {
        className:
          'flex h-full flex-col rounded-lg border border-border bg-card p-5 transition-colors',
      };
  return (
    <Wrapper {...wrapperProps}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <Icon className="h-4 w-4 text-muted-foreground/60 group-hover:text-muted-foreground" />
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
      {/* Extras anchored to the bottom of the card so all four line up */}
      {children && <div className="mt-auto pt-3">{children}</div>}
    </Wrapper>
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
  const navigate = useNavigate();
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

      {/* Stat cards — auto-rows-fr makes all four cards the same height */}
      <div className="grid grid-cols-1 auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Servers"
          value={serverStats.total}
          description="Click to browse managed infrastructure"
          icon={Server}
          loading={statsLoading}
          to="/servers"
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
          description="Click to view live sessions"
          icon={Terminal}
          loading={statsLoading}
          to="/sessions?tab=active"
        />

        {/* Pending requests card — drills into the review tab */}
        <StatCard
          title="Pending Requests"
          value={pendingRequests}
          description="Click to review requests"
          icon={KeyRound}
          loading={statsLoading}
          to="/access-requests?tab=to-review&status=PENDING"
        />

        <StatCard
          title="Certificates Issued"
          value={activeCerts}
          description="Click to view active certificates"
          icon={FileKey}
          loading={statsLoading}
          to="/certificates?status=ACTIVE"
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
