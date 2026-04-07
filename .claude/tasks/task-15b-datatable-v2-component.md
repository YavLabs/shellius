# Task 15B: DataTable v2 — Build the Component

**Agent:** frontend
**Status:** [x] Done
**Blocks:** 15C, 15Q-B, 15R-B
**Blocked By:** None
**Model:** sonnet (default)

## Objective
Replace the dumb `frontend/src/components/shared/DataTable.jsx` with a
feature-rich version matching Vaulthive's
`frontend/src/components/ui/data-table.jsx`. This component is then
used by every list page in Phase 15C.

## Reference
- `/home/yavadmin/vaulthive/frontend/src/components/ui/data-table.jsx`
  is the canonical implementation. Read it first.
- The Phase-12 audit doc already pulled the relevant patterns into
  `.claude/tasks/task-12*` notes — check them.

## Required features
- **Header**: column labels with sort indicators (asc/desc/none) when
  the column is sortable. Click cycles asc → desc → unsorted.
- **Global search**: debounced 200ms `<Input>` with leading
  `<Search>` icon, filters across all string-renderable columns or
  via a `searchAccessor: (row) => string` per column.
- **Filters slot**: a `filters` prop accepting JSX rendered above the
  search bar (page-specific Selects).
- **Pagination footer**: "Showing X-Y of Z" + page-size `<Select>`
  (10/20/50/100) + Previous / Next / direct page-number input.
- **Sort**: client-side default; `serverSort` prop for server-driven
  sort with `onSortChange(column, direction)`.
- **Row click handler**: optional `onRowClick(row)`.
- **Action menu**: per-row `<DropdownMenu>` rendered automatically when
  the column has `key: 'actions'` and `render` returns nothing — instead
  the column accepts `actions: [{ label, icon, onClick, variant?, separator? }]`
  and the component builds the menu.
- **Loading skeleton**: matched to column count with shimmer.
- **Empty state**: `emptyMessage` (string) or `emptyState` (JSX).
- **Row selection**: optional `selectable` boolean → renders a checkbox
  column, controlled `selectedIds`/`onSelectionChange`. When selection
  is non-empty, render a `bulkActions` slot above the table.
- **Sticky header** when the table scrolls in a constrained container.
- **Responsive**: hide columns marked `hideBelow: 'md' | 'lg'` on
  narrow viewports.

## API surface (proposed)
```jsx
<DataTable
  columns={[
    { key: 'name', label: 'Name', sortable: true, render: (r) => ... },
    { key: 'env', label: 'Env', filterable: true, render: ... },
    { key: 'actions', actions: [
        { label: 'Edit', icon: Pencil, onClick: (r) => ... },
        { label: 'Delete', icon: Trash2, variant: 'destructive', onClick: ... },
      ]
    },
  ]}
  data={rows}
  loading={loading}
  emptyMessage="No servers found"
  searchPlaceholder="Search hostname or IP..."
  filters={<><Select .../><Select .../></>}
  bulkActions={selected.length > 0 ? <BulkBar /> : null}
  selectable
  selectedIds={selected}
  onSelectionChange={setSelected}
  onRowClick={(r) => navigate(`/servers/${r.id}`)}
  pageSizeOptions={[10, 20, 50, 100]}
  defaultPageSize={20}
  // server-side mode (used when `serverSort` or `serverPagination` is set)
  serverPagination={{
    page, total, onPageChange: setPage,
  }}
/>
```

## Backwards compatibility
Existing pages call `<DataTable columns data loading emptyMessage />`
with simple props. The new component must accept that exact shape and
fall back to client-side mode when no server-side props are passed —
otherwise the migration in 15C breaks every page at once.

## Files
- `frontend/src/components/shared/DataTable.jsx` — the rewrite
- `frontend/src/components/shared/DataTable.test.jsx` — Vitest unit
  tests for sort, filter, pagination, selection, action menu rendering

## Acceptance
- Drop-in compatible with existing call sites (no required prop change).
- All features above work in isolation (Vitest unit tests pass).
- Bundle size delta < 15 KB gzipped.
- No new npm dependencies (use existing Radix + lucide).
