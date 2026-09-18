import { useEffect, useState } from 'react';
import { Zap, Terminal, Loader2, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import RequestForm from '@/components/access-requests/RequestForm';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { listServers } from '@/services/serverService';
import { getAccessIntent } from '@/services/accessRequestService';
import { getHistory, reconnectHistory } from '@/services/quickConnectService';

/**
 * NewConnectionDialog — the "+" tab-bar action. Search list of servers
 * (Connect for servers with active access, Request access otherwise), plus
 * recent Quick Connects and a "Quick Connect..." shortcut.
 */
function NewConnectionDialog({ open, onClose }) {
  const { openTab } = useTerminalWorkspace();
  const { allowed: quickConnectAllowed, openQuickConnect } = useQuickConnect();

  const [query, setQuery] = useState('');
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState([]);
  const [connectingId, setConnectingId] = useState('');
  const [requestTarget, setRequestTarget] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setError('');
    getHistory({ limit: 5 })
      .then(setRecent)
      .catch(() => setRecent([]));
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    setLoading(true);
    const t = setTimeout(() => {
      listServers({ page: 1, pageSize: 20, search: query || undefined })
        .then((data) => setServers(data.items || []))
        .catch(() => setServers([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [open, query]);

  const handleServerConnect = async (server) => {
    setError('');
    setConnectingId(server.id);
    try {
      const intent = await getAccessIntent(server.id);
      if (intent?.hasActiveAccess && intent.activeRequestId) {
        // No principal picker here — omit it so the backend defaults to the
        // access request's preferred principal (matches ConnectModal).
        openTab(
          { requestId: intent.activeRequestId },
          {
            label: server.displayName || server.hostname,
            env: server.environment,
            host: server.ipAddress || server.hostname,
          }
        );
        onClose();
      } else {
        setRequestTarget(server.id);
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to check access');
    } finally {
      setConnectingId('');
    }
  };

  const handleReconnectHistory = async (item) => {
    setError('');
    if (item.authType !== 'credential') {
      onClose();
      openQuickConnect({
        host: item.host,
        port: item.port,
        username: item.username,
        authTab: item.authType === 'key' ? 'key' : 'password',
      });
      return;
    }
    setConnectingId(item.id);
    try {
      const resp = await reconnectHistory(item.id);
      openTab({ ticket: resp.ticket }, { label: `${item.username || 'user'}@${item.host}`, host: item.host, username: item.username });
      onClose();
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 'SECRET_REQUIRED') {
        onClose();
        openQuickConnect({ host: item.host, port: item.port, username: item.username, authTab: 'credential' });
      } else {
        setError(err.response?.data?.error?.message || err.message || 'Failed to reconnect');
      }
    } finally {
      setConnectingId('');
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent size="md" className="max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>New connection</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {error && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search servers..."
                className="pl-8"
              />
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Servers</p>
              {loading && (
                <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching...
                </div>
              )}
              {!loading && servers.length === 0 && (
                <p className="py-2 text-xs text-muted-foreground">No servers found.</p>
              )}
              <ul className="divide-y divide-border">
                {servers.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 py-2">
                    <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm text-foreground">{s.displayName || s.hostname}</span>
                        {s.environment && <EnvironmentBadge environment={s.environment} />}
                      </div>
                      <p className="truncate text-[11px] text-muted-foreground">{s.ipAddress || s.hostname}</p>
                    </div>
                    <button
                      type="button"
                      disabled={connectingId === s.id}
                      onClick={() => handleServerConnect(s)}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-60"
                    >
                      {connectingId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Connect'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {recent.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Recent Quick Connects
                </p>
                <ul className="divide-y divide-border">
                  {recent.map((item) => (
                    <li key={item.id} className="flex items-center gap-2 py-2">
                      <Zap className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                        {item.username}@{item.host}:{item.port}
                      </span>
                      <button
                        type="button"
                        disabled={connectingId === item.id}
                        onClick={() => handleReconnectHistory(item)}
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-60"
                      >
                        {connectingId === item.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Connect again'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {quickConnectAllowed && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  openQuickConnect();
                }}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              >
                <Zap className="h-3.5 w-3.5" />
                Quick Connect...
              </button>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {requestTarget && (
        <RequestForm
          open={!!requestTarget}
          onClose={() => setRequestTarget(null)}
          onSuccess={() => {
            setRequestTarget(null);
            onClose();
          }}
          initialServerId={requestTarget}
        />
      )}
    </>
  );
}

export default NewConnectionDialog;
