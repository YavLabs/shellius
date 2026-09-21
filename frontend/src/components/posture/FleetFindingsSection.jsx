import { useCallback, useEffect, useState } from 'react';
import DataTable from '@/components/shared/DataTable';
import FindingSection from '@/components/posture/FindingSection';
import { listFindings } from '@/services/postureService';

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
}) {
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
    if (!open) return;
    load();
  }, [open, load, reloadKey]);

  // Changing a filter while a section is open must not leave it on page 4 of
  // a result that no longer has four pages.
  useEffect(() => {
    setPage(1);
  }, [filters]);

  return (
    <FindingSection
      title={title}
      description={description}
      count={count}
      tone={tone}
      open={open}
      onToggle={onToggle}
    >
      {error ? (
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
