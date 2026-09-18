import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Circle, Loader, Monitor, RefreshCw, Save, Server, Square, User, Zap } from 'lucide-react';
import TerminalView from '@/components/terminal/TerminalView';
import RdpTerminal from '@/components/terminal/RdpTerminal';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { Badge } from '@/components/ui/badge';
import SaveServerModal from '@/components/quickConnect/SaveServerModal';
import { getAccessRequest } from '@/services/accessRequestService';

function StatusIndicator({ state }) {
  if (state === 'connecting') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-amber-500 dark:text-amber-400">
        <Loader className="h-3 w-3 animate-spin" /> Connecting
      </span>
    );
  }
  if (state === 'live') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-emerald-500 dark:text-emerald-400">
        <Circle className="h-2.5 w-2.5 fill-current" /> Connected
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
      <Circle className="h-2.5 w-2.5 fill-current" /> {state === 'ended' ? 'Session ended' : 'Disconnected'}
    </span>
  );
}

/**
 * Terminal — full-screen standalone terminal window (no app chrome). Used
 * for "Open in new window" from the workspace (`?attach=<sessionId>`) and
 * for connect flows that intentionally open a separate tab/window
 * (ticket / requestId). Closing/Back only detaches a session — it keeps
 * running in the hub and can be re-attached from /terminals.
 */
function Terminal() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get('requestId');
  const ticket = searchParams.get('ticket');
  const attach = searchParams.get('attach');
  const label = searchParams.get('label');
  const principal = searchParams.get('principal');

  const [request, setRequest] = useState(null);
  const [loadingRequest, setLoadingRequest] = useState(!!requestId);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [state, setState] = useState('connecting');
  const [endedReason, setEndedReason] = useState('');
  const [hostKey, setHostKey] = useState(null);
  const [sessionInfo, setSessionInfo] = useState(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const viewRef = useRef(null);

  useEffect(() => {
    if (!requestId) {
      setLoadingRequest(false);
      return;
    }
    setLoadingRequest(true);
    getAccessRequest(requestId)
      .then((resp) => setRequest(resp.data || resp))
      .catch(() => {})
      .finally(() => setLoadingRequest(false));
  }, [requestId]);

  const isQuickConnect = !!ticket;

  const handleBack = () => {
    // Unmounting TerminalView closes only this socket — the hub session (if
    // any) keeps running and can be re-attached from /terminals.
    navigate(ticket ? '/servers' : attach ? '/terminals' : '/access-requests');
  };

  const handleEndSession = () => {
    viewRef.current?.close();
  };

  const handleReconnect = () => {
    if (isQuickConnect) {
      navigate('/servers');
      return;
    }
    setState('connecting');
    setReconnectNonce((n) => n + 1);
  };

  if (!requestId && !ticket && !attach) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-sm text-muted-foreground">No request ID, ticket or session to attach was provided.</p>
          <button onClick={() => navigate('/terminals')} className="text-xs text-primary hover:underline">
            Go to Terminals
          </button>
        </div>
      </div>
    );
  }

  // Quick Connect tickets and attach targets are SSH-only. AR sessions may
  // be RDP.
  const protocol = ticket || attach ? 'SSH' : request?.protocol || 'SSH';
  const isRdp = !ticket && !attach && protocol === 'RDP';

  const serverName = attach
    ? label || sessionInfo?.host || 'Terminal'
    : ticket
      ? label || 'Quick Connect'
      : request?.server?.hostname || request?.server?.name || request?.serverId || 'Unknown server';
  const userName =
    !ticket && !attach && (request?.requester?.name || request?.requester?.email || request?.requesterId || '');
  const environment = request?.server?.environment;
  const ProtocolIcon = isRdp ? Monitor : Server;

  const connect = attach
    ? { attach }
    : ticket
      ? { ticket, _n: reconnectNonce }
      : { requestId, principal: principal || undefined, _n: reconnectNonce };

  const saveConnection = sessionInfo
    ? {
        host: sessionInfo.host,
        port: sessionInfo.port,
        username: sessionInfo.username,
        hostKeyFingerprint: hostKey?.fingerprint,
        hostKeyAlgorithm: hostKey?.algorithm,
      }
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={handleBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <span className="text-border">|</span>
          {loadingRequest ? (
            <div className="h-5 w-48 animate-pulse rounded bg-muted" />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <ProtocolIcon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">{serverName}</span>
              {environment && <EnvironmentBadge environment={environment} />}
              {isRdp && <Badge tone="info">RDP</Badge>}
              {ticket && <Badge tone="warning" icon={Zap}>Quick connect</Badge>}
              {attach && <Badge tone="accent">Re-attached</Badge>}
              {userName && (
                <>
                  <span className="text-border">·</span>
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{userName}</span>
                </>
              )}
              {!isRdp && <StatusIndicator state={state} />}
              {hostKey?.fingerprint && (
                <span className="font-mono text-[11px] text-muted-foreground" title={`Host key (${hostKey.algorithm || 'unknown'}) — ${hostKey.status}`}>
                  {hostKey.fingerprint}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isQuickConnect && state === 'live' && (
            <button
              onClick={() => setSaveOpen(true)}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground bg-accent/60 hover:bg-accent transition-colors"
            >
              <Save className="h-3 w-3" /> Save as server
            </button>
          )}
          {state === 'ended' && !isQuickConnect && (
            <button
              onClick={handleReconnect}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground bg-accent/60 hover:bg-accent transition-colors"
            >
              <RefreshCw className="h-3 w-3" /> Reconnect
            </button>
          )}
          {!isRdp && state !== 'ended' && (
            <button
              onClick={handleEndSession}
              className="flex items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Square className="h-3 w-3" /> End session
            </button>
          )}
          <button
            onClick={handleBack}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 rounded-lg border border-border overflow-hidden">
        {loadingRequest ? (
          <div className="flex h-full items-center justify-center bg-[#0a0a0a]">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
          </div>
        ) : isRdp ? (
          <RdpTerminal requestId={requestId} />
        ) : (
          <TerminalView
            ref={viewRef}
            connect={connect}
            onSession={setSessionInfo}
            onHostKey={setHostKey}
            onStateChange={(s, extra) => {
              setState(s);
              if (s === 'ended') setEndedReason(extra || '');
            }}
          />
        )}
      </div>

      {state === 'ended' && endedReason && (
        <p className="shrink-0 text-xs text-muted-foreground">Reason: {endedReason}</p>
      )}

      {isQuickConnect && (
        <SaveServerModal open={saveOpen} onClose={() => setSaveOpen(false)} connection={saveConnection} />
      )}
    </div>
  );
}

export default Terminal;
