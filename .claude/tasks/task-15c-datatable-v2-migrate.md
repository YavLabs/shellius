# Task 15C: DataTable v2 — Migrate Every List Page

**Agent:** frontend
**Status:** [x] Done
**Blocks:** 15Q-C, 15R-C
**Blocked By:** 15B
**Model:** sonnet (default)

## Objective
Migrate every list page to the v2 `DataTable` component from Task 15B,
removing each page's bespoke filter bar, pagination buttons, and
ad-hoc row action menu.

## Pages
- `frontend/src/pages/Servers.jsx`
- `frontend/src/pages/Customers.jsx`
- `frontend/src/pages/Users.jsx`
- `frontend/src/pages/Groups.jsx`
- `frontend/src/pages/GroupDetail.jsx` (members table)
- `frontend/src/pages/AccessRequests.jsx`
- `frontend/src/pages/Policies.jsx`
- `frontend/src/pages/Certificates.jsx`
- `frontend/src/pages/Sessions.jsx`
- `frontend/src/pages/AuditLog.jsx`
- `frontend/src/pages/Notifications.jsx`
- `frontend/src/pages/CustomerDetail.jsx` (servers table)
- `frontend/src/pages/ServerDetail.jsx` (only if there are tables;
  currently doesn't have one)

## Per-page checklist
1. Drop the page's bespoke pagination JSX, search input, and filter
   bar — pass them as `filters={...}` JSX to the new DataTable.
2. Replace the action column's inline `<DropdownMenu>` with the
   `actions: [...]` shorthand on the column definition. Use these
   icons consistently:
   - View / Open detail → `Eye`
   - Edit → `Pencil`
   - Delete → `Trash2` (variant: destructive)
   - Health check → `Activity`
   - Bootstrap host → `Download`
   - Request access → `KeyRound`
   - Connect (open terminal) → `Terminal`
   - Resend invite → `Mail`
   - Reset password → `KeyRound`
   - Revoke (cert / AR) → `Ban`
   - Terminate (session) → `Square`
   - Copy → `Copy`
3. Move the page's "Add X" button to a header action above the table
   (`PageHeader` slot).
4. Make every column header sortable where it makes sense (no sort on
   icon-only or actions columns).
5. Add a `searchAccessor` to columns that hold non-string content
   (badges, numbers).
6. Convert the page's pagination state to either `serverPagination={...}`
   (for endpoints that support `?page=&limit=`) or fully client-side.

## Special cases
- **AuditLog**: keep its action filter as a native `<select>` because
  Radix `SelectItem` does not support `<optgroup>`. Pass it through the
  `filters` slot.
- **AccessRequests**: keeps its tab bar above the table. The DataTable
  is rendered once per active tab.
- **Sessions**: terminate button stays as an action menu item; add
  `Square` icon.

## Acceptance
- Every list page renders identical functional behavior, plus:
  - Search bar with debounced filter
  - Page-size dropdown (10/20/50/100)
  - Sortable headers on text/numeric columns
  - Action menu icons consistent across pages
- No page contains its own pagination button JSX.
- No regressions in row click navigation, modal opens, bulk actions.
