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

const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, member: 1 };
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

// Accent palette per card — icon tile + hover ring color.
const STAT_ACCENTS = {
  primary: { bg: 'bg-primary/10', text: 'text-primary', ring: 'group-hover:border-primary/40' },
  emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-600 dark:text-emerald-400', ring: 'group-hover:border-emerald-500/40' },
  amber: { bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400', ring: 'group-hover:border-amber-500/40' },
  violet: { bg: 'bg-violet-500/10', text: 'text-violet-600 dark:text-violet-400', ring: 'group-hover:border-violet-500/40' },
};

function StatCard({
  title,
  value,
  description,
  icon: Icon,
  loading,
  footer,
  accent = 'primary',
  to,
  onClick,
}) {
  const navigate = useNavigate();
  const interactive = !!to || !!onClick;
  const handleClick = () => {
    if (onClick) onClick();
    else if (to) navigate(to);
  };
  const accentCls = STAT_ACCENTS[accent] || STAT_ACCENTS.primary;

  const Wrapper = interactive ? 'button' : 'div';
  const baseCls =
    'group relative flex h-full w-full flex-col rounded-lg border border-border bg-card p-5 text-left transition-all';
  const interactiveCls = interactive
    ? ` hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${accentCls.ring}`
    : '';

  return (
    <Wrapper
      {...(interactive ? { type: 'button', onClick: handleClick } : {})}
      className={baseCls + interactiveCls}
    >
      {/* Header: icon tile + title */}
      <div className="flex items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${accentCls.bg} ${accentCls.text}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
      </div>

      {/* Big number */}
      <div className="mt-4">
        {loading ? (
          <Skeleton className="h-9 w-20" />
        ) : (
          <p className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">
            {value}
          </p>
        )}
      </div>

      {/* Description */}
      {description && (
        <p className="mt-1.5 text-xs text-muted-foreground">{description}</p>
      )}

      {/* Footer strip — anchored to bottom with a top border so all four
          cards render their extras at identical Y positions */}
      {footer && (
        <div className="mt-auto pt-4 border-t border-border/50">
          {footer}
        </div>
      )}
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
          description="Managed infrastructure"
          icon={Server}
          accent="primary"
          loading={statsLoading}
          to="/servers"
          footer={
            !statsLoading && Object.entries(byEnv).some(([, v]) => v > 0) ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {Object.entries(byEnv)
                  .filter(([, v]) => v > 0)
                  .map(([env, count]) => (
                    <span
                      key={env}
                      className={`inline-flex items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10px] font-medium ${
                        ENV_COLORS[env] || 'text-muted-foreground'
                      }`}
                    >
                      {env}
                      <span className="text-foreground tabular-nums">{count}</span>
                    </span>
                  ))}
              </div>
            ) : null
          }
        />

        <StatCard
          title="Active Sessions"
          value={activeSessions}
          description="Currently connected"
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

        <StatCard
          title="Pending Requests"
          value={pendingRequests}
          description="Awaiting your review"
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

        <StatCard
          title="Certificates Issued"
          value={activeCerts}
          description="Currently active"
          icon={FileKey}
          accent="violet"
          loading={statsLoading}
          to="/certificates?status=ACTIVE"
          footer={
            !statsLoading ? (
              <span className="text-[11px] text-muted-foreground">
                Signed by the org CA
              </span>
            ) : null
          }
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
