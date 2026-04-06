import { useState, useEffect, useCallback, useRef } from 'react';
import {
  MonitorOff,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import Badge from '@/components/shared/Badge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { listSessions, listActiveSessions, getSession, terminateSession } from '@/services/sessionService';
import { useAuth } from '@/context/AuthContext';
import { relativeTime, formatDateTime } from '@/utils/time';

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

const SESSION_STATUS_META = {
  ACTIVE: { label: 'Active', variant: 'success' },
  ENDED: { label: 'Ended', variant: 'default' },
  TERMINATED: { label: 'Terminated', variant: 'danger' },
};

function SessionStatusBadge({ status }) {
  const meta = SESSION_STATUS_META[status] || { label: status, variant: 'default' };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

function durationLabel(startedAt, endedAt) {
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const diffSec = Math.floor((end - start) / 1000);
  if (diffSec < 0) return '-';
  const m = Math.floor(diffSec / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${diffSec % 60}s`;
  return `${diffSec}s`;
}

function DetailRow({ label, value }) {
  return (
    <div className="grid grid-cols-3 gap-2 border-b border-border py-2.5 last:border-0">
      <dt className="col-span-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="col-span-2 break-all text-sm text-foreground">{value ?? '-'}</dd>
    </div>
  );
}

function SessionDetailDrawer({ sessionId, open, onClose }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!sessionId || !open) return;
    setLoading(true);
    setError('');
    getSession(sessionId)
      .then((resp) => setSession(resp.data || resp))
      .catch((err) => setError(err.response?.data?.error?.message || 'Failed to load session.'))
      .finally(() => setLoading(false));
  }, [sessionId, open]);

  return (
    <Modal open={open} onClose={onClose} title="Session Details" size="lg">
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-8 w-full animate-pulse rounded bg-muted" />
          ))}
        </div>
      )}
      {!loading && error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {!loading && session && (
        <dl>
          <DetailRow label="ID" value={<span className="font-mono text-xs">{session.id}</span>} />
          <DetailRow
            label="Status"
            value={<SessionStatusBadge status={session.status} />}
          />
          <DetailRow
            label="Server"
            value={
              session.server ? (
                <span className="flex items-center gap-2">
                  {session.server.hostname || session.server.name}
                  {session.server.environment && (
                    <EnvironmentBadge environment={session.server.environment} />
                  )}
                </span>
              ) : (
                session.serverId
              )
            }
          />
          <DetailRow
            label="User"
            value={session.user?.name || session.user?.email || session.userId}
          />
          <DetailRow label="Protocol" value={session.protocol} />
          <DetailRow label="Client IP" value={session.clientIp} />
          <DetailRow label="Principal" value={session.principal} />
          <DetailRow label="Started At" value={formatDateTime(session.startedAt)} />
          <DetailRow label="Ended At" value={formatDateTime(session.endedAt)} />
          <DetailRow
            label="Duration"
            value={
              session.status === 'ACTIVE'
                ? 'Active'
                : durationLabel(session.startedAt, session.endedAt)
            }
          />
          <DetailRow label="Access Request ID" value={
            <span className="font-mono text-xs">{session.accessRequestId || '-'}</span>
          } />
          {session.terminatedBy && (
            <DetailRow
              label="Terminated By"
              value={session.terminatedBy?.name || session.terminatedBy?.email || session.terminatedById}
            />
          )}
        </dl>
      )}
    </Modal>
  );
}

const TABS = [
  { key: 'all', label: 'All Sessions' },
  { key: 'active', label: 'Active' },
];

const SESSION_STATUSES = ['ACTIVE', 'ENDED', 'TERMINATED'];

function Sessions() {
  const { user } = useAuth();
  const canTerminate = isAtLeast(user, 'admin');

  const [activeTab, setActiveTab] = useState('all');
  const [sessions, setSessions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [statusFilter, setStatusFilter] = useState('');

  const [detailId, setDetailId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const [terminateTarget, setTerminateTarget] = useState(null);
  const [terminating, setTerminating] = useState(false);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let resp;
      if (activeTab === 'active') {
        resp = await listActiveSessions({ page, limit: pageSize });
      } else {
        const params = { page, limit: pageSize };
        if (statusFilter) params.status = statusFilter;
        resp = await listSessions(params);
      }
      const items = resp.data?.items || resp.data || [];
      const metaTotal =
        resp.meta?.total ?? resp.data?.total ?? (Array.isArray(resp.data) ? resp.data.length : items.length);
      setSessions(items);
      setTotal(metaTotal);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load sessions.');
    } finally {
      setLoading(false);
    }
  }, [activeTab, page, pageSize, statusFilter]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleTabChange = (key) => {
    setActiveTab(key);
    setPage(1);
    setStatusFilter('');
  };

  const openDetail = (id) => {
    setDetailId(id);
    setDetailOpen(true);
  };

  const handleTerminate = async () => {
    if (!terminateTarget) return;
    setTerminating(true);
    try {
      await terminateSession(terminateTarget.id);
      setTerminateTarget(null);
      fetchSessions();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to terminate session.');
      setTerminateTarget(null);
    } finally {
      setTerminating(false);
    }
  };

  const columns = [
    {
      key: 'server',
      label: 'Server',
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {r.server?.hostname || r.server?.name || r.serverId}
          </span>
          {r.server?.environment && <EnvironmentBadge environment={r.server.environment} />}
        </div>
      ),
    },
    {
      key: 'user',
      label: 'User',
      render: (r) => (
        <span className="text-sm text-foreground">
          {r.user?.name || r.user?.email || r.userId || '-'}
        </span>
      ),
    },
    {
      key: 'startedAt',
      label: 'Started',
      render: (r) => (
        <span className="text-xs text-muted-foreground">{relativeTime(r.startedAt)}</span>
      ),
    },
    {
      key: 'duration',
      label: 'Duration',
      render: (r) =>
        r.status === 'ACTIVE' ? (
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Active</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {durationLabel(r.startedAt, r.endedAt)}
          </span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <SessionStatusBadge status={r.status} />,
    },
    {
      key: 'clientIp',
      label: 'Client IP',
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{r.clientIp || '-'}</span>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-24',
      render: (r) => (
        <div className="flex items-center gap-1">
          <button
            onClick={() => openDetail(r.id)}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            View
          </button>
          {canTerminate && r.status === 'ACTIVE' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setTerminateTarget(r);
              }}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10 transition-colors"
            >
              <MonitorOff className="h-3.5 w-3.5" />
              Terminate
            </button>
          )}
        </div>
      ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectCls =
    'h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Sessions</h1>
          <p className="text-sm text-muted-foreground">
            Active and historical SSH/RDP sessions.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className={[
              'relative px-4 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters — only shown in all tab */}
      {activeTab === 'all' && (
        <div className="flex flex-wrap items-center gap-3">
          <select
            className={selectCls}
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {SESSION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        data={sessions}
        loading={loading}
        emptyMessage={
          activeTab === 'active'
            ? 'No active sessions.'
            : 'No sessions found.'
        }
      />

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {total} session{total === 1 ? '' : 's'}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex h-8 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="flex h-8 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <SessionDetailDrawer
        sessionId={detailId}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setDetailId(null);
        }}
      />

      <ConfirmDialog
        open={!!terminateTarget}
        title="Terminate Session"
        message={`Terminate the active session for ${
          terminateTarget?.user?.name ||
          terminateTarget?.user?.email ||
          'this user'
        } on ${
          terminateTarget?.server?.hostname ||
          terminateTarget?.server?.name ||
          'this server'
        }? The connection will be immediately closed.`}
        confirmLabel={terminating ? 'Terminating...' : 'Terminate'}
        variant="destructive"
        onConfirm={handleTerminate}
        onCancel={() => setTerminateTarget(null)}
      />
    </div>
  );
}

export default Sessions;
