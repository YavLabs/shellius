import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Clock,
  Copy,
  History,
  KeyRound,
  LayoutGrid,
  Loader2,
  MoreHorizontal,
  PlugZap,
  Save,
  Server,
  Square,
  SquareTerminal,
  Trash2,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import Skeleton from '@/components/ui/Skeleton';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import SaveServerModal from '@/components/quickConnect/SaveServerModal';
import RequestForm from '@/components/access-requests/RequestForm';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { getHistory, reconnectHistory, deleteHistory, clearHistory } from '@/services/quickConnectService';
import { getRecentServers, closeTerminalSession } from '@/services/terminalService';
import { getAccessIntents, getAccessRequest } from '@/services/accessRequestService';
import { sessionTabMeta } from '@/components/workspace/RunningSessionsList';
import { isServerOnboarded } from '@/lib/serverStatus';
import { relativeTime } from '@/utils/time';
import { cn } from '@/lib/utils';

const RECENT_LIMIT = 8;

const QC_AUTH = {
  password: { tone: 'neutral', label: 'Password' },
  key: { tone: 'info', label: 'Private key' },
};

function untilText(date) {
  const ms = new Date(date).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'soon';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'in under a minute';
  if (min < 60) return `in ${min} min`;
  return `in ${Math.floor(min / 60)} h ${min % 60} min`;
}

const btnPrimary =
  'inline-flex h-7 min-w-[5.5rem] shrink-0 items-center justify-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60';
const btnSecondary =
  'inline-flex h-7 min-w-[5.5rem] shrink-0 items-center justify-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60';

