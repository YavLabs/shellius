import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import { FileText, History, ListFilter, RefreshCw, Send, Trash2, X } from 'lucide-react';
import { CardStatus } from '@/components/mobile/MobileCard';
import EmptyState from '@/components/ui/EmptyState';
import EntityLink from '@/components/EntityLink';
import DataTable from '@/components/shared/DataTable';
import GroupedView, { GroupLeafTable } from '@/components/shared/GroupedView';
import FilteredEmptyState from '@/components/shared/FilteredEmptyState';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import useGroupBy from '@/hooks/useGroupBy';
import { groupFilters, pathId } from '@/lib/grouping';
import { appliedFilterCount, clearedFilterValues, isFilterSet } from '@/lib/filters';
import { statusTone } from '@/lib/badgeTones';
import DeployWizardModal from './DeployWizardModal';
import { listDeploymentGroups, listDeployments, listKeys, retryDeployment } from '@/services/keystoreService';
import { formatDateTime, relativeTime } from '@/utils/time';

/**
 * Keystore → "Export to servers": every key deployment, as ONE list.
 *
 * It used to be two views — export runs ("batches") normally, and a flat
 * result list the moment any filter was set — which behaved differently
 * depending on whether a filter happened to be on. Now filters always apply
 * to the same list, and the export run is just one level of the shared Group
 * control (and the default one, so the page still opens run by run). The
 * tree and counts come from GET /keystore/deployments/groups over the whole
 * filtered set; each group loads its own rows through the list endpoint.
 */

const ACTION_LABEL = { deploy: 'Export', remove: 'Remove', rotate: 'Rotate' };
const ACTION_ICON = { deploy: Send, remove: Trash2, rotate: RefreshCw };

const GROUP_OPTIONS = [
  { value: 'batch', label: 'Export run' },
  { value: 'key', label: 'Key' },
  { value: 'server', label: 'Server' },
  { value: 'customer', label: 'Customer' },
  { value: 'status', label: 'Status' },
  { value: 'action', label: 'Action' },
  { value: 'deployedBy', label: 'Started by' },
];
const DEFAULT_GROUPING = ['batch'];

// Group dimension → list API filter.
const PARAM_FOR = {
  batch: 'batchId',
  key: 'sshKeyId',
  server: 'serverId',
  customer: 'customerId',
  status: 'status',
  action: 'action',
  deployedBy: 'deployedById',
};

// Columns that say nothing inside a group that already fixes their value.
const COLUMN_FOR_DIM = { key: 'key', server: 'server', status: 'status', action: 'action', deployedBy: 'deployedBy' };

const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'running', label: 'Running' },
  { value: 'pending', label: 'Waiting' },
  { value: 'failed', label: 'Failed' },
  { value: 'success', label: 'Succeeded' },
];
const ACTION_OPTIONS = [
  { value: '', label: 'Any action' },
  { value: 'deploy', label: 'Export' },
  { value: 'rotate', label: 'Rotate' },
  { value: 'remove', label: 'Remove' },
];

const EMPTY_FILTERS = { sshKeyId: '', serverId: '', customerId: '', status: '', action: '', deployedById: '' };
const isActive = (d) => d.status === 'pending' || d.status === 'running';
const errorMessage = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

/** Quiet result counts: dot + number per outcome (no chips, no bar). */
function ResultCounts({ counts }) {
  const parts = [
    ['success', 'succeeded', 'bg-emerald-500'],
    ['failed', 'failed', 'bg-red-500'],
    ['running', 'running', 'bg-blue-500'],
    ['pending', 'waiting', 'bg-muted-foreground/60'],
  ].filter(([k]) => (counts?.[k] || 0) > 0);
  if (!parts.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-normal tabular-nums text-muted-foreground">
      {parts.map(([k, label, dot]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
          {counts[k]} {label}
        </span>
      ))}
    </span>
  );
}

/** One status for a whole export run: running, some failed, or done. */
function batchStatus(counts) {
  if ((counts?.running || 0) + (counts?.pending || 0) > 0) return { tone: 'warning', label: 'Running' };
  if (counts?.failed) return { tone: 'danger', label: `${counts.failed} failed` };
  return { tone: 'success', label: 'Done' };
}

/**
 * An export run's group header — what the old batch card showed: action,
 * key, who started it and when, the run's status and its per-outcome counts
 * (of the rows under this group, so filters and outer levels still hold).
 */
