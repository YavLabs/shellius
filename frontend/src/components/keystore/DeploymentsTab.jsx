import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, History, Send, Trash2 } from 'lucide-react';
import { CardIcon, CardStatus } from '@/components/mobile/MobileCard';
import EmptyState from '@/components/ui/EmptyState';
import Avatar from '@/components/ui/Avatar';
import { statusTone } from '@/lib/badgeTones';
import DeployWizardModal from './DeployWizardModal';
import { listDeploymentBatches, listDeployments, retryDeployment } from '@/services/keystoreService';
import { formatDateTime, relativeTime } from '@/utils/time';

const ACTION_LABEL = { deploy: 'Export', remove: 'Remove', rotate: 'Rotate' };

const ACTION_ICON = { deploy: Send, remove: Trash2, rotate: RefreshCw };

/** Quiet result counts: dot + number per outcome (no chips, no bar). */
function ResultCounts({ counts }) {
  const parts = [
    ['success', 'succeeded', 'bg-emerald-500'],
    ['failed', 'failed', 'bg-red-500'],
    ['running', 'running', 'bg-blue-500'],
    ['pending', 'waiting', 'bg-muted-foreground/60'],
  ].filter(([k]) => (counts?.[k] || 0) > 0);
  if (!parts.length) return <span className="text-xs text-muted-foreground">No servers</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
      {parts.map(([k, label, dot]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
          {counts[k]} {label}
        </span>
      ))}
      <span className="text-muted-foreground/70">of {counts?.total || 0}</span>
    </span>
  );
}

/** One status for a whole export: running, some failed, or done. */
function batchStatus(counts) {
  if ((counts?.running || 0) + (counts?.pending || 0) > 0) return { tone: 'warning', label: 'Running' };
  if (counts?.failed) return { tone: 'danger', label: `${counts.failed} failed` };
  return { tone: 'success', label: 'Done' };
}

