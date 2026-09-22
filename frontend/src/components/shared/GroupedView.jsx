import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import DataTable from '@/components/shared/DataTable';
import { allPathIds, defaultOpenIds, pathId, treeStats } from '@/lib/grouping';

/**
 * A grouped list: collapsible, nested group headers with their row counts,
 * after Ledgrr's grouped transaction list — but for lists paged on the
 * server. The tree (groups and counts over the whole filtered set) comes
 * from the page's `/groups` endpoint; a leaf group loads its own rows, a page
 * at a time, only when it is open.
 *
 * @param {{
 *   tree: Array, loading: boolean, error?: string,
 *   renderLeaf: (node, path) => JSX,   // usually a <GroupLeafTable/>
 *   renderLabel?: (node) => JSX,       // rich header label (badge, link…)
 *   dimLabel?: (dim) => string,        // "Customer", for the header's caption
 *   emptyMessage?: string,
 * }} props
 */
export default function GroupedView({ tree, loading, error, renderLeaf, renderLabel, dimLabel, emptyMessage = 'Nothing matches.' }) {
  const [openIds, setOpenIds] = useState(() => new Set());
  const seededFor = useRef(null);

  // Seed the open set when the shape of the tree changes (new levels or a
  // new filter), keeping what the reader opened across a plain refresh.
  const shape = useMemo(() => allPathIds(tree).join('|'), [tree]);
  useEffect(() => {
    if (!tree || seededFor.current === shape) return;
    const known = new Set(shape.split('|'));
    setOpenIds((prev) => {
      if (seededFor.current === null || [...prev].some((id) => !known.has(id))) return defaultOpenIds(tree);
      return prev;
    });
    seededFor.current = shape;
  }, [tree, shape]);

  const toggle = useCallback((id) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const stats = useMemo(() => treeStats(tree), [tree]);

  if (loading && !tree) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-11 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }
  if (error) {
    return <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>;
  }
  if (!tree || tree.length === 0) {
    return <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{emptyMessage}</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {stats.groups} group{stats.groups === 1 ? '' : 's'} · {stats.rows} row{stats.rows === 1 ? '' : 's'}
          {loading && ' · updating…'}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setOpenIds(new Set(allPathIds(tree)))}>
            <ChevronsUpDown className="h-3.5 w-3.5" />
            Expand all
          </Button>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setOpenIds(new Set())}>
            <ChevronsDownUp className="h-3.5 w-3.5" />
            Collapse all
          </Button>
        </div>
      </div>
      {tree.map((node) => (
        <GroupNode
          key={node.value}
          node={node}
          parent={[]}
          openIds={openIds}
          onToggle={toggle}
          renderLeaf={renderLeaf}
          renderLabel={renderLabel}
          dimLabel={dimLabel}
        />
      ))}
    </div>
  );
}

function GroupNode({ node, parent, openIds, onToggle, renderLeaf, renderLabel, dimLabel }) {
  const path = useMemo(() => [...parent, { dim: node.dim, value: node.value }], [parent, node.dim, node.value]);
  const id = pathId(path);
  const open = openIds.has(id);
  const depth = parent.length;

  return (
    <section
      className={cn(
        'overflow-hidden rounded-lg border border-border',
        depth === 0 ? 'bg-card' : 'bg-background',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        className={cn(
          'flex w-full select-none items-center gap-2 px-3 text-left transition-colors hover:bg-muted/50',
          depth === 0 ? 'bg-muted/30 py-2.5' : 'bg-muted/15 py-2',
        )}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        {dimLabel && <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">{dimLabel(node.dim)}</span>}
        <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
          {renderLabel ? renderLabel(node) : node.label}
        </span>
        <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-px text-xs font-medium tabular-nums text-muted-foreground">
          {node.count}
        </span>
      </button>
      {open && (
        <div className={cn('border-t border-border', node.children ? 'space-y-2 p-2' : 'p-2')}>
          {node.children
            ? node.children.map((child) => (
                <GroupNode
                  key={child.value}
                  node={child}
                  parent={path}
                  openIds={openIds}
                  onToggle={onToggle}
                  renderLeaf={renderLeaf}
                  renderLabel={renderLabel}
                  dimLabel={dimLabel}
                />
              ))
            : renderLeaf(node, path)}
        </div>
      )}
    </section>
  );
}

/**
 * One group's rows: the page's own columns, paged on the server through
 * `fetchPage({ page, pageSize })` (the page's list call with the group's
 * filters added). Refetches when `reloadKey` changes — pass the page's
 * refresh counter plus anything that changes what the group contains.
 * `onRows(items)` hears each loaded page (and `null` when the group closes),
 * for pages that watch the rows on screen — e.g. to keep polling while a
 * host in any open group is still installing.
 */
export function GroupLeafTable({ fetchPage, reloadKey, defaultPageSize = 10, onRows, ...tableProps }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [state, setState] = useState({ items: [], total: 0, loading: true });
  const seq = useRef(0);
  const onRowsRef = useRef(onRows);
  onRowsRef.current = onRows;
  useEffect(() => () => onRowsRef.current?.(null), []);

  useEffect(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve(fetchPage({ page, pageSize }))
      .then((r) => {
        if (mine === seq.current) {
          setState({ items: r?.items || [], total: r?.total || 0, loading: false });
          onRowsRef.current?.(r?.items || []);
        }
      })
      .catch(() => {
        if (mine === seq.current) setState({ items: [], total: 0, loading: false });
      });
    // fetchPage is usually an inline closure; reloadKey says when it means something new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, reloadKey]);

  return (
    <DataTable
      {...tableProps}
      toolbar={false}
      data={state.items}
      loading={state.loading && state.items.length === 0}
      defaultPageSize={defaultPageSize}
      pageSizeOptions={[10, 20, 50, 100]}
      serverPagination={{
        page,
        total: state.total,
        pageSize,
        onPageChange: setPage,
        onPageSizeChange: (n) => {
          setPageSize(n);
          setPage(1);
        },
      }}
    />
  );
}
