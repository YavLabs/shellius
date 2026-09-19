import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  countActiveFilters,
  mobileWindow,
  resolveCardLayout,
  sortOptions,
  splitRowActions,
  DEFAULT_MAX_META,
  DEFAULT_MAX_PRIMARY,
} from '@/lib/mobileCard';
import {
  CardActionButton,
  CardActionMenu,
  CardMeta,
  MobileCard,
  MobileCardList,
  MobileCardSkeleton,
  MobileEmptyCard,
} from '@/components/mobile/MobileCard';
import {
  MobileBulkBar,
  MobileFiltersButton,
  MobileLoadMore,
  MobilePager,
  MobileSearch,
  MobileSelectAll,
  MobileSortMenu,
} from '@/components/mobile/MobileListControls';

/**
 * DataTable's mobile body: toolbar + card list + paging + bulk bar. All state
 * (search, sort, page, selection) stays in DataTable; this only renders it.
 */
export default function MobileDataList({
  className,
  columns,
  rows,
  loading,
  emptyContent,
  search,
  onSearch,
  searchPlaceholder,
  filters,
  activeFilterCount,
  onResetFilters,
  sortKey,
  sortDir,
  onSortSelect,
  onSortClear,
  server,
  page,
  pageSize,
  total,
  totalPages,
  startRow,
  endRow,
  onPage,
  onLoadMore,
  selectable,
  selectedIds = [],
  onSelectionChange,
  bulkActions,
  onRowClick,
  options = {},
}) {
  const maxMeta = options?.maxMeta ?? DEFAULT_MAX_META;
  const maxPrimary = options?.maxPrimary ?? DEFAULT_MAX_PRIMARY;
  const layout = useMemo(() => resolveCardLayout(columns, { maxMeta }), [columns, maxMeta]);
  const sorts = useMemo(() => sortOptions(columns), [columns]);
  const filterCount = activeFilterCount ?? countActiveFilters(filters);

  const shown = mobileWindow({ rows, page, pageSize, server });
  const shownIds = shown.map((r) => r.id).filter(Boolean);
  const allSelected = shownIds.length > 0 && shownIds.every((id) => selectedIds.includes(id));
  const someSelected = shownIds.some((id) => selectedIds.includes(id));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    if (allSelected) onSelectionChange(selectedIds.filter((id) => !shownIds.includes(id)));
    else onSelectionChange([...new Set([...selectedIds, ...shownIds])]);
  };
  const toggleRow = (id) => {
    if (!onSelectionChange || !id) return;
    onSelectionChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };

  // Tables without a row click on desktop may still give the card a tap target.
  const cardClick = options?.onCardClick || onRowClick;

  const hasControls = filters || sorts.length > 0 || selectable;

  const renderCard = (row, idx) => {
    const { primary, menu } = layout.actionsColumn
      ? splitRowActions(layout.actionsColumn.actions, row, { maxPrimary })
      : { primary: [], menu: [] };
    const extras = layout.extras.map((f) => <span key={f.key}>{f.render(row)}</span>);
    const actionNodes = [
      ...primary.map((a) => <CardActionButton key={a.label} action={a} row={row} />),
      ...extras,
    ];
    const secondary = layout.secondary.map((f) => f.render(row)).filter((v) => v !== null && v !== undefined && v !== '');
    const leading = options?.leading ? options.leading(row) : layout.leading?.render(row);
    const isSelected = !!(selectable && row.id && selectedIds.includes(row.id));
    return (
      <MobileCard
        key={row.id ?? idx}
        leading={leading}
        title={layout.title ? layout.title.render(row) : null}
        secondary={
          secondary.length > 1 ? (
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
              {secondary.map((s, i) => (
                <span key={i} className="flex min-w-0 items-center gap-1.5">
                  {i > 0 && <span aria-hidden="true">·</span>}
                  {s}
                </span>
              ))}
            </span>
          ) : (
            secondary[0]
          )
        }
        meta={layout.meta.map((f) => {
          const showLabel = layout.explicit ? !!f.column.mobile?.showLabel : true;
          return (
            <CardMeta key={f.key} label={showLabel ? f.label : null}>
              {f.render(row)}
            </CardMeta>
          );
        })}
        actions={actionNodes.length > 0 ? actionNodes : null}
        menu={menu.length > 0 ? <CardActionMenu actions={menu} row={row} /> : null}
        onClick={cardClick ? () => cardClick(row) : undefined}
        selectable={selectable}
        selected={isSelected}
        onSelectChange={() => toggleRow(row.id)}
        className={options?.cardClassName?.(row)}
      />
    );
  };

  return (
    <div className={cn('space-y-3', className)}>
      <div className="space-y-2">
        <MobileSearch value={search} onChange={onSearch} placeholder={searchPlaceholder} />
        {hasControls && (
          <div className="flex min-w-0 items-center gap-2">
            <MobileFiltersButton filters={filters} activeCount={filterCount} onReset={onResetFilters} />
            <MobileSortMenu
              options={sorts}
              sortKey={sortKey}
              sortDir={sortDir}
              onSelect={onSortSelect}
              onClear={onSortClear}
            />
            {selectable && (
              <div className="ml-auto">
                <MobileSelectAll
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  onChange={toggleAll}
                  disabled={shownIds.length === 0}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <MobileCardSkeleton count={Math.min(pageSize, 6)} withLeading={!!(options?.leading || layout.leading)} />
      ) : shown.length === 0 ? (
        <MobileEmptyCard>{emptyContent}</MobileEmptyCard>
      ) : (
        <MobileCardList>{shown.map(renderCard)}</MobileCardList>
      )}

      {!loading &&
        total > 0 &&
        (server ? (
          <MobilePager
            page={page}
            totalPages={totalPages}
            startRow={startRow}
            endRow={endRow}
            total={total}
            onPage={onPage}
          />
        ) : (
          <MobileLoadMore shown={shown.length} total={total} onMore={onLoadMore} />
        ))}

      {selectable && selectedIds.length > 0 && bulkActions && <MobileBulkBar>{bulkActions}</MobileBulkBar>}
    </div>
  );
}
