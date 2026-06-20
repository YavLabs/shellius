import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  MoreHorizontal,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

// ---------------------------------------------------------------------------
// ActionMenu — built automatically for columns with key:'actions' + actions:[...]
// ---------------------------------------------------------------------------

function ActionMenu({ actions, row }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {actions.map((action, idx) => {
          if (action.separator) {
            return <DropdownMenuSeparator key={`sep-${idx}`} />;
          }
          const Icon = action.icon;
          const isDestructive = action.variant === 'destructive';
          return (
            <DropdownMenuItem
              key={action.label}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick(row);
              }}
              className={
                isDestructive
                  ? 'text-destructive focus:text-destructive focus:bg-destructive/10'
                  : undefined
              }
            >
              {Icon && <Icon className="mr-2 h-4 w-4" />}
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton row
// ---------------------------------------------------------------------------

function SkeletonRow({ columnCount }) {
  return (
    <tr className="border-b border-border">
      {Array.from({ length: columnCount }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 animate-pulse rounded bg-muted" style={{ width: `${60 + (i * 17) % 40}%` }} />
        </td>
      ))}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Debounce hook
// ---------------------------------------------------------------------------

function useDebounced(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// ---------------------------------------------------------------------------
// DataTable v2
// ---------------------------------------------------------------------------

/**
 * Feature-rich DataTable.
 *
 * Backwards-compatible with the old API:
 *   <DataTable columns data loading emptyMessage />
 *
 * New features:
 *   - Built-in debounced search (200ms)
 *   - `filters` slot for page-level Selects rendered above the search
 *   - Sortable column headers (client-side or server-side via `serverSort`)
 *   - Pagination footer: "Showing X-Y of Z" + page-size select + prev/next + direct input
 *   - `serverPagination={{page, total, onPageChange}}` for server-driven pagination
 *   - Row click via `onRowClick(row)`
 *   - Action menu shorthand: column `key:'actions'` + `actions:[{label,icon,onClick,variant?,separator?}]`
 *   - Loading skeleton matched to column count
 *   - `emptyMessage` (string) or `emptyState` (JSX)
 *   - Row selection: `selectable`, `selectedIds`, `onSelectionChange`, `bulkActions` slot
 *   - Sticky header
 *   - Responsive: `hideBelow:'md'|'lg'` on column hides it on narrow viewports
 */
function DataTable({
  // Core
  columns = [],
  data = [],
  loading = false,

  // Empty state
  emptyMessage = 'No data',
  emptyState,

  // Search
  searchPlaceholder = 'Search...',

  // Filters slot (JSX rendered above the search)
  filters,

  // Bulk actions slot (rendered when selection is non-empty)
  bulkActions,

  // Row selection (controlled)
  selectable = false,
  selectedIds = [],
  onSelectionChange,

  // Row click
  onRowClick,

  // Pagination
  defaultPageSize = 20,
  pageSizeOptions = PAGE_SIZE_OPTIONS,

  // Server-side pagination — pass this object to enable server mode
  // { page: number, total: number, onPageChange: (n) => void }
  serverPagination,

  // Server-side sort — pass this object to enable server sort
  // { sortKey, sortDir, onSortChange: (key, dir) => void }
  serverSort,

  // className for the wrapper
  className,
}) {
  // -------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------
  const [searchRaw, setSearchRaw] = useState('');
  const search = useDebounced(searchRaw, 200);

  // -------------------------------------------------------------------
  // Sort (local state used in client mode)
  // -------------------------------------------------------------------
  const [localSortKey, setLocalSortKey] = useState(null);
  const [localSortDir, setLocalSortDir] = useState('asc');

  const isServerSort = !!serverSort;
  const sortKey = isServerSort ? serverSort.sortKey : localSortKey;
  const sortDir = isServerSort ? serverSort.sortDir : localSortDir;

  // -------------------------------------------------------------------
  // Pagination (local state used in client mode)
  // -------------------------------------------------------------------
  const [localPage, setLocalPage] = useState(1);
  const [localPageSize, setLocalPageSize] = useState(defaultPageSize);

  const isServerPagination = !!serverPagination;
  const page = isServerPagination ? serverPagination.page : localPage;
  // In server mode, honour the parent-controlled pageSize when provided (Task 18A)
  const pageSize =
    isServerPagination && serverPagination.pageSize != null
      ? serverPagination.pageSize
      : localPageSize;
  const serverTotal = isServerPagination ? serverPagination.total : undefined;

  // Reset to page 1 when search/sort changes (client mode only)
  const prevSearch = useRef(search);
  const prevSortKey = useRef(sortKey);
  useEffect(() => {
    if (!isServerPagination) {
      if (prevSearch.current !== search || prevSortKey.current !== sortKey) {
        setLocalPage(1);
      }
    }
    prevSearch.current = search;
    prevSortKey.current = sortKey;
  }, [search, sortKey, isServerPagination]);

  // -------------------------------------------------------------------
  // Handle sort click
  // -------------------------------------------------------------------
  const handleSort = useCallback(
    (colKey) => {
      if (isServerSort) {
        const newDir =
          serverSort.sortKey === colKey && serverSort.sortDir === 'asc' ? 'desc' : 'asc';
        serverSort.onSortChange(colKey, newDir);
      } else {
        if (localSortKey === colKey) {
          if (localSortDir === 'asc') {
            setLocalSortDir('desc');
          } else {
            // cycle: asc → desc → none
            setLocalSortKey(null);
            setLocalSortDir('asc');
          }
        } else {
          setLocalSortKey(colKey);
          setLocalSortDir('asc');
        }
      }
    },
    [isServerSort, serverSort, localSortKey, localSortDir]
  );

  // -------------------------------------------------------------------
  // Client-side filter + sort + paginate
  // -------------------------------------------------------------------

  // Build a quick search accessor for each column
  const getSearchString = useCallback(
    (row) => {
      return columns
        .map((col) => {
          if (col.searchAccessor) return col.searchAccessor(row);
          if (col.key && typeof row[col.key] === 'string') return row[col.key];
          if (col.key && typeof row[col.key] === 'number') return String(row[col.key]);
          return '';
        })
        .join(' ');
    },
    [columns]
  );

  const processedData = useMemo(() => {
    let result = data;

    // Filter
    if (search && !isServerPagination) {
      const q = search.toLowerCase();
      result = result.filter((row) => getSearchString(row).toLowerCase().includes(q));
    }

    // Sort
    if (!isServerSort && sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      const sorted = [...result].sort((a, b) => {
        if (col?.sortFn) return col.sortFn(a, b);
        const aVal = a[sortKey];
        const bVal = b[sortKey];
        if (aVal == null && bVal == null) return 0;
        if (aVal == null) return 1;
        if (bVal == null) return -1;
        if (typeof aVal === 'string') return aVal.localeCompare(bVal);
        return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
      });
      result = sortDir === 'desc' ? sorted.reverse() : sorted;
    }

    return result;
  }, [data, search, isServerPagination, isServerSort, sortKey, sortDir, columns, getSearchString]);

  const total = isServerPagination ? (serverTotal ?? 0) : processedData.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(page * pageSize, total);

  const displayData = useMemo(() => {
    if (isServerPagination) return data;
    const start = (page - 1) * pageSize;
    return processedData.slice(start, start + pageSize);
  }, [isServerPagination, data, processedData, page, pageSize]);

  // -------------------------------------------------------------------
  // Page change
  // -------------------------------------------------------------------
  const goToPage = useCallback(
    (p) => {
      const clamped = Math.max(1, Math.min(p, totalPages));
      if (isServerPagination) {
        serverPagination.onPageChange(clamped);
      } else {
        setLocalPage(clamped);
      }
    },
    [isServerPagination, serverPagination, totalPages]
  );

  const handlePageSizeChange = useCallback(
    (val) => {
      const numVal = Number(val);
      setLocalPageSize(numVal);
      if (isServerPagination) {
        // Propagate to parent if callback provided (Task 18A)
        if (typeof serverPagination.onPageSizeChange === 'function') {
          serverPagination.onPageSizeChange(numVal);
        }
        setLocalPage(1);
        serverPagination.onPageChange(1);
      } else {
        setLocalPage(1);
      }
    },
    [isServerPagination, serverPagination]
  );

  // -------------------------------------------------------------------
  // Direct page input
  // -------------------------------------------------------------------
  const [pageInput, setPageInput] = useState('');
  const handlePageInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      const n = parseInt(pageInput, 10);
      if (!Number.isNaN(n)) goToPage(n);
      setPageInput('');
    }
  };

  // -------------------------------------------------------------------
  // Selection helpers
  // -------------------------------------------------------------------
  const visibleIds = displayData.map((r) => r.id).filter(Boolean);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const someSelected = visibleIds.some((id) => selectedIds.includes(id));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    if (allSelected) {
      onSelectionChange(selectedIds.filter((id) => !visibleIds.includes(id)));
    } else {
      const next = new Set([...selectedIds, ...visibleIds]);
      onSelectionChange([...next]);
    }
  };

  const toggleRow = (id) => {
    if (!onSelectionChange) return;
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((x) => x !== id));
    } else {
      onSelectionChange([...selectedIds, id]);
    }
  };

  // -------------------------------------------------------------------
  // Responsive hide helpers
  // -------------------------------------------------------------------
  const hideClass = (col) => {
    if (col.hideBelow === 'md') return 'hidden md:table-cell';
    if (col.hideBelow === 'lg') return 'hidden lg:table-cell';
    return '';
  };

  // Visible columns (for layout purposes — still render all, just hide via CSS)
  const effectiveColumns = useMemo(() => {
    const base = [...columns];
    if (selectable) {
      return [{ key: '__select__', label: '', className: 'w-10' }, ...base];
    }
    return base;
  }, [columns, selectable]);

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------
  return (
    <div className={cn('space-y-0', className)}>
      {/* Toolbar: filters slot + search */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap">
        {filters && <div className="flex flex-wrap items-center gap-2">{filters}</div>}
        <div className="relative min-w-0 flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchRaw}
            onChange={(e) => setSearchRaw(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="pl-9 h-9"
            type="search"
          />
        </div>
      </div>

      {/* Bulk actions bar */}
      {selectable && selectedIds.length > 0 && bulkActions && (
        <div className="mb-3">{bulkActions}</div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            {/* Sticky header */}
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-border bg-muted/30 backdrop-blur">
                {effectiveColumns.map((col) => {
                  if (col.key === '__select__') {
                    return (
                      <th key="__select__" className="w-10 px-4 py-2.5">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected && !allSelected;
                          }}
                          onChange={toggleAll}
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </th>
                    );
                  }

                  const isSortable = col.sortable && col.key !== 'actions';
                  const isSorted = sortKey === col.key;

                  // Sortable headers must be keyboard-operable (Task 15R-B):
                  // wrap the inner content in a real <button> so Tab+Enter/Space
                  // work, and surface the current sort state via aria-sort.
                  const ariaSort = isSorted
                    ? sortDir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none';
                  const headerInner = (
                    <div className="flex items-center gap-1">
                      <span>{col.label}</span>
                      {isSortable && (
                        <span className="ml-0.5 inline-flex shrink-0">
                          {isSorted ? (
                            sortDir === 'asc' ? (
                              <ArrowUp className="h-3 w-3 text-foreground" />
                            ) : (
                              <ArrowDown className="h-3 w-3 text-foreground" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3 w-3 text-muted-foreground/40" />
                          )}
                        </span>
                      )}
                    </div>
                  );

                  return (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={isSortable ? ariaSort : undefined}
                      className={cn(
                        'px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground select-none',
                        col.className,
                        hideClass(col)
                      )}
                    >
                      {isSortable ? (
                        <button
                          type="button"
                          onClick={() => handleSort(col.key)}
                          className="-mx-1 flex items-center gap-1 rounded-sm px-1 text-left uppercase tracking-wider hover:bg-muted/60 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                          aria-label={`Sort by ${typeof col.label === 'string' ? col.label : col.key}`}
                        >
                          {headerInner}
                        </button>
                      ) : (
                        headerInner
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: Math.min(pageSize, 8) }).map((_, i) => (
                  <SkeletonRow key={i} columnCount={effectiveColumns.length} />
                ))
              ) : displayData.length === 0 ? (
                <tr>
                  <td
                    colSpan={effectiveColumns.length}
                    className="px-4 py-12 text-center text-sm text-muted-foreground"
                  >
                    {emptyState ?? emptyMessage}
                  </td>
                </tr>
              ) : (
                displayData.map((row, idx) => {
                  const rowKey = row.id ?? idx;
                  const isSelected = selectable && row.id && selectedIds.includes(row.id);

                  return (
                    <tr
                      key={rowKey}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      className={cn(
                        'border-b border-border transition-colors last:border-0',
                        onRowClick && 'cursor-pointer',
                        isSelected ? 'bg-primary/5' : 'hover:bg-accent/30'
                      )}
                    >
                      {effectiveColumns.map((col) => {
                        if (col.key === '__select__') {
                          return (
                            <td key="__select__" className="px-4 py-3">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleRow(row.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="h-4 w-4 cursor-pointer accent-primary"
                              />
                            </td>
                          );
                        }

                        // Action menu shorthand
                        if (col.key === 'actions' && col.actions) {
                          return (
                            <td
                              key={col.key}
                              className={cn(
                                'px-4 py-3 text-foreground',
                                col.cellClassName,
                                hideClass(col)
                              )}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ActionMenu actions={col.actions} row={row} />
                            </td>
                          );
                        }

                        return (
                          <td
                            key={col.key}
                            className={cn(
                              'px-4 py-3 text-foreground',
                              col.cellClassName,
                              hideClass(col)
                            )}
                          >
                            {col.render ? col.render(row) : row[col.key]}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination footer */}
      {!loading && total > 0 && (
        <div className="flex flex-col gap-2 pt-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          {/* Left: page size selector */}
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap">Rows per page</span>
            <SearchableSelect
              className="h-8 w-[72px] text-xs"
              value={String(pageSize)}
              onChange={handlePageSizeChange}
              searchable={false}
              clearable={false}
              options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </div>

          {/* Center: showing X-Y of Z */}
          <span className="whitespace-nowrap tabular-nums">
            Showing {startRow}–{endRow} of {total}
          </span>

          {/* Right: page navigation */}
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(1)}
              disabled={page <= 1}
              aria-label="First page"
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1 px-1">
              <span className="text-xs">Page</span>
              <Input
                className="h-8 w-12 px-2 text-center text-xs tabular-nums"
                value={pageInput !== '' ? pageInput : String(page)}
                onChange={(e) => setPageInput(e.target.value)}
                onKeyDown={handlePageInputKeyDown}
                onBlur={() => setPageInput('')}
              />
              <span className="text-xs">of {totalPages}</span>
            </div>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => goToPage(totalPages)}
              disabled={page >= totalPages}
              aria-label="Last page"
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default DataTable;
