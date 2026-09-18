import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Clock, KeyRound, Loader2, PlugZap, RefreshCw, ServerCrash, X, Zap } from 'lucide-react';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import RequestForm from '@/components/access-requests/RequestForm';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { getSessionRecovery, reconnectSession } from '@/services/terminalService';
import { formatDateTime } from '@/utils/time';

// Why the session is gone, in plain words. Keys are hub end reasons plus the
// client-side 'not_found' / 'forbidden' from a failed re-attach.
const REASONS = {
  server_restart: { title: 'Shellius restarted', body: 'The server restarted, so this session was closed.', icon: ServerCrash },
  shutdown: { title: 'Shellius restarted', body: 'The server was shut down or redeployed, so this session was closed.', icon: ServerCrash },
  not_found: { title: 'Session is no longer running', body: 'Shellius may have restarted, or the session timed out while detached.', icon: ServerCrash },
  detached_timeout: { title: 'Session timed out', body: 'It was closed after being detached for too long.', icon: Clock },
  expired: { title: 'Access ended', body: 'Your access to this server expired or was revoked, so the session was closed.', icon: Clock },
  terminated: { title: 'Session terminated', body: 'An administrator ended this session.', icon: AlertTriangle },
  revoked: { title: 'Signed out', body: 'Your sessions were signed out, so this terminal was closed.', icon: AlertTriangle },
  exit: { title: 'Session ended', body: 'The remote shell exited.', icon: PlugZap },
  closed: { title: 'Session ended', body: 'The session was closed.', icon: PlugZap },
  error: { title: 'Connection dropped', body: 'The SSH connection to the host failed.', icon: AlertTriangle },
  forbidden: { title: 'Session unavailable', body: 'This session belongs to someone else.', icon: AlertTriangle },
};

const primaryBtn =
  'inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60';
const secondaryBtn =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-60';

/**
 * SessionRecoveryCard — shown over a workspace pane whose terminal lost its
 * session (state 'lost' or 'ended'), or never connected ('error').
 *
 * Asks the backend (GET /terminal/sessions/:id/recovery) what happened and
 * what will work now, based on the user's *current* access, then offers
 * exactly that. Every action reuses this tab, so its place and split are
 * kept:
 *   Reattach / Reconnect    new connect spec for this tab
 *   View request            tab becomes the pending request's status tab
 *   Request access again    RequestForm; auto-approved → connect, else a status tab
 *   Quick Connect again     prefilled dialog (one-off secrets are never stored)
 *   Close tab               always available
 * A connect that failed before any session existed (bad host, auth failure)
 * gets Retry (access-request tabs) or Quick Connect again (ticket tabs).
 */
