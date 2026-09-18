import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Zap,
  MoreHorizontal,
  Copy,
  Save,
  Trash2,
  Loader2,
  AlertTriangle,
  Check,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import Skeleton from '@/components/ui/Skeleton';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import SaveServerModal from '@/components/quickConnect/SaveServerModal';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { getHistory, reconnectHistory, deleteHistory, clearHistory } from '@/services/quickConnectService';
import { openBlankTerminalTab, openTicketTerminal, closeBlankTerminalTab } from '@/lib/quickConnectLaunch';
import { relativeTime } from '@/utils/time';

const AUTH_BADGE = {
  password: { tone: 'neutral', label: 'Password' },
  key: { tone: 'info', label: 'Private key' },
};

function AuthBadge({ item }) {
  if (item.authType === 'credential') {
    return <Badge tone="accent">{item.credential?.name || 'Identity'}</Badge>;
  }
  const meta = AUTH_BADGE[item.authType] || { tone: 'neutral', label: item.authType || 'Unknown' };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

function StatusDot({ item }) {
  const failed = item.lastStatus === 'failed';
  const dot = (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${failed ? 'bg-red-500' : 'bg-emerald-500'}`}
      aria-hidden="true"
    />
  );
  if (!failed || !item.lastError) return dot;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{dot}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          {item.lastError}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * RecentQuickConnectsWidget — Dashboard card listing the user's Quick
 * Connect history (server-side, 7-day retention, no secrets). Replaces the
 * old localStorage "recent" concept that lived only inside the modal.
 */
function RecentQuickConnectsWidget() {
  const { allowed, openQuickConnect } = useQuickConnect();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connectingId, setConnectingId] = useState(null);
  const [actionError, setActionError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [saveTarget, setSaveTarget] = useState(null); // { host, port, username }
  const [copiedId, setCopiedId] = useState('');

  const load = useCallback(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    setLoading(true);
    getHistory({ limit: 8 })
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [allowed]);

  useEffect(() => {
    load();
  }, [load]);

  if (!allowed) return null;

  const handleReconnect = async (item) => {
    setActionError('');
    if (item.authType !== 'credential') {
      openQuickConnect({
        host: item.host,
        port: item.port,
        username: item.username,
        authTab: item.authType === 'key' ? 'key' : 'password',
      });
      return;
    }
    setConnectingId(item.id);
    // Open a blank tab synchronously (before the await) so popup blockers
    // don't kick in once we're back from the network call.
    const win = openBlankTerminalTab();
    try {
      const resp = await reconnectHistory(item.id);
      const label = `${item.username || 'user'}@${item.host}`;
      openTicketTerminal(win, { ticket: resp.ticket, label });
    } catch (err) {
      closeBlankTerminalTab(win);
      const code = err.response?.data?.error?.code;
      if (code === 'SECRET_REQUIRED') {
        openQuickConnect({ host: item.host, port: item.port, username: item.username, authTab: 'credential' });
      } else {
        setActionError(err.response?.data?.error?.message || err.message || 'Failed to reconnect');
      }
    } finally {
      setConnectingId(null);
    }
  };

  const handleCopy = (item) => {
    const cmd = `ssh -p ${item.port} ${item.username}@${item.host}`;
    navigator.clipboard
      ?.writeText(cmd)
      .then(() => {
        setCopiedId(item.id);
        setTimeout(() => setCopiedId(''), 1500);
      })
      .catch(() => {});
  };

  const handleRemove = async (item) => {
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    try {
      await deleteHistory(item.id);
    } catch {
      // best-effort — refresh to resync on failure
      load();
    }
  };

  const handleClear = async () => {
    setClearing(true);
    try {
      await clearHistory();
      setItems([]);
      setConfirmClear(false);
    } catch (err) {
      setActionError(err.response?.data?.error?.message || err.message || 'Failed to clear history');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Recent Quick Connects</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Last 7 days</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => openQuickConnect()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Zap className="h-3.5 w-3.5" />
            Quick Connect
          </button>
          {items.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Recent Quick Connects options"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setConfirmClear(true)} className="text-destructive focus:text-destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Clear history
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {actionError && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {actionError}
        </div>
      )}

      {loading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <Zap className="mb-2 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm font-medium text-muted-foreground">No Quick Connects yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Connect to any host ad-hoc without saving it as a server.
          </p>
          <button
            type="button"
            onClick={() => openQuickConnect()}
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground hover:bg-accent"
          >
            <Zap className="h-3.5 w-3.5" />
            Start a Quick Connect
          </button>
        </div>
      )}

      {!loading && items.length > 0 && (
        <ul className="space-y-0">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-3 border-b border-border py-2.5 last:border-0"
            >
              <StatusDot item={item} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-mono text-sm text-foreground">
                    {item.username}@{item.host}:{item.port}
                  </span>
                  <AuthBadge item={item} />
                  {item.server && (
                    <Link
                      to={`/servers/${item.server.id}`}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      <EnvironmentBadge environment={item.server.environment} />
                      <span className="text-xs text-muted-foreground">{item.server.displayName || item.server.hostname}</span>
                    </Link>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {relativeTime(item.lastConnectedAt)}
                  {item.connectCount > 1 && ` · ×${item.connectCount}`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={connectingId === item.id}
                  onClick={() => handleReconnect(item)}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                >
                  {connectingId === item.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    'Connect again'
                  )}
                </button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Options for ${item.username}@${item.host}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => handleCopy(item)}>
                      {copiedId === item.id ? (
                        <Check className="mr-2 h-4 w-4" />
                      ) : (
                        <Copy className="mr-2 h-4 w-4" />
                      )}
                      Copy ssh command
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        setSaveTarget({ host: item.host, port: item.port, username: item.username })
                      }
                    >
                      <Save className="mr-2 h-4 w-4" />
                      Save as server...
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => handleRemove(item)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Remove from history
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmClear}
        title="Clear Quick Connect history"
        message="This removes all of your Quick Connect history rows. This can't be undone."
        confirmLabel={clearing ? 'Clearing...' : 'Clear history'}
        variant="destructive"
        onConfirm={handleClear}
        onCancel={() => setConfirmClear(false)}
      />

      <SaveServerModal
        open={!!saveTarget}
        onClose={() => setSaveTarget(null)}
        connection={saveTarget}
        onSaved={() => setSaveTarget(null)}
      />
    </div>
  );
}

export default RecentQuickConnectsWidget;
