import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, History } from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/badge';
import DeployWizardModal from './DeployWizardModal';
import { listDeploymentBatches, listDeployments, retryDeployment } from '@/services/keystoreService';
import { formatDateTime, relativeTime } from '@/utils/time';

const STATUS_META = {
  pending: { label: 'Pending', cls: 'bg-muted text-muted-foreground' },
  running: { label: 'Running', cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  success: { label: 'Success', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  failed: { label: 'Failed', cls: 'bg-destructive/15 text-destructive' },
};

const ACTION_LABEL = { deploy: 'Deploy', remove: 'Remove', rotate: 'Rotate' };

function ProgressBar({ counts }) {
  const total = counts?.total || 0;
  if (!total) return <div className="h-2 w-full rounded-full bg-muted" />;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="bg-emerald-500" style={{ width: `${((counts.success || 0) / total) * 100}%` }} />
      <div className="bg-destructive" style={{ width: `${((counts.failed || 0) / total) * 100}%` }} />
      <div className="bg-blue-500" style={{ width: `${((counts.running || 0) / total) * 100}%` }} />
    </div>
  );
}

function DeploymentRow({ deployment, canRetry, onRetry }) {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[deployment.status] || STATUS_META.pending;
  const hasDetail = deployment.error || deployment.output;

  return (
    <li className="px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
        >
          {hasDetail ? (
            open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <span className="w-3.5" />
          )}
          <span className="truncate text-foreground">{deployment.server?.displayName || deployment.server?.hostname}</span>
        </button>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.cls}`}>{meta.label}</span>
        {canRetry && deployment.status === 'failed' && (
          <button
            type="button"
            onClick={() => onRetry(deployment)}
            className="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
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

  const loadDeployments = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listDeployments({ batchId: batch.batchId, pageSize: 500 });
      setDeployments(data.deployments || []);
    } catch {
      /* ignore */
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
        className="flex w-full items-center gap-4 px-4 py-3 text-left"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{ACTION_LABEL[batch.action] || batch.action}</Badge>
            <span className="truncate text-sm font-medium text-foreground">{batch.sshKey?.name}</span>
            <span className="text-xs text-muted-foreground">
              by {batch.deployedBy?.name || 'system'} · {relativeTime(batch.createdAt)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="max-w-xs flex-1">
              <ProgressBar counts={batch.counts} />
            </div>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {(batch.counts?.success || 0)}/{batch.counts?.total || 0} succeeded
              {batch.counts?.failed ? `, ${batch.counts.failed} failed` : ''}
            </span>
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-border">
          {loading && deployments.length === 0 ? (
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
          title="No deployments yet"
          description="Deploy or rotate an SSH key across your servers to see progress here."
          action={canManage ? { label: 'Deploy / rotate key', onClick: () => setWizardOpen(true) } : undefined}
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
