import { useMemo } from 'react';
import useMobilePages from '@/hooks/useMobilePages';
import { cn } from '@/lib/utils';
import {
  countActiveFilters,
  groupRows,
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
import FilterControl from '@/components/shared/FilterControl';
import {
  MobileBulkBar,
  MobileFiltersButton,
  MobileLoadMore,
  MobileSearch,
  MobileSelectAll,
  MobileSortMenu,
} from '@/components/mobile/MobileListControls';

/**
 * DataTable's mobile body: toolbar + card list + bulk bar. All state (search,
 * sort, page, selection) stays in DataTable; this only renders it.
 *
 * No page numbers on phones: the list grows as you scroll (with a "Load more"
 * button as the fallback). Client lists show pages 1..page; server lists keep
 * the pages fetched so far and ask for the next one.
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
  filterDefs,
  filterValues,
  onFilterChange,
  toolbarActions,
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

  const serverRows = useMobilePages({
    rows,
    page,
    loading,
    enabled: server,
    // Page 1 already starts over (search / filters); a server sort may not.
    resetKey: `${sortKey || ''}:${sortDir || ''}`,
  });
  const shown = server ? serverRows : mobileWindow({ rows, page, pageSize, server });
  const hasMore = server ? page < totalPages : shown.length < total;
  const loadMore = () => (server ? onPage(page + 1) : onLoadMore());
  // A first load (or a new search) shows skeletons; a next page keeps the list.
  const initialLoading = loading && (!server || page <= 1 || shown.length === 0);
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

  // Optional headed sections (e.g. Active / Inactive customers).
  const groups = options?.group ? groupRows(shown, options.group, options.groupOrder) : null;

  const hasFilterDefs = Array.isArray(filterDefs) && filterDefs.length > 0;
  const hasControls = filters || hasFilterDefs || toolbarActions || sorts.length > 0 || selectable;
  // Any card on screen with buttons → every card keeps the action row.
  const reserveActions =
    layout.extras.length > 0 ||
    (!!layout.actionsColumn &&
      shown.some((row) => splitRowActions(layout.actionsColumn.actions, row, { maxPrimary }).primary.length > 0));

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
    const accent = options?.accent ? options.accent(row) : null;
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
        accent={accent}
        titleClamp={options?.titleClamp}
        corner={options?.corner ? options.corner(row) : null}
        reserveActions={reserveActions}
        onClick={cardClick ? () => cardClick(row) : undefined}
        selectable={selectable}
        selected={isSelected}
        onSelectChange={() => toggleRow(row.id)}
        className={options?.cardClassName?.(row)}
      />
    );
  };

  const showSearch = options?.showSearch !== false;

  return (
    <div className={cn('space-y-3', className)}>
      <div className="space-y-2">
        {showSearch && <MobileSearch value={search} onChange={onSearch} placeholder={searchPlaceholder} />}
        {hasControls && (
          <div className="flex min-w-0 items-center gap-2">
            {hasFilterDefs ? (
              // Same control as desktop; FilterDrawer renders as the app's
              // bottom sheet below `md`, so the two cannot drift apart.
              <FilterControl defs={filterDefs} values={filterValues || {}} onChange={onFilterChange} />
            ) : (
              <MobileFiltersButton filters={filters} activeCount={filterCount} onReset={onResetFilters} />
            )}
            <MobileSortMenu
              options={sorts}
              sortKey={sortKey}
              sortDir={sortDir}
              onSelect={onSortSelect}
              onClear={onSortClear}
            />
            {/* Table-level buttons (Export, …) used to be desktop-only: the
                toolbar slot simply was not forwarded here, so the action
                disappeared below `md` with nothing to say it had. */}
            {toolbarActions && (
              <div className="flex min-w-0 items-center gap-2 [&_button]:h-9">{toolbarActions}</div>
            )}
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

      {initialLoading ? (
        <MobileCardSkeleton count={Math.min(pageSize, 6)} withLeading={!!(options?.leading || layout.leading)} />
      ) : shown.length === 0 ? (
        <MobileEmptyCard>{emptyContent}</MobileEmptyCard>
      ) : (
        groups ? (
          <div className="space-y-4">
            {groups.map((g) => (
              <section key={g.key} aria-label={g.label} className="space-y-2">
                <h3 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {g.label}
                  <span className="rounded-full bg-muted px-1.5 py-px text-[11px] font-medium tabular-nums">{g.rows.length}</span>
                </h3>
                <MobileCardList uniform>{g.rows.map(renderCard)}</MobileCardList>
              </section>
            ))}
          </div>
        ) : (
          <MobileCardList uniform>{shown.map(renderCard)}</MobileCardList>
        )
      )}

      {!initialLoading && total > 0 && (
        <MobileLoadMore shown={shown.length} total={total} hasMore={hasMore} loading={loading} onMore={loadMore} />
      )}

      {selectable && selectedIds.length > 0 && bulkActions && <MobileBulkBar>{bulkActions}</MobileBulkBar>}
    </div>
  );
}