function BatchLabel({ meta }) {
  const Icon = ACTION_ICON[meta.action] || Send;
  return (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">{meta.sshKey?.name || 'SSH key'}</span>
      <span className="hidden shrink-0 text-xs font-normal text-muted-foreground sm:inline" title={formatDateTime(meta.createdAt)}>
        {ACTION_LABEL[meta.action] || meta.action} · {meta.deployedBy?.name || meta.deployedBy?.email || 'system'} ·{' '}
        {relativeTime(meta.createdAt)}
      </span>
      <span className="shrink-0 font-normal">
        <CardStatus {...batchStatus(meta.counts)} />
      </span>
      <span className="hidden shrink-0 lg:inline-flex">
        <ResultCounts counts={meta.counts} />
      </span>
    </>
  );
}

function ServerCell({ deployment }) {
  const server = deployment.server;
  const name = server?.displayName || server?.hostname;
  if (!server?.id) return <span className="text-muted-foreground">{name || 'Unknown server'}</span>;
  return (
    <EntityLink to={`/servers/${server.id}`} entityType="server" entityName={name}>
      {name}
    </EntityLink>
  );
}

function StatusCell({ deployment }) {
  const meta = statusTone(deployment.status);
  return (
    <div className="min-w-0">
      <CardStatus tone={meta.tone} label={meta.label} />
      {deployment.status === 'failed' && deployment.error && (
        <p className="mt-0.5 max-w-[22rem] truncate text-xs text-destructive" title={deployment.error}>
          {deployment.error}
        </p>
      )}
    </div>
  );
}

