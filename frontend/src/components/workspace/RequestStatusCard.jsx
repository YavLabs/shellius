import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, RefreshCw, CheckCircle2, XCircle, Loader2, PlugZap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { statusTone } from '@/lib/badgeTones';
import { getAccessRequest } from '@/services/accessRequestService';
import { formatDateTime } from '@/utils/time';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import RequestForm from '@/components/access-requests/RequestForm';

const POLL_MS = 10000;

/**
 * RequestStatusCard — content of a `kind: 'request'` workspace tab. Polls
 * the access request every 10s while PENDING, converts the tab into a
 * terminal (via convertRequestTabToTerminal) once approved, either
 * automatically (if this tab is the focused one) or on demand via Connect.
 */
function RequestStatusCard({ tab, focused }) {
  const { convertRequestTabToTerminal, closeTab, openTabForAccessRequest, setTabState } = useTerminalWorkspace();
  const [ar, setAr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [reRequestOpen, setReRequestOpen] = useState(false);
  const autoConnectedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await getAccessRequest(tab.accessRequestId);
      setAr(data);
      setErr('');
      // Reflects into the tab bar's status dot (amber while pending, red for
      // denied/revoked, muted for expired). APPROVED is intentionally not
      // set here — the tab converts to a terminal tab on connect, at which
      // point TerminalView's own connecting/live/ended states take over.
      if (data?.status && data.status !== 'APPROVED') {
        setTabState(tab.id, data.status.toLowerCase());
      }
    } catch (e) {
      setErr(e.response?.data?.error?.message || e.message || 'Failed to load access request');
    } finally {
      setLoading(false);
    }
  }, [tab.accessRequestId, tab.id, setTabState]);

  useEffect(() => {
    autoConnectedRef.current = false;
    load();
  }, [load]);

  useEffect(() => {
    if (!ar || ar.status !== 'PENDING') return undefined;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [ar, load]);

  const connect = useCallback(() => {
    if (!ar || autoConnectedRef.current) return;
    autoConnectedRef.current = true;
    convertRequestTabToTerminal(
      tab.id,
      { requestId: ar.id },
      { label: ar.server?.displayName || ar.server?.hostname, env: ar.server?.environment }
    );
  }, [ar, convertRequestTabToTerminal, tab.id]);

  // Auto-connect once, only while this tab is the one being looked at.
  useEffect(() => {
    if (focused && ar?.status === 'APPROVED') connect();
  }, [focused, ar, connect]);

  if (loading && !ar) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading access request…
      </div>
    );
  }

  if (err && !ar) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <XCircle className="h-8 w-8 text-destructive/70" />
        <p className="text-sm text-foreground">{err}</p>
        <button
          type="button"
          onClick={load}
          className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-accent"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }

  if (!ar) return null;

  const { tone, label } = statusTone(ar.status);
  const serverName = ar.server?.displayName || ar.server?.hostname || 'Server';

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 text-center shadow-sm">
        <div className="mb-3 flex items-center justify-center gap-2">
          <span className="text-base font-semibold text-foreground">{serverName}</span>
          {ar.server?.environment && <EnvironmentBadge environment={ar.server.environment} />}
        </div>

        <Badge tone={tone} className="mx-auto">
          {ar.status === 'PENDING' && <Clock className="mr-1 h-3 w-3" />}
          {ar.status === 'APPROVED' && <CheckCircle2 className="mr-1 h-3 w-3" />}
          {label}
        </Badge>

        <dl className="mt-4 space-y-1.5 text-left text-xs">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Principal</dt>
            <dd className="font-mono text-foreground">{ar.requestedPrincipal || '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Duration</dt>
            <dd className="text-foreground">{Math.round((ar.requestedDuration || 0) / 60)} min</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Requested</dt>
            <dd className="text-foreground">{formatDateTime(ar.createdAt)}</dd>
          </div>
          {ar.reason && (
            <div className="pt-1">
              <dt className="text-muted-foreground">Reason</dt>
              <dd className="mt-0.5 text-foreground">{ar.reason}</dd>
            </div>
          )}
          {Array.isArray(ar.approvers) && ar.approvers.length > 0 && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Approvers</dt>
              <dd className="text-foreground">
                {ar.approvers.map((a) => a.user?.name || a.user?.email).filter(Boolean).join(', ')}
              </dd>
            </div>
          )}
          {ar.status === 'DENIED' && ar.deniedReason && (
            <div className="pt-1">
              <dt className="text-muted-foreground">Denied reason</dt>
              <dd className="mt-0.5 text-foreground">{ar.deniedReason}</dd>
            </div>
          )}
        </dl>

        <div className="mt-4 flex items-center justify-center gap-2">
          {ar.status === 'PENDING' && (
            <button
              type="button"
              onClick={load}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground hover:bg-accent"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh status
            </button>
          )}
          {ar.status === 'APPROVED' && (
            <button
              type="button"
              onClick={connect}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <PlugZap className="h-3.5 w-3.5" /> Connect
            </button>
          )}
          {(ar.status === 'DENIED' || ar.status === 'EXPIRED' || ar.status === 'REVOKED') && (
            <button
              type="button"
              onClick={() => setReRequestOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground hover:bg-accent"
            >
              Request again
            </button>
          )}
        </div>
      </div>

      {reRequestOpen && (
        <RequestForm
          open={reRequestOpen}
          onClose={() => setReRequestOpen(false)}
          initialServerId={ar.serverId}
          onSuccess={(created) => {
            setReRequestOpen(false);
            closeTab(tab.id);
            if (created) openTabForAccessRequest(created, { focus: true });
          }}
        />
      )}
    </div>
  );
}

export default RequestStatusCard;
