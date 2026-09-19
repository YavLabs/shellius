import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Film,
  Terminal as TerminalIcon,
  Eye,
  Square,
  Download,
  ListOrdered,
  Zap,
  Loader2,
  ExternalLink,
  X,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import ServerName, { serverSearchString } from '@/components/shared/ServerName';
import Badge from '@/components/shared/Badge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import UserCell from '@/components/shared/UserCell';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import SessionPlayer from '@/components/sessions/SessionPlayer';
import PageHeader from '@/components/common/PageHeader';
import SearchableSelect from '@/components/ui/SearchableSelect';
import ConnectModal from '@/components/servers/ConnectModal';
import { listSessions, listActiveSessions, getSession, terminateSession, downloadRecording } from '@/services/sessionService';
import { listTerminalSessions } from '@/services/terminalService';
import { getAccessIntent } from '@/services/accessRequestService';
import { useAuth } from '@/context/AuthContext';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { relativeTime, formatDateTime } from '@/utils/time';
import { extractCommands, formatOffset } from '@/utils/castCommands';
import { SESSION_STATUS_LABELS } from '@/lib/labels';
import { can } from '@/lib/permissions';

// A session row is "connectable" from this page when it's the caller's own
// still-ACTIVE session — matches the terminal hub's "caller's own sessions
// only" scoping (docs/terminal-workspace.md REST section).
function isOwnActiveSession(session, user) {
  return session?.status === 'ACTIVE' && !!user && (session.user?.id === user.id || session.userId === user.id);
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

const AUTH_METHOD_LABEL = {
  certificate: 'Certificate',
  credential: 'Identity',
  quick_connect: 'Quick Connect',
};

function AuthMethodBadge({ authMethod }) {
  if (!authMethod) return <span className="text-muted-foreground">-</span>;
  return <Badge variant="default">{AUTH_METHOD_LABEL[authMethod] || authMethod}</Badge>;
}

/**
 * SessionTarget — renders the server name, or for Quick Connect sessions
 * (server: null) the ad-hoc target host/user, with a "Quick Connect" badge.
 */
function SessionTarget({ session }) {
  if (!session.server && session.authMethod === 'quick_connect') {
    const host = session.targetHost || session.host;
    const port = session.targetPort || session.port;
    const targetUser = session.targetUser || session.principal;
    return (
      <div className="flex flex-col leading-tight">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <span className="font-mono">
            {targetUser ? `${targetUser}@` : ''}
            {host || 'unknown host'}
            {port && port !== 22 ? `:${port}` : ''}
          </span>
        </span>
        <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
          <Zap className="h-2.5 w-2.5" /> Quick Connect
        </span>
      </div>
    );
  }
  return <ServerName server={session.server} fallback={session.serverId} />;
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

/**
 * useSessionConnect — shared "Connect" behavior for own-ACTIVE session rows,
 * used by both the table row action and the detail drawer. Before attaching,
 * checks GET /api/terminal/sessions: a stale ACTIVE row (e.g. surviving a
 * backend/hub restart) isn't actually live in the hub, so this offers a
 * reconnect path instead of attaching to nothing.
 */
function useSessionConnect() {
  const workspace = useTerminalWorkspace();
  const { openQuickConnect } = useQuickConnect();
  const [checkingId, setCheckingId] = useState('');
  const [staleInfo, setStaleInfo] = useState(null); // { message, reconnect?: fn }
  const [connectTarget, setConnectTarget] = useState(null); // { server, intent }

  const connect = useCallback(
    async (session) => {
      setStaleInfo(null);
      setCheckingId(session.id);
      try {
        const live = await listTerminalSessions();
        if (live.some((s) => s.id === session.id)) {
          const isQuickConnect = session.authMethod === 'quick_connect';
          workspace.attachSession(session.id, {
            label: session.server
              ? session.server.displayName || session.server.hostname
              : isQuickConnect
                ? `${session.targetUser || session.principal || 'user'}@${session.targetHost || session.host}`
                : undefined,
            env: session.server?.environment,
            host: session.server?.ipAddress || session.server?.hostname || session.targetHost || session.host,
            username: session.principal || session.targetUser,
          });
          return;
        }

        // Stale — the row says ACTIVE but the hub no longer has it live.
        if (session.authMethod === 'quick_connect') {
          setStaleInfo({
            message: 'This session is no longer running — start a new connection.',
            reconnect: () => {
              setStaleInfo(null);
              openQuickConnect({
                host: session.targetHost || session.host,
                port: session.targetPort || session.port,
                username: session.targetUser || session.principal,
              });
            },
          });
          return;
        }
        if (session.server?.id) {
          const intent = await getAccessIntent(session.server.id);
          if (intent?.hasActiveAccess && intent.activeRequestId) {
            setStaleInfo({
              message: 'This session is no longer running — start a new connection.',
              reconnect: () => {
                setStaleInfo(null);
                setConnectTarget({ server: session.server, intent });
              },
            });
          } else {
            setStaleInfo({
              message:
                'This session is no longer running, and there is no active access request to reconnect with.',
            });
          }
          return;
        }
        setStaleInfo({ message: 'This session is no longer running — start a new connection.' });
      } catch (err) {
        setStaleInfo({ message: err.response?.data?.error?.message || 'Failed to check session status.' });
      } finally {
        setCheckingId('');
      }
    },
    [workspace, openQuickConnect]
  );

  const openInNewWindow = useCallback((session) => {
    window.open(`/terminal?attach=${encodeURIComponent(session.id)}`, '_blank');
  }, []);

  return { connect, openInNewWindow, checkingId, staleInfo, dismissStale: () => setStaleInfo(null), connectTarget, setConnectTarget };
}

function StaleSessionBanner({ staleInfo, onDismiss }) {
  if (!staleInfo) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
      <span>{staleInfo.message}</span>
      <div className="flex shrink-0 items-center gap-3">
        {staleInfo.reconnect && (
          <button type="button" onClick={staleInfo.reconnect} className="text-xs font-medium underline">
            Reconnect
          </button>
        )}
        <button type="button" onClick={onDismiss} className="text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-300">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
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

/**
 * SessionCommands
 *
 * Renders the best-effort list of commands run during a session, derived from
 * the .cast recording text (see utils/castCommands). Commands are heuristically
 * parsed from echoed prompt lines, so the heading is labelled "detected".
 */
function SessionCommands({ castText }) {
  const commands = useMemo(() => extractCommands(castText), [castText]);

  if (!castText) return null;

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <ListOrdered className="h-3.5 w-3.5" />
        Commands ({commands.length})
        <span className="ml-1 normal-case tracking-normal text-[11px] text-muted-foreground/70">
          best-effort, parsed from terminal output
        </span>
      </div>
      {commands.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          No commands detected in this recording.
        </div>
      ) : (
        <ol className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/20 font-mono text-xs">
          {commands.map((c, i) => (
            <li
              key={i}
              className="flex items-start gap-3 border-b border-border/60 px-3 py-1.5 last:border-0"
            >
              <span className="shrink-0 select-none tabular-nums text-muted-foreground/60">
                {formatOffset(c.time)}
              </span>
              <span className="break-all text-foreground">{c.command}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function SessionDetailDrawer({ sessionId, open, onClose, currentUser, sessionConnect }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [castText, setCastText] = useState(null);

  useEffect(() => {
    if (!sessionId || !open) return;
    setLoading(true);
    setError('');
    setCastText(null);
    getSession(sessionId)
      .then((resp) => setSession(resp.data || resp))
      .catch((err) => setError(err.response?.data?.error?.message || 'Failed to load session.'))
      .finally(() => setLoading(false));
  }, [sessionId, open]);

  return (
    <Modal open={open} onClose={onClose} title="Session details" size="lg">
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
      {!loading && (
        <div className="mb-3">
          <StaleSessionBanner staleInfo={sessionConnect.staleInfo} onDismiss={sessionConnect.dismissStale} />
        </div>
      )}
      {!loading && session && isOwnActiveSession(session, currentUser) && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
          <span className="text-xs text-emerald-700 dark:text-emerald-400">This is your active session.</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={sessionConnect.checkingId === session.id}
              onClick={() => sessionConnect.connect(session)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {sessionConnect.checkingId === session.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <TerminalIcon className="h-3.5 w-3.5" />
              )}
              Connect
            </button>
            <button
              type="button"
              onClick={() => sessionConnect.openInNewWindow(session)}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium text-foreground hover:bg-accent"
            >
              <ExternalLink className="h-3.5 w-3.5" /> New window
            </button>
          </div>
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
              ) : session.authMethod === 'quick_connect' ? (
                <SessionTarget session={session} />
              ) : (
                <span className="italic text-muted-foreground">unknown server</span>
              )
            }
          />
          <DetailRow label="Auth method" value={<AuthMethodBadge authMethod={session.authMethod} />} />
          <DetailRow label="User" value={<UserCell user={session.user} fallback="Unknown user" />} />
          <DetailRow label="Protocol" value={session.protocol} />
          <DetailRow label="Client IP" value={session.clientIp} />
          <DetailRow label="Principal" value={session.principal} />
          <DetailRow label="Started at" value={formatDateTime(session.startedAt)} />
          <DetailRow label="Ended at" value={formatDateTime(session.endedAt)} />
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
              label="Terminated by"
              value={session.terminatedBy?.name || session.terminatedBy?.email || 'Unknown'}
            />
          )}
        </dl>
      )}
      {!loading && session && (session.recordingKey || session.recordingPath) && !can(currentUser, 'sessions.view_recordings') && (
        <p className="mt-4 text-xs text-muted-foreground">
          A recording exists for this session. Watching recordings needs its own permission.
        </p>
      )}
      {!loading && session && (session.recordingKey || session.recordingPath) && can(currentUser, 'sessions.view_recordings') && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Film className="h-3.5 w-3.5" />
              Session replay
            </div>
            <button
              onClick={() => downloadRecording(session.id)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Download className="h-3.5 w-3.5" /> Download .cast
            </button>
          </div>
          <SessionPlayer sessionId={session.id} onCast={setCastText} />
          <SessionCommands castText={castText} />
        </div>
      )}
      {!loading && session && !session.recordingKey && !session.recordingPath && (
        <div className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {session.status === 'ACTIVE'
            ? 'Recording is in progress — available once the session ends.'
            : session.sessionType === 'RDP'
              ? 'Replay is not available for RDP sessions.'
              : 'No recording was captured for this session.'}
        </div>
      )}
    </Modal>
  );
}

const TABS = [
  { key: 'all', label: 'All sessions' },
  { key: 'active', label: 'Active' },
];

const SESSION_STATUSES = ['ACTIVE', 'ENDED', 'TERMINATED'];

function Sessions() {
  const { user } = useAuth();
  const canTerminate = can(user, 'sessions.terminate');
  const sessionConnect = useSessionConnect();

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
    <SearchableSelect
      className="w-[160px]"
      value={statusFilter}
      onChange={(v) => { setStatusFilter(v); setPage(1); }}
      options={[
        { value: '', label: 'All statuses' },
        ...SESSION_STATUSES.map((s) => ({ value: s, label: SESSION_STATUS_LABELS[s] || s })),
      ]}
      placeholder="All statuses"
      searchable={false}
      clearable={false}
    />
  ) : null;

  const columns = [
    {
      key: 'server',
      label: 'Server',
      sortable: true,
      searchAccessor: (r) =>
        r.server ? serverSearchString(r.server) : `${r.targetUser || ''} ${r.targetHost || r.host || ''}`,
      render: (r) => (
        <div className="flex items-center gap-2">
          <SessionTarget session={r} />
          {r.server?.environment && <EnvironmentBadge environment={r.server.environment} />}
          {(r.recordingKey || r.recordingPath) && can(user, 'sessions.view_recordings') && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openDetail(r.id); }}
              title="Play recording"
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Film className="h-3.5 w-3.5" />
            </button>
          )}
          {isOwnActiveSession(r, user) && (
            <button
              type="button"
              disabled={sessionConnect.checkingId === r.id}
              onClick={(e) => { e.stopPropagation(); sessionConnect.connect(r); }}
              title="Open in Terminals"
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] font-medium text-foreground hover:bg-accent disabled:opacity-60"
            >
              {sessionConnect.checkingId === r.id ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <TerminalIcon className="h-3 w-3" />
              )}
              Connect
            </button>
          )}
        </div>
      ),
    },
    {
      key: 'user',
      label: 'User',
      sortable: true,
      searchAccessor: (r) => r.user?.name || r.user?.email || '',
      render: (r) => <UserCell user={r.user} fallback={r.userId || 'Unknown user'} />,
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
      key: 'authMethod',
      label: 'Auth',
      hideBelow: 'md',
      render: (r) => <AuthMethodBadge authMethod={r.authMethod} />,
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
        {
          label: 'Connect',
          icon: TerminalIcon,
          hidden: (r) => !isOwnActiveSession(r, user),
          onClick: (r) => sessionConnect.connect(r),
        },
        {
          label: 'Open in new window',
          icon: ExternalLink,
          hidden: (r) => !isOwnActiveSession(r, user),
          onClick: (r) => sessionConnect.openInNewWindow(r),
        },
        { label: 'View details', icon: Eye, onClick: (r) => openDetail(r.id) },
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

      <StaleSessionBanner staleInfo={sessionConnect.staleInfo} onDismiss={sessionConnect.dismissStale} />

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
        currentUser={user}
        sessionConnect={sessionConnect}
      />

      <ConfirmDialog
        open={!!terminateTarget}
        title="Terminate session"
        message={`Terminate the active session for ${
          terminateTarget?.user?.name || terminateTarget?.user?.email || 'this user'
        } on ${terminateTarget?.server?.hostname || terminateTarget?.server?.name || 'this server'}? The connection will be immediately closed.`}
        confirmLabel={terminating ? 'Terminating...' : 'Terminate'}
        variant="destructive"
        onConfirm={handleTerminate}
        onCancel={() => setTerminateTarget(null)}
      />

      {sessionConnect.connectTarget && (
        <ConnectModal
          open={!!sessionConnect.connectTarget}
          onClose={() => sessionConnect.setConnectTarget(null)}
          server={sessionConnect.connectTarget.server}
          intent={sessionConnect.connectTarget.intent}
          currentUser={user}
        />
      )}
    </div>
  );
}

export default Sessions;