/** The error / command output of one deployment (was the row's expander). */
function OutputDialog({ deployment, onClose }) {
  const name = deployment?.server?.displayName || deployment?.server?.hostname || 'server';
  return (
    <Dialog open={!!deployment} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Output · {name}</DialogTitle>
          <DialogDescription>
            {deployment?.sshKey?.name || 'SSH key'} · {ACTION_LABEL[deployment?.action] || deployment?.action} ·{' '}
            {statusTone(deployment?.status).label}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {deployment?.error && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 font-mono text-[11px] text-destructive">
              {deployment.error}
            </pre>
          )}
          {deployment?.output && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-muted/30 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
              {deployment.output}
            </pre>
          )}
          {!deployment?.error && !deployment?.output && <p className="text-sm text-muted-foreground">No output recorded.</p>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

const DeploymentsTab = forwardRef(function DeploymentsTab({ canManage }, ref) {
  const [error, setError] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [detail, setDetail] = useState(null);

  // ---- grouping (URL ?group=, remembered; export run by default) ----------
  const [groupKeys, setGroupKeys] = useGroupBy('shellius.keystore.deployments.groupBy', GROUP_OPTIONS, {
    defaultKeys: DEFAULT_GROUPING,
  });
  const grouped = groupKeys.length > 0;
  const groupSig = groupKeys.join(',');

  // ---- filters: one set, always applied, grouped or not -------------------
  const [search, setSearch] = useState('');
  const [filterValues, setFilterValues] = useState(EMPTY_FILTERS);
  // "Only this export run" — a batch filter set from a row or a deep link
  // (?highlight=<batchId>); shown as its own removable chip.
  const [batchFocus, setBatchFocus] = useState(null); // { id, label }
  const [keyOptions, setKeyOptions] = useState([]);
  useEffect(() => {
    listKeys({ scope: 'org' })
      .then((rows) => setKeyOptions(rows || []))
      .catch(() => {});
  }, []);

  const filterDefs = useMemo(
    () => [
      {
        key: 'sshKeyId',
        label: 'Key',
        placeholder: 'Any key',
        options: [{ value: '', label: 'Any key' }, ...keyOptions.map((k) => ({ value: k.id, label: k.name }))],
      },
      { key: 'serverId', label: 'Server', type: 'entity', entity: 'servers', placeholder: 'Any server' },
      { key: 'customerId', label: 'Customer', type: 'entity', entity: 'customers', placeholder: 'Any customer' },
      { key: 'status', label: 'Status', placeholder: 'Any status', options: STATUS_OPTIONS },
      { key: 'action', label: 'Action', placeholder: 'Any action', options: ACTION_OPTIONS },
      { key: 'deployedById', label: 'Started by', type: 'entity', entity: 'users', placeholder: 'Anyone' },
    ],
    [keyOptions]
  );

  const filters = useMemo(() => {
    const out = {};
    for (const [k, v] of Object.entries(filterValues)) if (isFilterSet(v)) out[k] = v;
    if (search) out.search = search;
    if (batchFocus?.id) out.batchId = batchFocus.id;
    return out;
  }, [filterValues, search, batchFocus]);
  const filterSig = JSON.stringify(filters);
  const hasFilters = Object.keys(filters).length > 0;

  const clearFilters = useCallback(() => {
    setFilterValues(clearedFilterValues(filterDefs));
    setBatchFocus(null);
  }, [filterDefs]);

  // ---- refresh: one counter; the tree, the flat page and every open group
  // refetch when it moves (header refresh, polling, retry, a new export).
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  // ---- flat list (no grouping) ---------------------------------------------
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [flat, setFlat] = useState({ items: [], total: 0, loading: true });
  const flatSeq = useRef(0);
  useEffect(() => {
    setPage(1);
  }, [filterSig]);
  useEffect(() => {
    if (grouped) return;
    const mine = ++flatSeq.current;
    setFlat((s) => ({ ...s, loading: true }));
    listDeployments({ ...filters, page, pageSize })
      .then((r) => {
        if (mine !== flatSeq.current) return;
        setFlat({ items: r.deployments, total: r.total, loading: false });
        setError('');
      })
      .catch((err) => {
        if (mine !== flatSeq.current) return;
        setFlat((s) => ({ ...s, loading: false }));
        setError(errorMessage(err, 'Failed to load deployments'));
      });
    // filterSig stands in for `filters`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, filterSig, page, pageSize, tick]);

  // ---- group tree ------------------------------------------------------------
  const [treeState, setTreeState] = useState({ tree: null, active: 0, loading: false, error: '' });
  const treeSeq = useRef(0);
  useEffect(() => {
    if (!grouped) return;
    const mine = ++treeSeq.current;
    setTreeState((s) => ({ ...s, loading: true }));
    listDeploymentGroups({ ...filters, groupBy: groupSig })
      .then((r) => {
        if (mine === treeSeq.current) setTreeState({ tree: r.tree || [], active: r.active || 0, loading: false, error: '' });
      })
      .catch((err) => {
        if (mine === treeSeq.current) {
          setTreeState((s) => ({ ...s, loading: false, error: errorMessage(err, 'Failed to load groups') }));
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, groupSig, filterSig, tick]);

  // ---- live progress: poll every 3s while anything shown is still running --
  const anyActive = grouped ? treeState.active > 0 : flat.items.some(isActive);
  useEffect(() => {
    if (!anyActive) return undefined;
    const id = setInterval(bump, 3000);
    return () => clearInterval(id);
  }, [anyActive, bump]);

  // ---- actions --------------------------------------------------------------
  const handleRetry = useCallback(
    async (deployment) => {
      try {
        await retryDeployment(deployment.id);
        setError('');
      } catch (err) {
        setError(errorMessage(err, 'Retry failed'));
      } finally {
        bump();
      }
    },
    [bump]
  );

  const focusBatch = useCallback((deployment) => {
    const when = formatDateTime(deployment.createdAt);
    const label = `${deployment.sshKey?.name || 'SSH key'} · ${ACTION_LABEL[deployment.action] || deployment.action} · ${when}`;
    setBatchFocus({ id: deployment.batchId, label });
  }, []);

  useImperativeHandle(ref, () => ({
    openDeploy: () => setWizardOpen(true),
    // Deep link (?highlight=<batchId>): narrow the list to that export run.
    highlight: (id) => {
      if (id) setBatchFocus({ id, label: null });
    },
    refresh: async () => bump(),
  }));

  // A deep-linked run has no label until its rows arrive.
  const focusLabel =
    batchFocus?.label ||
    (batchFocus &&
      (() => {
        const node = (treeState.tree || []).find((n) => n.dim === 'batch' && n.value === batchFocus.id);
        if (node) return node.label;
        const row = flat.items.find((d) => d.batchId === batchFocus.id);
        return row ? `${row.sshKey?.name || 'SSH key'} · ${ACTION_LABEL[row.action] || row.action} · ${formatDateTime(row.createdAt)}` : null;
      })()) ||
    'selected export run';

  // ---- columns (grouped leaves drop the ones their group already fixes) ----
  const columns = useMemo(() => {
    const fixed = new Set(groupKeys.map((k) => COLUMN_FOR_DIM[k]).filter(Boolean));
    return [
      { key: 'server', label: 'Server', render: (d) => <ServerCell deployment={d} />, mobile: 'title' },
      { key: 'key', label: 'Key', render: (d) => d.sshKey?.name || '—', mobile: 'secondary' },
      { key: 'action', label: 'Action', render: (d) => ACTION_LABEL[d.action] || d.action, hideBelow: 'md', mobile: 'secondary' },
      { key: 'status', label: 'Status', render: (d) => <StatusCell deployment={d} />, mobile: 'meta' },
      {
        key: 'deployedBy',
        label: 'Started by',
        render: (d) => d.deployedBy?.name || d.deployedBy?.email || 'system',
        hideBelow: 'lg',
        mobile: 'meta',
      },
      {
        key: 'createdAt',
        label: 'When',
        render: (d) => (
          <span className="whitespace-nowrap text-muted-foreground" title={formatDateTime(d.createdAt)}>
            {relativeTime(d.createdAt)}
          </span>
        ),
        hideBelow: 'md',
        mobile: 'meta',
      },
      {
        key: 'actions',
        label: '',
        className: 'w-12',
        actions: [
          {
            label: 'Retry',
            icon: RefreshCw,
            primary: true,
            onClick: handleRetry,
            hidden: (d) => !(canManage && d.status === 'failed'),
          },
          { label: 'View output', icon: FileText, onClick: setDetail, hidden: (d) => !(d.error || d.output) },
          {
            label: 'Only this export run',
            icon: ListFilter,
            onClick: focusBatch,
            hidden: (d) => batchFocus?.id === d.batchId,
          },
        ],
      },
    ].filter((c) => !fixed.has(c.key));
  }, [groupKeys, canManage, handleRetry, focusBatch, batchFocus?.id]);

  const noExportsYet = (
    <EmptyState
      icon={History}
      title="No exports yet"
      description="Export or rotate an SSH key across your servers to see progress here."
      action={canManage ? { label: 'Export / rotate key', onClick: () => setWizardOpen(true) } : undefined}
    />
  );
  const emptyContent = hasFilters ? <FilteredEmptyState onClear={clearFilters} /> : noExportsYet;

  const renderLabel = useCallback((node) => {
    if (node.dim === 'batch' && node.meta) return <BatchLabel meta={node.meta} />;
    if (node.dim === 'status') {
      const tone = statusTone(node.value).tone;
      return <CardStatus tone={tone} label={node.label} />;
    }
    return node.label;
  }, []);

  const groupedContent =
    treeState.tree && treeState.tree.length === 0 && !treeState.loading && !treeState.error ? (
      <div className="rounded-lg border border-border bg-card">{emptyContent}</div>
    ) : (
      <GroupedView
        tree={treeState.tree}
        loading={treeState.loading}
        error={treeState.error}
        dimLabel={(dim) => GROUP_OPTIONS.find((o) => o.value === dim)?.label || dim}
        renderLabel={renderLabel}
        emptyMessage="No deployments match."
        renderLeaf={(node, path) => (
          <GroupLeafTable
            columns={columns}
            emptyMessage="No deployments in this group."
            reloadKey={`${tick}|${filterSig}|${pathId(path)}`}
            fetchPage={({ page: p, pageSize: ps }) =>
              listDeployments({ ...filters, ...groupFilters(path, PARAM_FOR), page: p, pageSize: ps }).then((r) => ({
                items: r.deployments,
                total: r.total,
              }))
            }
          />
        )}
      />
    );

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      {batchFocus && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/50 py-1 pl-2 pr-1">
            <span className="shrink-0">Export run:</span>
            <span className="truncate font-medium text-foreground">{focusLabel}</span>
            <button
              type="button"
              onClick={() => setBatchFocus(null)}
              aria-label="Show every export run"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}

      <DataTable
        columns={columns}
        data={flat.items}
        loading={flat.loading && flat.items.length === 0}
        emptyState={emptyContent}
        searchPlaceholder="Search key or server..."
        onSearchChange={setSearch}
        filterDefs={filterDefs}
        filterValues={filterValues}
        onFilterChange={(next) => setFilterValues((prev) => ({ ...prev, ...next }))}
        activeFilterCount={appliedFilterCount(filterDefs, filterValues) + (batchFocus ? 1 : 0)}
        onResetFilters={clearFilters}
        grouping={{ keys: groupKeys, onChange: setGroupKeys, options: GROUP_OPTIONS }}
        groupedContent={groupedContent}
        defaultPageSize={25}
        pageSizeOptions={[10, 25, 50, 100]}
        serverPagination={{
          page,
          total: flat.total,
          pageSize,
          onPageChange: setPage,
          onPageSizeChange: (n) => {
            setPageSize(n);
            setPage(1);
          },
        }}
      />

      <OutputDialog deployment={detail} onClose={() => setDetail(null)} />

      {wizardOpen && <DeployWizardModal open={wizardOpen} onClose={() => setWizardOpen(false)} onDone={bump} />}
    </div>
  );
});

export default DeploymentsTab;
