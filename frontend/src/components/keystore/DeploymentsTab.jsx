import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, History, Search, Send, Trash2, X } from 'lucide-react';
import { CardIcon, CardStatus } from '@/components/mobile/MobileCard';
import EmptyState from '@/components/ui/EmptyState';
import EntityLink from '@/components/EntityLink';
import EntityPicker from '@/components/shared/EntityPicker';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { Input } from '@/components/ui/input';
import { statusTone } from '@/lib/badgeTones';
import DeployWizardModal from './DeployWizardModal';
import { listDeploymentBatches, listDeployments, listKeys, retryDeployment } from '@/services/keystoreService';
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
        <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-sm md:min-h-0">
          <button
            type="button"
            onClick={() => hasDetail && setOpen((o) => !o)}
            disabled={!hasDetail}
            aria-label={open ? 'Hide details' : 'Show details'}
            className="shrink-0 disabled:cursor-default"
          >
            {hasDetail ? (
              open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <span className="block w-3.5" />
            )}
          </button>
          <span className="min-w-0 truncate text-foreground">
            {deployment.server?.id ? (
              <EntityLink
                to={`/servers/${deployment.server.id}`}
                entityType="server"
                entityName={deployment.server.displayName || deployment.server.hostname}
              >
                {deployment.server.displayName || deployment.server.hostname}
              </EntityLink>
            ) : (
              deployment.server?.displayName || deployment.server?.hostname || 'Unknown server'
            )}
          </span>
        </div>
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
      {/* Same structure as the list cards: what and who on top, the
          result and the "Servers" toggle in an action row under a divider. */}
      <div className="flex items-start gap-3 p-3.5 md:px-4">
        <CardIcon icon={ACTION_ICON[batch.action] || Send} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-semibold leading-5 text-foreground">{batch.sshKey?.name || 'SSH key'}</span>
            <CardStatus {...batchStatus(batch.counts)} />
          </div>
          <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
            {ACTION_LABEL[batch.action] || batch.action} · {batch.deployedBy?.name || 'system'} · {relativeTime(batch.createdAt)}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-border py-1.5 pl-3.5 pr-1.5 md:pl-4">
        <div className="min-w-0 flex-1">
          <ResultCounts counts={batch.counts} />
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Servers
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
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

