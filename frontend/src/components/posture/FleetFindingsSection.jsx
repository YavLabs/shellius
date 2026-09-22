import { useCallback, useEffect, useRef, useState } from 'react';
import DataTable from '@/components/shared/DataTable';
import GroupedView, { GroupLeafTable } from '@/components/shared/GroupedView';
import FindingSection from '@/components/posture/FindingSection';
import SeverityBadge from '@/components/posture/SeverityBadge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { listFindings, getFindingGroups } from '@/services/postureService';
import { NONE, groupFilters, pathId } from '@/lib/grouping';
import { FINDING_GROUP_PARAM, findingGroupDimLabel } from '@/lib/findingGroups';
import { codeLabel } from '@/lib/postureLabels';

/** A group header's label: the same badges the rows use, where there is one. */
function renderGroupLabel(node) {
  if (node.value === NONE) return <span className="text-muted-foreground">{node.label}</span>;
  switch (node.dim) {
    case 'severity':
      return <SeverityBadge severity={node.value} />;
    case 'environment':
      return <EnvironmentBadge environment={node.value} />;
    case 'code':
      return (
        <>
          <span className="truncate">{codeLabel(node.value)}</span>
          {codeLabel(node.value) !== node.value && (
            <span className="truncate font-mono text-[11px] font-normal text-muted-foreground">{node.value}</span>
          )}
        </>
      );
    case 'port':
      return <span className="font-mono">{node.label}</span>;
    default:
      return <span className="truncate">{node.label}</span>;
  }
}

/**
 * One section of the fleet findings inbox, with its own query.
 *
 * The fleet list is server-paginated, so sections cannot be a client-side
 * partition of one page the way they are on a single server. Each section
 * therefore owns its own request — and only makes it when opened, so
 * arriving on the page still costs exactly one query.
 *
 * The count in the header comes from the summary, not from this query: it
 * has to be right while the section is shut, which is the whole point of
 * showing it.
 */
function FleetFindingsSection({
  section,
  title,
  description,
  tone,
  count,
  filters,
  columns,
  open,
  onToggle,
  onRowClick,
  selectable,
  selectedIds,
  onSelectionChange,
  bulkActions,
  mobile,
  reloadKey,
  groupKeys = [],
}) {
  const grouped = groupKeys.length > 0;
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadedOnce, setLoadedOnce] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listFindings({ ...filters, section, page, limit: pageSize });
      setRows(data.findings || []);
      setTotal(data.meta?.total ?? data.total ?? 0);
      setLoadedOnce(true);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Could not load this section');
    } finally {
      setLoading(false);
    }
  }, [filters, section, page, pageSize]);

  useEffect(() => {
    if (!open || grouped) return;
    load();
  }, [open, grouped, load, reloadKey]);

  // Changing a filter while a section is open must not leave it on page 4 of
  // a result that no longer has four pages.
  useEffect(() => {
    setPage(1);
  }, [filters]);

  // Grouped: the tree comes from /findings/groups with this section and the
  // page's filters, over the whole filtered set; each open leaf loads its own
  // rows through the ordinary list with the group's values added.
  const groupSig = groupKeys.join(',');
  const [tree, setTree] = useState(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState('');
  const treeSeq = useRef(0);
  useEffect(() => {
    if (!open || !grouped) return;
    const mine = ++treeSeq.current;
    setTreeLoading(true);
    setTreeError('');
    getFindingGroups({ ...filters, section, groupBy: groupSig })
      .then((data) => {
        if (mine === treeSeq.current) setTree(data?.tree || []);
      })
      .catch((err) => {
        if (mine === treeSeq.current) {
          setTreeError(err.response?.data?.error?.message || err.message || 'Could not group this section');
        }
      })
      .finally(() => {
        if (mine === treeSeq.current) setTreeLoading(false);
      });
  }, [open, grouped, filters, section, groupSig, reloadKey]);

  // The rows each leaf has loaded, by id — leaf tables hold their own rows,
  // and bulk actions need the findings behind the selected ids.
  const leafRows = useRef(new Map());
  const filterSig = JSON.stringify(filters || {});
  const renderLeaf = (node, path) => (
    <GroupLeafTable
      columns={columns}
      reloadKey={`${reloadKey}|${filterSig}|${groupSig}|${pathId(path)}`}
      fetchPage={async ({ page: p, pageSize: size }) => {
        const data = await listFindings({
          ...filters,
          ...groupFilters(path, FINDING_GROUP_PARAM),
          section,
          page: p,
          limit: size,
        });
        const items = data.findings || [];
        for (const row of items) leafRows.current.set(row.id, row);
        return { items, total: data.meta?.total ?? data.total ?? 0 };
      }}
      emptyMessage="Nothing in this group any more"
      onRowClick={onRowClick}
      selectable={selectable}
      selectedIds={selectedIds}
      onSelectionChange={(ids) => onSelectionChange?.(ids, [...leafRows.current.values()])}
      mobile={mobile}
    />
  );

  return (
    <FindingSection
      title={title}
      description={description}
      count={count}
      tone={tone}
      open={open}
      onToggle={onToggle}
    >
      {grouped ? (
        <div className="space-y-2">
          {/* One bar for the whole section, not one per group table. */}
          {selectable && selectedIds?.length > 0 && bulkActions}
          <GroupedView
            tree={tree}
            loading={treeLoading}
            error={treeError}
            renderLeaf={renderLeaf}
            renderLabel={renderGroupLabel}
            dimLabel={findingGroupDimLabel}
            emptyMessage="Nothing in this section matches the current filters"
          />
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          loading={loading && !loadedOnce}
          showSearch={false}
          emptyMessage="Nothing in this section matches the current filters"
          onRowClick={onRowClick}
          selectable={selectable}
          selectedIds={selectedIds}
          // The rows travel with the ids: bulk actions need the findings
          // themselves (to tell which ones "Mark expected" can act on), and
          // the page never holds this section's rows.
          onSelectionChange={(ids) => onSelectionChange?.(ids, rows)}
          bulkActions={bulkActions}
          mobile={mobile}
          serverPagination={{
            page,
            total,
            onPageChange: setPage,
            pageSize,
            onPageSizeChange: (size) => {
              setPageSize(size);
              setPage(1);
            },
          }}
        />
      )}
    </FindingSection>
  );
}

export default FleetFindingsSection;