function RowMenu({ label, children }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function SectionHeader({ icon: Icon, title, hint, count }) {
  return (
    <div className="mb-1 mt-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{title}</span>
      {typeof count === 'number' && <span className="tabular-nums text-muted-foreground/70">{count}</span>}
      {hint && <span className="ml-auto font-normal text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

// Leading icon says what it is (server / Quick Connect / live terminal); the
// corner dot says its state.
function Row({ icon: Icon, iconTone = 'text-muted-foreground', dot, title, badges, sub, actions }) {
  return (
    <li className="flex items-center gap-3 border-b border-border/70 py-2.5 last:border-0">
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted" aria-hidden="true">
        <Icon className={cn('h-3.5 w-3.5', iconTone)} />
        {dot && <span className={cn('absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-card', dot)} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {title}
          {badges}
        </div>
        {sub && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </li>
  );
}

/**
 * RecentConnectionsWidget — the dashboard's "Recent connections" card.
 *
 *   Active now   your live terminal sessions: "Go to terminal" when one is
 *                open in a tab/Workspace, "Connect now" (re-attach) when it's
 *                running in the background. End from the row menu.
 *   Recent       the last 7 days: servers you connected to (from your own
 *                sessions) and Quick Connects (their history), newest first.
 *                Server rows show what your access allows *now*: Connect,
 *                Pending, or Request access. Quick Connect rows keep Connect
 *                again, Copy ssh command, Save as server, Remove.
 *
 * Everything is your own data only (both APIs are user-scoped).
 */
function RecentConnectionsWidget() {
  const navigate = useNavigate();
  const { allowed: qcAllowed, openQuickConnect } = useQuickConnect();
  const workspace = useTerminalWorkspace();
  const { liveSessions, refreshLiveSessions, tabs, groups, attachSession, openTab, openTabForAccessRequest } = workspace;

  const [servers, setServers] = useState([]);
  const [intents, setIntents] = useState({});
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [actionError, setActionError] = useState('');
  const [requestServerId, setRequestServerId] = useState(null);
  const [saveTarget, setSaveTarget] = useState(null);
  const [copiedId, setCopiedId] = useState('');
  const [endTarget, setEndTarget] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [srv, hist] = await Promise.all([
      getRecentServers({ days: 7, limit: RECENT_LIMIT }).catch(() => []),
      qcAllowed ? getHistory({ limit: RECENT_LIMIT }).catch(() => []) : Promise.resolve([]),
    ]);
    setServers(srv);
    setHistory(hist);
    setIntents(await getAccessIntents(srv.map((r) => r.server.id)).catch(() => ({})));
    setLoading(false);
  }, [qcAllowed]);

  useEffect(() => {
    load();
    refreshLiveSessions();
  }, [load, refreshLiveSessions]);

  // Where each live session is open ("Open in a tab" / Workspace name), if anywhere.
  const placeOf = useMemo(() => {
    const map = new Map();
    for (const t of tabs) {
      if (!t.sessionId) continue;
      const g = (groups || []).find((grp) => grp.panes.filter(Boolean).length >= 2 && grp.panes.includes(t.id));
      map.set(t.sessionId, g ? { label: g.name || 'Workspace', workspace: true } : { label: 'Open in a tab', workspace: false });
    }
    return map;
  }, [tabs, groups]);

  // Servers and Quick Connects merged into one list, newest first.
  const recent = useMemo(() => {
    const rows = [
      ...servers.map((r) => ({ kind: 'server', key: `s:${r.server.id}`, at: r.lastConnectedAt, ...r })),
      ...history.map((h) => ({ kind: 'qc', key: `q:${h.id}`, at: h.lastConnectedAt, item: h })),
    ];
    return rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, RECENT_LIMIT);
  }, [servers, history]);

  const active = liveSessions || [];

  // ── Actions ────────────────────────────────────────────────────────────────
  const withBusy = async (id, fn) => {
    setActionError('');
    setBusyId(id);
    try {
      await fn();
    } catch (err) {
      setActionError(err.response?.data?.error?.message || err.message || 'Something went wrong');
    } finally {
      setBusyId('');
    }
  };

  const connectServer = (server) =>
    withBusy(`s:${server.id}`, async () => {
      const intent = intents[server.id];
      const meta = { label: server.displayName || server.hostname, env: server.environment, host: server.ipAddress || server.hostname };
      if (intent?.hasActiveAccess && intent.activeRequestId) {
        openTab({ requestId: intent.activeRequestId }, meta);
      } else if (intent?.hasPendingRequest && intent.pendingRequestId) {
        openTabForAccessRequest(await getAccessRequest(intent.pendingRequestId), { ...meta, focus: true });
      } else {
        setRequestServerId(server.id);
      }
    });

  const reconnectQc = (item) => {
    if (item.authType !== 'credential') {
      openQuickConnect({ host: item.host, port: item.port, username: item.username, authTab: item.authType === 'key' ? 'key' : 'password' });
      return;
    }
    withBusy(`q:${item.id}`, async () => {
      try {
        const resp = await reconnectHistory(item.id);
        openTab({ ticket: resp.ticket }, { label: `${item.username || 'user'}@${item.host}`, host: item.host, username: item.username, focus: true });
      } catch (err) {
        if (err.response?.data?.error?.code === 'SECRET_REQUIRED') {
          openQuickConnect({ host: item.host, port: item.port, username: item.username, authTab: 'credential' });
          return;
        }
        throw err;
      }
    });
  };

  const copySsh = (item) => {
    navigator.clipboard
      ?.writeText(`ssh -p ${item.port} ${item.username}@${item.host}`)
      .then(() => {
        setCopiedId(item.id);
        setTimeout(() => setCopiedId(''), 1500);
      })
      .catch(() => {});
  };

  const removeQc = async (item) => {
    setHistory((prev) => prev.filter((h) => h.id !== item.id));
    try {
      await deleteHistory(item.id);
    } catch {
      load();
    }
  };

  const endSession = async () => {
    const s = endTarget;
    setEndTarget(null);
    if (!s) return;
    await withBusy(`a:${s.id}`, async () => {
      await closeTerminalSession(s.id);
      refreshLiveSessions();
    });
  };

  const doClear = async () => {
    setConfirmClear(false);
    await withBusy('clear', async () => {
      await clearHistory();
      setHistory([]);
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const empty = !loading && active.length === 0 && recent.length === 0;

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card p-5">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Recent connections</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Active sessions and the last 7 days</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {qcAllowed && (
            <button
              type="button"
              onClick={() => openQuickConnect()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Zap className="h-3.5 w-3.5" /> Quick connect
            </button>
          )}
          <RowMenu label="Recent connections options">
            <DropdownMenuItem onSelect={() => navigate('/terminals')}>
              <SquareTerminal className="mr-2 h-4 w-4" /> Open terminals
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate('/sessions')}>
              <History className="mr-2 h-4 w-4" /> Session history
            </DropdownMenuItem>
            {qcAllowed && history.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setConfirmClear(true)} className="text-destructive focus:text-destructive">
                  <Trash2 className="mr-2 h-4 w-4" /> Clear Quick Connect history
                </DropdownMenuItem>
              </>
            )}
          </RowMenu>
        </div>
      </div>

      {actionError && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {actionError}
        </div>
      )}

      {loading && active.length === 0 && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      )}

      {empty && (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <SquareTerminal className="mb-2 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm font-medium text-muted-foreground">No connections yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Servers and Quick Connects you use show up here.</p>
          <div className="mt-3 flex items-center gap-2">
            <button type="button" onClick={() => navigate('/servers')} className={btnSecondary}>
              <Server className="h-3.5 w-3.5" /> Browse servers
            </button>
            {qcAllowed && (
              <button type="button" onClick={() => openQuickConnect()} className={btnSecondary}>
                <Zap className="h-3.5 w-3.5" /> Quick connect
              </button>
            )}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {/* ── Active now ─────────────────────────────────────────────── */}
        {active.length > 0 && (
          <section aria-label="Active sessions">
            <SectionHeader icon={PlugZap} title="Active now" count={active.length} />
            <ul>
              {active.map((s) => {
                const place = placeOf.get(s.id);
                const name = s.label || s.server?.displayName || s.host;
                const busy = busyId === `a:${s.id}`;
                const sub = place
                  ? `${s.username}@${s.host} · ${place.label}`
                  : `${s.username}@${s.host} · ${s.state === 'detached' ? `in the background, closes ${untilText(s.endsAt)}` : 'open in another window'}`;
                return (
                  <Row
                    key={s.id}
                    icon={SquareTerminal}
                    iconTone="text-foreground"
                    dot={place ? 'bg-emerald-500' : 'bg-amber-500'}
                    title={<span className="truncate text-sm font-medium text-foreground">{name}</span>}
                    badges={
                      <>
                        {s.server?.environment && <EnvironmentBadge environment={s.server.environment} />}
                        {place?.workspace && <LayoutGrid className="h-3 w-3 text-muted-foreground" aria-label="In a workspace" />}
                      </>
                    }
                    sub={sub}
                    actions={
                      <>
                        {place ? (
                          <button type="button" className={btnSecondary} onClick={() => attachSession(s.id, sessionTabMeta(s))}>
                            <ArrowUpRight className="h-3.5 w-3.5" /> Go to terminal
                          </button>
                        ) : (
                          <button type="button" className={btnPrimary} disabled={busy} onClick={() => attachSession(s.id, sessionTabMeta(s))}>
                            <PlugZap className="h-3.5 w-3.5" /> Connect now
                          </button>
                        )}
                        <RowMenu label={`Options for ${name}`}>
                          <DropdownMenuItem onSelect={() => setEndTarget(s)} className="text-destructive focus:text-destructive">
                            <Square className="mr-2 h-4 w-4" /> End session
                          </DropdownMenuItem>
                        </RowMenu>
                      </>
                    }
                  />
                );
              })}
            </ul>
          </section>
        )}

        {/* ── Recent ─────────────────────────────────────────────────── */}
        {recent.length > 0 && (
          <section aria-label="Recent connections">
            <SectionHeader icon={History} title="Recent" hint="Last 7 days" />
            <ul>
              {recent.map((r) => {
                if (r.kind === 'server') {
                  const { server } = r;
                  const intent = intents[server.id];
                  const onboarded = isServerOnboarded(server);
                  const busy = busyId === r.key;
                  let action = { label: 'Request access', icon: KeyRound, cls: btnSecondary };
                  if (intent?.hasActiveAccess) action = { label: 'Connect', icon: PlugZap, cls: btnPrimary };
                  else if (intent?.hasPendingRequest) action = { label: 'Pending', icon: Clock, cls: btnSecondary };
                  const ActionIcon = action.icon;
                  return (
                    <Row
                      key={r.key}
                      icon={Server}
                      dot={intent?.hasActiveAccess ? 'bg-emerald-500' : intent?.hasPendingRequest ? 'bg-amber-500' : null}
                      title={
                        <Link to={`/servers/${server.id}`} className="truncate text-sm font-medium text-foreground hover:underline">
                          {server.displayName || server.hostname}
                        </Link>
                      }
                      badges={<EnvironmentBadge environment={server.environment} />}
                      sub={
                        <>
                          {server.ipAddress || server.hostname} · {relativeTime(r.lastConnectedAt)}
                          {r.connectCount > 1 && ` · ×${r.connectCount}`}
                          {intent?.hasActiveAccess && intent.expiresAt && ` · access ends ${untilText(intent.expiresAt)}`}
                        </>
                      }
                      actions={
                        <>
                          <button
                            type="button"
                            className={action.cls}
                            disabled={busy || !onboarded}
                            title={!onboarded ? "This server hasn't finished onboarding yet." : undefined}
                            onClick={() => connectServer(server)}
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ActionIcon className="h-3.5 w-3.5" />}
                            {action.label}
                          </button>
                          <RowMenu label={`Options for ${server.displayName || server.hostname}`}>
                            <DropdownMenuItem onSelect={() => navigate(`/servers/${server.id}`)}>
                              <Server className="mr-2 h-4 w-4" /> View server
                            </DropdownMenuItem>
                            {!intent?.hasActiveAccess && !intent?.hasPendingRequest ? null : (
                              <DropdownMenuItem onSelect={() => setRequestServerId(server.id)}>
                                <KeyRound className="mr-2 h-4 w-4" /> New access request
                              </DropdownMenuItem>
                            )}
                          </RowMenu>
                        </>
                      }
                    />
                  );
                }
                const item = r.item;
                const failed = item.lastStatus === 'failed';
                const auth = item.authType === 'credential' ? null : QC_AUTH[item.authType] || { tone: 'neutral', label: item.authType || 'Unknown' };
                const busy = busyId === r.key;
                return (
                  <Row
                    key={r.key}
                    icon={Zap}
                    iconTone="text-amber-500"
                    dot={failed ? 'bg-red-500' : null}
                    title={
                      <span className="truncate font-mono text-[13px] text-foreground" title={failed ? item.lastError : undefined}>
                        {item.username}@{item.host}
                        {item.port !== 22 ? `:${item.port}` : ''}
                      </span>
                    }
                    badges={
                      <>
                        {auth ? <Badge tone={auth.tone}>{auth.label}</Badge> : <Badge tone="accent">{item.credential?.name || 'Identity'}</Badge>}
                      </>
                    }
                    sub={
                      <>
                        {item.server ? `${item.server.displayName || item.server.hostname} · ` : ''}
                        {failed ? 'failed ' : ''}
                        {relativeTime(item.lastConnectedAt)}
                        {item.connectCount > 1 && ` · ×${item.connectCount}`}
                      </>
                    }
                    actions={
                      <>
                        <button type="button" className={btnSecondary} disabled={busy} onClick={() => reconnectQc(item)}>
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                          Connect again
                        </button>
                        <RowMenu label={`Options for ${item.username}@${item.host}`}>
                          <DropdownMenuItem onSelect={() => copySsh(item)}>
                            {copiedId === item.id ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                            Copy ssh command
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setSaveTarget({ host: item.host, port: item.port, username: item.username })}>
                            <Save className="mr-2 h-4 w-4" /> Save as server…
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => removeQc(item)} className="text-destructive focus:text-destructive">
                            <Trash2 className="mr-2 h-4 w-4" /> Remove from history
                          </DropdownMenuItem>
                        </RowMenu>
                      </>
                    }
                  />
                );
              })}
            </ul>
          </section>
        )}
      </div>

      {requestServerId && (
        <RequestForm
          open={!!requestServerId}
          initialServerId={requestServerId}
          onClose={() => setRequestServerId(null)}
          onSuccess={(created) => {
            setRequestServerId(null);
            // Auto-approved → straight into a terminal tab; otherwise a status tab.
            if (created) openTabForAccessRequest(created, { focus: true });
            load();
          }}
        />
      )}

      <ConfirmDialog
        open={!!endTarget}
        title="End session"
        message={`This immediately closes the SSH connection to ${endTarget?.label || endTarget?.host || 'this host'} for everyone attached to it. This can't be undone.`}
        confirmLabel="End session"
        variant="destructive"
        onConfirm={endSession}
        onCancel={() => setEndTarget(null)}
      />

      <ConfirmDialog
        open={confirmClear}
        title="Clear Quick Connect history"
        message="This removes all of your Quick Connect history rows. This can't be undone."
        confirmLabel="Clear history"
        variant="destructive"
        onConfirm={doClear}
        onCancel={() => setConfirmClear(false)}
      />

      <SaveServerModal open={!!saveTarget} onClose={() => setSaveTarget(null)} connection={saveTarget} onSaved={() => setSaveTarget(null)} />
    </div>
  );
}

export default RecentConnectionsWidget;