function DeploymentRow({ deployment, canRetry, onRetry }) {
  const [open, setOpen] = useState(false);
  const meta = statusTone(deployment.status);
  const hasDetail = deployment.error || deployment.output;

  return (
    <li className="px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((o) => !o)}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left text-sm md:min-h-0"
        >
          {hasDetail ? (
            open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <span className="w-3.5" />
          )}
          <span className="truncate text-foreground">{deployment.server?.displayName || deployment.server?.hostname}</span>
        </button>
        <CardStatus tone={meta.tone} label={meta.label} />
        {canRetry && deployment.status === 'failed' && (
          <button
            type="button"
            onClick={() => onRetry(deployment)}
            className="flex min-h-10 shrink-0 items-center gap-1 px-1 text-xs text-primary hover:underline md:min-h-0 md:px-0"
          >
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        )}
      </div>
      {open && hasDetail && (
        <div className="ml-6 mt-1.5 space-y-1.5">
          {deployment.error && (
            <pre className="max-h-32 overflow-auto rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 font-mono text-[11px] text-destructive whitespace-pre-wrap break-all">
              {deployment.error}
            </pre>
          )}
          {deployment.output && (
            <pre className="max-h-32 overflow-auto rounded border border-border bg-muted/30 px-2 py-1.5 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
              {deployment.output}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

function BatchRow({ batch, canRetry, onChanged, defaultOpen, highlighted, rowRef }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const loadDeployments = useCallback(async () => {
    setLoading(true);
    try {
      // API caps pageSize at 100 (a batch targets at most that many servers
      // per page); asking for more returns 400 and left the panel empty.
      const data = await listDeployments({ batchId: batch.batchId, pageSize: 100 });
      setDeployments(data.deployments || []);
      setLoadError('');
    } catch (err) {
      setLoadError(err.response?.data?.error?.message || err.message || 'Failed to load servers for this export');
    } finally {
      setLoading(false);
    }
  }, [batch.batchId]);

  useEffect(() => {
    if (open) loadDeployments();
  }, [open, loadDeployments]);

  // Poll while the batch itself has pending/running work
  const hasPending = (batch.counts?.pending || 0) + (batch.counts?.running || 0) > 0;
  useEffect(() => {
    if (!open || !hasPending) return;
    const id = setInterval(loadDeployments, 3000);
    return () => clearInterval(id);
  }, [open, hasPending, loadDeployments]);

  const handleRetry = async (deployment) => {
    try {
      await retryDeployment(deployment.id);
      loadDeployments();
      onChanged?.();
    } catch {
      /* surfaced via row staying failed */
    }
  };

  return (
    <div
      ref={rowRef}
      className={`rounded-lg border bg-card transition-colors ${
        highlighted ? 'border-primary ring-2 ring-primary/40' : 'border-border'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 p-3.5 text-left md:px-4"
      >
        <CardIcon icon={ACTION_ICON[batch.action] || Send} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-semibold leading-5 text-foreground">{batch.sshKey?.name || 'SSH key'}</span>
            <CardStatus {...batchStatus(batch.counts)} />
            {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
            <Avatar name={batch.deployedBy?.name} email={batch.deployedBy?.email} avatarUrl={batch.deployedBy?.avatarUrl} size="xs" />
            <span className="truncate">
              {ACTION_LABEL[batch.action] || batch.action} · {batch.deployedBy?.name || 'system'} · {relativeTime(batch.createdAt)}
            </span>
          </span>
          <span className="mt-2 block">
            <ResultCounts counts={batch.counts} />
          </span>
        </span>
      </button>
      {open && (
        <div className="border-t border-border">
          {loadError ? (
            <p className="px-4 py-3 text-sm text-destructive">{loadError}</p>
          ) : !loading && deployments.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No servers in this export.</p>
          ) : loading && deployments.length === 0 ? (
            <div className="space-y-2 p-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-8 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {deployments.map((d) => (
                <DeploymentRow key={d.id} deployment={d} canRetry={canRetry} onRetry={handleRetry} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const DeploymentsTab = forwardRef(function DeploymentsTab({ canManage }, ref) {
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [highlightId, setHighlightId] = useState(null);
  const rowRefs = useRef({});

  const fetch = useCallback(async () => {
    try {
      const data = await listDeploymentBatches({ limit: 20 });
      setBatches(data);
      return data;
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load deployments');
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  // Poll the batch list every 3s while anything is pending/running.
  useEffect(() => {
    const hasPending = batches.some((b) => (b.counts?.pending || 0) + (b.counts?.running || 0) > 0);
    if (!hasPending) return;
    const id = setInterval(fetch, 3000);
    return () => clearInterval(id);
  }, [batches, fetch]);

  useImperativeHandle(ref, () => ({
    openDeploy: () => setWizardOpen(true),
    // Best-effort: highlight+expand the batch matching a batchId. Individual
    // deployment ids aren't addressable from the collapsed batch list.
    highlight: async (id) => {
      const list = batches.length ? batches : await fetch();
      if (!list.some((b) => b.batchId === id)) return;
      setHighlightId(id);
      setTimeout(() => rowRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
      setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 2500);
    },
  }));

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : batches.length === 0 ? (
        <EmptyState
          icon={History}
          title="No exports yet"
          description="Export or rotate an SSH key across your servers to see progress here."
          action={canManage ? { label: 'Export / rotate key', onClick: () => setWizardOpen(true) } : undefined}
        />
      ) : (
        <div className="space-y-2">
          {batches.map((b) => (
            <BatchRow
              key={b.batchId}
              batch={b}
              canRetry={canManage}
              onChanged={fetch}
              defaultOpen={highlightId === b.batchId}
              highlighted={highlightId === b.batchId}
              rowRef={(el) => {
                rowRefs.current[b.batchId] = el;
              }}
            />
          ))}
        </div>
      )}

      {wizardOpen && (
        <DeployWizardModal open={wizardOpen} onClose={() => setWizardOpen(false)} onDone={fetch} />
      )}
    </div>
  );
});

export default DeploymentsTab;