function SessionRecoveryCard({ tab }) {
  const { reconnectTab, convertTabToRequest, closeTab } = useTerminalWorkspace();
  const { allowed: quickConnectAllowed, openQuickConnect } = useQuickConnect();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(!!tab.sessionId);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [requestOpen, setRequestOpen] = useState(false);

  const load = useCallback(async () => {
    if (!tab.sessionId) return;
    setLoading(true);
    try {
      setInfo(await getSessionRecovery(tab.sessionId));
      setUnreachable(false);
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        setInfo({ action: 'none', actionDetail: 'This session no longer exists.' });
        setUnreachable(false);
      } else {
        setUnreachable(true); // backend still restarting / network down
      }
    } finally {
      setLoading(false);
    }
  }, [tab.sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  // While Shellius is unreachable (mid-restart), keep checking.
  useEffect(() => {
    if (!unreachable) return undefined;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [unreachable, load]);

  const label = tab.label;

  const doReconnect = async () => {
    setBusy(true);
    setActionError('');
    try {
      const connect = await reconnectSession(tab.sessionId);
      reconnectTab(tab.id, connect);
    } catch (err) {
      setActionError(err.response?.data?.error?.message || err.message || 'Could not reconnect.');
      load();
    } finally {
      setBusy(false);
    }
  };

  const openQc = (prefill) => {
    openQuickConnect({ ...prefill, replaceTabId: tab.id });
  };

  const reasonKey = tab.state === 'error' ? null : info?.endReason || tab.endReason || 'not_found';
  const reason = reasonKey ? REASONS[reasonKey] || REASONS.closed : null;
  const Icon = reason?.icon || AlertTriangle;
  const server = info?.server;

  // ---- Failed before any session existed ---------------------------------
  if (tab.state === 'error' && !tab.sessionId) {
    const isRequest = !!tab.connect?.requestId;
    return (
      <Shell>
        <Header icon={AlertTriangle} title="Couldn’t connect" label={label} env={tab.env} />
        <p className="mt-2 text-xs text-muted-foreground">{tab.error || 'The connection failed.'}</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {isRequest && (
            <button type="button" className={primaryBtn} onClick={() => reconnectTab(tab.id, { requestId: tab.connect.requestId, principal: tab.connect.principal })}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          )}
          {!isRequest && quickConnectAllowed && tab.host && (
            <button
              type="button"
              className={primaryBtn}
              onClick={() => openQc({ host: tab.host, port: tab.port, username: tab.username })}
            >
              <Zap className="h-3.5 w-3.5" /> Edit and retry
            </button>
          )}
          <button type="button" className={secondaryBtn} onClick={() => closeTab(tab.id)}>
            <X className="h-3.5 w-3.5" /> Close tab
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <Header icon={Icon} title={reason.title} label={server?.displayName || server?.hostname || label} env={server?.environment || tab.env} />
      <p className="mt-2 text-xs text-muted-foreground">{reason.body}</p>

      {loading && !info && (
        <p className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking your access…
        </p>
      )}

      {unreachable && (
        <p className="mt-4 flex items-center justify-center gap-2 text-xs text-amber-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Can’t reach Shellius yet. Checking again every few seconds…
        </p>
      )}

      {info && !unreachable && (
        <>
          {info.actionDetail && <p className="mt-3 text-xs text-foreground">{info.actionDetail}</p>}
          {info.action === 'reconnect' && info.accessExpiresAt && (
            <p className="mt-1 text-[11px] text-muted-foreground">Access valid until {formatDateTime(info.accessExpiresAt)}</p>
          )}
          {(info.action === 'reconnect' || info.action === 'attach') && info.endReason && info.endReason !== 'exit' && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {info.action === 'attach' ? 'The session is still running.' : 'This starts a new shell. Anything running in the old one has stopped.'}
            </p>
          )}
        </>
      )}

      {actionError && <p className="mt-3 text-xs text-destructive">{actionError}</p>}

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {info?.action === 'attach' && (
          <button type="button" className={primaryBtn} onClick={() => reconnectTab(tab.id, { attach: tab.sessionId })}>
            <PlugZap className="h-3.5 w-3.5" /> Reattach
          </button>
        )}
        {info?.action === 'reconnect' && (
          <button type="button" className={primaryBtn} disabled={busy} onClick={doReconnect}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Reconnect
          </button>
        )}
        {info?.action === 'pending' && (
          <button type="button" className={primaryBtn} onClick={() => convertTabToRequest(tab.id, { id: info.requestId, server })}>
            <Clock className="h-3.5 w-3.5" /> View request
          </button>
        )}
        {info?.action === 'request_access' && server && (
          <button type="button" className={primaryBtn} onClick={() => setRequestOpen(true)}>
            <KeyRound className="h-3.5 w-3.5" /> Request access again
          </button>
        )}
        {info?.action === 'quick_connect' && quickConnectAllowed && (
          <button type="button" className={primaryBtn} onClick={() => openQc(info.prefill)}>
            <Zap className="h-3.5 w-3.5" /> Quick Connect again
          </button>
        )}
        {unreachable && (
          <button type="button" className={secondaryBtn} onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" /> Check now
          </button>
        )}
        <button type="button" className={secondaryBtn} onClick={() => closeTab(tab.id)}>
          <X className="h-3.5 w-3.5" /> Close tab
        </button>
      </div>

      {requestOpen && server && (
        <RequestForm
          open={requestOpen}
          onClose={() => setRequestOpen(false)}
          initialServerId={server.id}
          onSuccess={(created) => {
            setRequestOpen(false);
            if (!created) return;
            // Auto-approved (non-prod policy, or an admin's audited prod
            // bypass) → connect in this tab; otherwise wait for approval here.
            if (created.status === 'APPROVED') {
              reconnectTab(tab.id, { requestId: created.id }, { env: server.environment });
            } else {
              convertTabToRequest(tab.id, created, { env: server.environment });
            }
          }}
        />
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-background/85 p-6 backdrop-blur-[2px]">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 text-center shadow-sm">{children}</div>
    </div>
  );
}

function Header({ icon: Icon, title, label, env }) {
  return (
    <>
      <Icon className="mx-auto h-7 w-7 text-muted-foreground/70" aria-hidden="true" />
      <p className="mt-2 text-sm font-semibold text-foreground">{title}</p>
      {label && (
        <div className="mt-1 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{label}</span>
          {env && <EnvironmentBadge environment={env} />}
        </div>
      )}
    </>
  );
}

export default SessionRecoveryCard;
