import { useCallback, useEffect, useState } from 'react';
import { Download, Radar, ServerOff, ShieldCheck } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Badge } from '@/components/ui/badge';
import EmptyState from '@/components/ui/EmptyState';
import { getPostureServers } from '@/services/postureService';
import { relativeTime } from '@/utils/time';

/**
 * CollectorCoverageModal — the list behind "reporting X of Y".
 *
 * The summary tile used to be a dead statistic: it told you 3 of 31 servers
 * report, with no way to find the other 28. This lists them by state and
 * offers the install action per row.
 */

const STATES = [
  { key: 'not_installed', label: 'Not installed', icon: ServerOff, tone: 'neutral' },
  { key: 'stale', label: 'Stale', icon: ServerOff, tone: 'warning' },
  { key: 'reporting', label: 'Reporting', icon: ShieldCheck, tone: 'success' },
];

function CollectorCoverageModal({ open, onClose, onInstall, onInstallAll, canInstall }) {
  const [state, setState] = useState('not_installed');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (which) => {
    setLoading(true);
    setError('');
    try {
      setData(await getPostureServers({ state: which, limit: 100 }));
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Could not load collector coverage.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load(state);
  }, [open, state, load]);

  const counts = data?.counts;

  return (
    <Modal open={open} onClose={onClose} title="Collector coverage" size="lg">
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Posture only sees hosts running the collector. Servers below are grouped by what they are
          doing right now.
        </p>

        <div className="flex flex-wrap gap-2">
          {STATES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setState(s.key)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs transition-colors ${
                state === s.key
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              <s.icon className="h-3.5 w-3.5" />
              {s.label}
              {counts && (
                <span className="tabular-nums text-muted-foreground">
                  {s.key === 'not_installed' ? counts.notInstalled : counts[s.key] ?? 0}
                </span>
              )}
            </button>
          ))}
        </div>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        {loading && <p className="text-xs text-muted-foreground">Loading…</p>}

        {!loading && data && data.items.length === 0 && (
          <EmptyState
            icon={Radar}
            title={
              state === 'not_installed'
                ? 'Every server has the collector'
                : state === 'stale'
                  ? 'Nothing is stale'
                  : 'No servers are reporting yet'
            }
            description={
              state === 'reporting'
                ? 'Install the collector on a host to start seeing its exposure.'
                : 'Nothing to do here.'
            }
          />
        )}

        {/* Installing them one at a time from this list is exactly the thing
            nobody finishes. If there is a list, there is a bulk action. */}
        {canInstall && onInstallAll && !loading && data && data.items.length > 1 && state !== 'reporting' && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-accent/30 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {data.items.length} host{data.items.length === 1 ? '' : 's'}{' '}
              {state === 'stale' ? 'stopped reporting' : 'have no collector'}.
            </span>
            <button
              type="button"
              onClick={() => onInstallAll(data.items.map((i) => i.id))}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-accent"
            >
              <Download className="h-3.5 w-3.5" />
              Install on all of them
            </button>
          </div>
        )}

        {!loading && data && data.items.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.items.map((s) => (
              <li key={s.id} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {s.displayName || s.hostname}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {s.customer?.name} · {s.environment?.toUpperCase()}
                    {s.lastReceivedAt ? ` · last report ${relativeTime(s.lastReceivedAt)}` : ''}
                  </p>
                </div>
                {s.authMode === 'credential' && (
                  <Badge tone="neutral" variant="outline">
                    Stored identity
                  </Badge>
                )}
                {canInstall && s.collectorState !== 'reporting' && (
                  <button
                    type="button"
                    onClick={() => onInstall?.(s)}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground hover:bg-accent"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Install
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

export default CollectorCoverageModal;