/** A single row in the flat, filtered deployment list (search/key/server). */
function FlatDeploymentRow({ deployment, canRetry, onRetry }) {
  const [open, setOpen] = useState(false);
  const meta = statusTone(deployment.status);
  const hasDetail = deployment.error || deployment.output;

  return (
    <li className="px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-sm md:min-h-0">
          <button
            type="button"
            onClick={() => hasDetail && setOpen((o) => !o)}
            disabled={!hasDetail}
            aria-label={open ? 'Hide details' : 'Show details'}
            className="shrink-0 disabled:cursor-default"
          >
            {hasDetail ? (
              open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <span className="block w-3.5" />
            )}
          </button>
          <span className="min-w-0 truncate text-foreground">
            {deployment.server?.id ? (
              <EntityLink
                to={`/servers/${deployment.server.id}`}
                entityType="server"
                entityName={deployment.server.displayName || deployment.server.hostname}
              >
                {deployment.server.displayName || deployment.server.hostname}
              </EntityLink>
            ) : (
              deployment.server?.displayName || deployment.server?.hostname || 'Unknown server'
            )}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {deployment.sshKey?.name || 'key'} · {ACTION_LABEL[deployment.action] || deployment.action}
          </span>
        </div>
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

const DeploymentsTab = forwardRef(function DeploymentsTab({ canManage }, ref) {
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [highlightId, setHighlightId] = useState(null);
  const rowRefs = useRef({});

  // Search + filter by key / server — the batch list above groups by export
  // run, which doesn't answer "did this key ever reach this server?". Any of
  // these being set switches to a flat, paginated result list instead.
  const [searchRaw, setSearchRaw] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchRaw), 250);
    return () => clearTimeout(t);
  }, [searchRaw]);
  const [sshKeyId, setSshKeyId] = useState('');
  const [serverId, setServerId] = useState('');
  const [keyOptions, setKeyOptions] = useState([]);
  useEffect(() => {
    listKeys({ scope: 'org' }).then((rows) => setKeyOptions(rows || [])).catch(() => {});
  }, []);

  const isFiltering = !!(search || sshKeyId || serverId);
  const [flatResults, setFlatResults] = useState([]);
  const [flatTotal, setFlatTotal] = useState(0);
  const [flatPage, setFlatPage] = useState(1);
  const [flatLoading, setFlatLoading] = useState(false);
  const flatPageSize = 25;

  const fetchFlat = useCallback(async () => {
    setFlatLoading(true);
    try {
      const params = { page: flatPage, pageSize: flatPageSize };
      if (search) params.search = search;
      if (sshKeyId) params.sshKeyId = sshKeyId;
      if (serverId) params.serverId = serverId;
      const data = await listDeployments(params);
      setFlatResults(data.deployments || []);
      setFlatTotal(data.total || 0);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to search deployments');
    } finally {
      setFlatLoading(false);
    }
  }, [flatPage, search, sshKeyId, serverId]);

  useEffect(() => {
    if (isFiltering) fetchFlat();
  }, [isFiltering, fetchFlat]);

  // Any filter change starts back at page 1.
  useEffect(() => {
    setFlatPage(1);
  }, [search, sshKeyId, serverId]);

  const handleFlatRetry = async (deployment) => {
    try {
      await retryDeployment(deployment.id);
      fetchFlat();
    } catch {
      /* surfaced via row staying failed */
    }
  };

  const clearFilters = () => {
    setSearchRaw('');
    setSearch('');
    setSshKeyId('');
    setServerId('');
  };

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
    refresh: fetch,
  }));

  const flatTotalPages = Math.max(1, Math.ceil(flatTotal / flatPageSize));

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Search a key/server across every export — the batch list below
          groups by run, which can't answer "did this key ever reach this
          server?". Any of these narrows to a flat, paginated result list. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap">
        <div className="relative min-w-0 flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchRaw}
            onChange={(e) => setSearchRaw(e.target.value)}
            placeholder="Search key or server..."
            aria-label="Search key or server"
            className="pl-9 h-9"
            type="search"
          />
        </div>
        <SearchableSelect
          className="w-[200px]"
          value={sshKeyId}
          onChange={setSshKeyId}
          placeholder="Any key"
          searchable={keyOptions.length > 8}
          clearable={false}
          options={[{ value: '', label: 'Any key' }, ...keyOptions.map((k) => ({ value: k.id, label: k.name }))]}
        />
        <EntityPicker className="w-[200px]" kind="servers" value={serverId} onChange={setServerId} anyLabel="Any server" />
        {isFiltering && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        )}
      </div>

      {isFiltering ? (
        flatLoading && flatResults.length === 0 ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : flatResults.length === 0 ? (
          <EmptyState icon={Search} title="No deployments match" description="Try a different search or clear the filters." />
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <ul className="divide-y divide-border">
              {flatResults.map((d) => (
                <FlatDeploymentRow key={d.id} deployment={d} canRetry={canManage} onRetry={handleFlatRetry} />
              ))}
            </ul>
            {flatTotalPages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
                <span>
                  Page {flatPage} of {flatTotalPages} · {flatTotal} deployment{flatTotal === 1 ? '' : 's'}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={flatPage <= 1}
                    onClick={() => setFlatPage((p) => Math.max(1, p - 1))}
                    className="rounded px-2 py-1 hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={flatPage >= flatTotalPages}
                    onClick={() => setFlatPage((p) => Math.min(flatTotalPages, p + 1))}
                    className="rounded px-2 py-1 hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      ) : loading ? (
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
