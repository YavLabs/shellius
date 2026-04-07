# Task 18R-*: Reviewer gates for Phase 18

**Agent:** reviewer
**Status:** [ ] Pending
**Blocked By:** matching implementation + QA gate
**Model:** sonnet

Same workflow as 14R–17R. Per-task scope below.

## 18R-A — DataTable rows-per-page
- Verify no double-fetch on the page-size change (parent re-renders
  exactly once with the new size)
- No regression on client-side mode pages
- Page-size > server max (e.g. user types 1000) is clamped or
  rejected by the backend

## 18R-B — Sidebar collapse
- Accessibility: keyboard nav (Tab through items) still works in
  collapsed mode; tooltips appear on focus, not just hover
- ARIA labels present on every collapsed nav item

## 18R-C — QuickConnect AR validity
- Backend: `getActiveByServerForUser` orgId scoping intact (Phase
  15R-D fix)
- Backend: query uses `expiresAt: { gt: now }` and not `>=` (a
  request expiring exactly at the query instant is excluded)
- Frontend: the 60s polling doesn't leak intervals on unmount

## 18R-D — Policy Evaluator outcome
- Verify the route still requires admin+
- No PII leaked in the evaluator response (only the matched policy
  id + constraints, no other users' info)

## 18R-E — Private-IP VPN warning
- The `isPrivateIP` regex covers every documented range AND nothing
  more (no false positives that hide real public IPs)
- Warning text doesn't expose internal infrastructure details to
  unauthenticated users (the warning is only rendered on authenticated
  pages — verify)
