import { useState, useEffect, useCallback } from 'react';
import {
  Film,
  Terminal as TerminalIcon,
  Eye,
  Square,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import Badge from '@/components/shared/Badge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import SessionPlayer from '@/components/sessions/SessionPlayer';
import PageHeader from '@/components/common/PageHeader';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
          <DetailRow label="Status" value={<SessionStatusBadge status={session.status} />} />
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
                <span className="italic text-muted-foreground">unknown server</span>
              )
            }
          />
          <DetailRow
            label="User"
            value={
              session.user?.name ||
              session.user?.email || (
                <span className="italic text-muted-foreground">unknown user</span>
              )
            }
          />
          <DetailRow label="Protocol" value={session.protocol} />
          <DetailRow label="Client IP" value={session.clientIp} />
          <DetailRow label="Principal" value={session.principal} />
          <DetailRow label="Started At" value={formatDateTime(session.startedAt)} />
          <DetailRow label="Ended At" value={formatDateTime(session.endedAt)} />
          <DetailRow
            label="Duration"
            value={session.status === 'ACTIVE' ? 'Active' : durationLabel(session.startedAt, session.endedAt)}
          />
          {session.accessRequest && (
            <DetailRow
              label="Access Request"
              value={
                <span className="flex items-center gap-2">
                  <span>
                    {session.accessRequest.requester?.name ||
                      session.accessRequest.requester?.email ||
                      'requester'}{' '}
                    →{' '}
                    {session.accessRequest.server?.hostname ||
                      session.server?.hostname ||
                      'server'}
                  </span>
                  {session.accessRequest.reason && (
                    <span
                      className="truncate text-xs text-muted-foreground max-w-xs"
                      title={session.accessRequest.reason}
                    >
                      ({session.accessRequest.reason})
                    </span>
                  )}
                </span>
              }
            />
          )}
          {session.terminatedBy && (
            <DetailRow
              label="Terminated By"
              value={session.terminatedBy?.name || session.terminatedBy?.email || 'Unknown'}
            />
          )}
        </dl>
      )}
      {!loading && session && session.recordingPath && (
        <div className="mt-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Film className="h-3.5 w-3.5" />
            Recording
          </div>
          <SessionPlayer sessionId={session.id} />
        </div>
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
  const [pageSize, setPageSize] = useState(20);
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

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  const handleTabChange = (key) => {
    setActiveTab(key);
    setPage(1);
    setStatusFilter('');
  };

  const openDetail = (id) => { setDetailId(id); setDetailOpen(true); };

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

  const filterSlot = activeTab === 'all' ? (
    <Select
      value={statusFilter || '_all'}
      onValueChange={(v) => { setStatusFilter(v === '_all' ? '' : v); setPage(1); }}
    >
      <SelectTrigger className="w-[160px]"><SelectValue placeholder="All statuses" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="_all">All statuses</SelectItem>
        {SESSION_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
      </SelectContent>
    </Select>
  ) : null;

  const columns = [
    {
      key: 'server',
      label: 'Server',
      sortable: true,
      searchAccessor: (r) => `${r.server?.hostname || r.server?.name || ''} ${r.server?.environment || ''}`,
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {r.server?.hostname || r.server?.name || r.serverId}
          </span>
          {r.server?.environment && <EnvironmentBadge environment={r.server.environment} />}
          {r.recordingPath && (
            <Film className="h-3.5 w-3.5 shrink-0 text-muted-foreground" title="Recording available" />
          )}
        </div>
      ),
    },
    {
      key: 'user',
      label: 'User',
      sortable: true,
      searchAccessor: (r) => r.user?.name || r.user?.email || '',
      render: (r) => (
        <span className="text-sm text-foreground">
          {r.user?.name || r.user?.email || r.userId || '-'}
        </span>
      ),
    },
    {
      key: 'startedAt',
      label: 'Started',
      sortable: true,
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
      sortable: true,
      searchAccessor: (r) => r.status || '',
      render: (r) => <SessionStatusBadge status={r.status} />,
    },
    {
      key: 'clientIp',
      label: 'Client IP',
      hideBelow: 'lg',
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{r.clientIp || '-'}</span>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        { label: 'View Details', icon: Eye, onClick: (r) => openDetail(r.id) },
        ...(canTerminate
          ? [{
              label: 'Terminate',
              icon: Square,
              variant: 'destructive',
              onClick: (r) => r.status === 'ACTIVE' && setTerminateTarget(r),
            }]
          : []),
      ],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={TerminalIcon}
        title="Sessions"
        subtitle="Active and historical SSH/RDP sessions."
      helpKey="sessions" />

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

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        data={sessions}
        loading={loading}
        emptyMessage={activeTab === 'active' ? 'No active sessions.' : 'No sessions found.'}
        searchPlaceholder="Search server or user..."
        filters={filterSlot}
        serverPagination={{
          page,
          total,
          onPageChange: setPage,
          pageSize,
          onPageSizeChange: (size) => { setPageSize(size); setPage(1); },
        }}
      />

      <SessionDetailDrawer
        sessionId={detailId}
        open={detailOpen}
        onClose={() => { setDetailOpen(false); setDetailId(null); }}
      />

      <ConfirmDialog
        open={!!terminateTarget}
        title="Terminate Session"
        message={`Terminate the active session for ${
          terminateTarget?.user?.name || terminateTarget?.user?.email || 'this user'
        } on ${terminateTarget?.server?.hostname || terminateTarget?.server?.name || 'this server'}? The connection will be immediately closed.`}
        confirmLabel={terminating ? 'Terminating...' : 'Terminate'}
        variant="destructive"
        onConfirm={handleTerminate}
        onCancel={() => setTerminateTarget(null)}
      />
    </div>
  );
}

export default Sessions;
