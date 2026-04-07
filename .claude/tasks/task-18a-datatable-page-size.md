# Task 18A: DataTable rows-per-page selection

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** 18Q-A, 18R-A
**Blocked By:** None
**Model:** sonnet

## Symptom
Picking 10 / 50 / 100 from the page-size dropdown does not change the
visible row count on server-paginated pages (Servers, AccessRequests,
Users, Policies, Sessions, Certificates, AuditLog). The dropdown
updates the local table state but the parent's data fetch still uses
its hard-coded `pageSize`.

## Root cause
`DataTable.jsx` accepts `serverPagination={{page,total,onPageChange}}`
but does NOT propagate the page-size change back to the parent. The
parent's `fetch()` callback depends on a `pageSize` const, not state,
so it never re-fetches with the new size.

## Fix

### DataTable.jsx
Extend the `serverPagination` contract:
```js
serverPagination={{
  page,
  total,
  onPageChange,
  pageSize,        // optional — falls back to local state
  onPageSizeChange // optional — call when the dropdown changes
}}
```

When `onPageSizeChange` is provided AND a server-pagination block is
in use, the page-size `<Select>`'s onValueChange calls
`onPageSizeChange(Number(v))` instead of (or in addition to) the
local setter, then resets the local page to 1.

### Each server-paginated page
Lift `pageSize` from a const to `useState(20)` and pass:
```js
serverPagination={{
  page,
  total,
  onPageChange: (p) => setPage(p),
  pageSize,
  onPageSizeChange: (size) => { setPageSize(size); setPage(1); },
}}
```
Verify the page's `fetch()` callback `useCallback` deps include
`pageSize` so it re-fetches.

Pages to update:
- frontend/src/pages/Servers.jsx
- frontend/src/pages/AccessRequests.jsx
- frontend/src/pages/Users.jsx
- frontend/src/pages/Policies.jsx
- frontend/src/pages/Sessions.jsx
- frontend/src/pages/Certificates.jsx
- frontend/src/pages/AuditLog.jsx

## Tests
- Vitest unit test on DataTable: when `serverPagination.onPageSizeChange`
  is provided, the dropdown calls it with the right number.
- Live smoke: pick 50 on Servers, see exactly 50 rows fetched and
  rendered.

## Acceptance
- Selecting any page-size on any list page re-fetches and renders the
  matching count.
- Client-side mode (Customers, Groups, Notifications) still works
  unchanged.
