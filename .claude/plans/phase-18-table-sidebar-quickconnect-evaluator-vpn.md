# Phase 18: DataTable page-size, Sidebar collapse, QuickConnect AR validity, Policy evaluator outcome, Private-IP VPN warning

Five user-reported items, all in the bug-fix bucket. Same workflow rule
as Phases 14–17: every implementation task is paired with a `qa` gate
(Jest + live smoke) and a `reviewer` gate (security/UX/a11y), and only
ticks Done when both gates are green. All agents already use `sonnet`.

## 1. DataTable rows-per-page selection broken (18A)

**Symptom:** Picking "10" (or any other size) from the page-size
dropdown does not change the visible row count. The table keeps
rendering the original count.

**Suspected cause:** the v2 DataTable was built for both client-side
and server-driven modes (Phase 15B). When a page passes
`serverPagination={{page,total,onPageChange}}` (Servers,
AccessRequests, Users, Policies, Sessions, Certificates, AuditLog),
the local `pageSize` state inside the table is never propagated back
to the parent's data fetch — the parent still passes `pageSize=20`
(or whatever its hard-coded value is) when calling
`listServers({page,pageSize})`. So the dropdown updates the local
state but the row count is still bound by the server response.

**Fix:**
- Add `onPageSizeChange` to `serverPagination` props in `DataTable.jsx`.
  When the dropdown changes, call back into the parent so it can
  update its own `pageSize` state and re-fetch.
- Migrate every server-paginated list page to wire up the new callback
  and lift `pageSize` from a hard-coded const to a `useState`.
- For client-side mode (Customers, Groups, Notifications, GroupDetail,
  CustomerDetail), the existing local handling already works — verify
  it still does and add a regression test.

Owner: **frontend**, **qa**, **reviewer**.

## 2. Sidebar collapse regressions (18B)

**Symptoms:**
- Collapsing the sidebar hides the user avatar entirely
- Icons are not properly aligned/centered in the collapsed rail
- The grouped section headings disappear, but the visual grouping
  (separators, mt-4 gaps) also disappears, so collapsed items run
  together as one undifferentiated list

**Fix in `frontend/src/components/layout/Sidebar.jsx`:**
- Collapsed user card: render an avatar-only square (no name/role text)
  centered in a `h-9 w-9` button at the bottom, with a tooltip
  showing the user's name + role
- NavItem alignment: ensure the icon container has
  `flex items-center justify-center w-full` when collapsed; remove
  any `gap-3` that throws the icon off-center
- Section grouping: even in collapsed mode, render a horizontal
  divider (`<div className="mx-2 my-3 h-px bg-border" />`) between
  sections so the grouping reads visually
- Tooltips on every collapsed item using the existing Radix Tooltip
  primitives so the user can hover to see the label

Owner: **frontend**, **qa**, **reviewer**.

## 3. QuickConnect button shows "Connect" when there's no valid access (18C)

**Symptom:** Even when the access request is expired or the user has
no AR for the server, the row's button label is "Connect" instead of
"Request Access".

**Suspected cause:** `QuickConnectButton.jsx` reads
`activeRequest.status` and tests for `'APPROVED'`, but the backend
endpoint `/api/access-requests/by-server/:serverId/active` (Phase
15D) was specced to **only return APPROVED, non-expired** requests
already. So the backend should be filtering correctly. But:
- The frontend may be caching the result across navigations and
  showing stale state
- OR the endpoint includes the row even when `expiresAt < now()`
  due to a bug in the Prisma where clause
- OR the frontend treats `{accessRequest: null}` as truthy somewhere

**Fix:**
- Audit `getActiveByServerForUser` in
  `backend/src/services/accessRequestService.js` to confirm the
  `expiresAt: { gt: now }` filter is intact and not bypassed
- Add a Jest test that asserts an EXPIRED request is excluded
- In `QuickConnectButton.jsx`, double-guard:
  `const hasAccess = !!activeRequest && activeRequest.status === 'APPROVED'
  && new Date(activeRequest.expiresAt) > new Date()`
- Refetch on the row's `server.id` change AND on a configurable
  interval so a request that expires while the page is open flips
  the button back to "Request Access" without a manual reload

Owner: **debugger → frontend + backend**, **qa**, **reviewer**.

## 4. Policy Evaluator outcome shows null (18D)

**Symptom:** The Phase 14E PolicyEvaluator panel renders the result
card but the outcome label is always `null`.

**Suspected cause:** The frontend reads `result.outcome` but the
backend service returns the field under a different key (e.g.
`effect` or `decision`). Easy unwrap mismatch.

**Fix:**
- Read `backend/src/services/policyService.js` `evaluate()` and find
  the actual return shape
- Update `PolicyEvaluator.jsx` to read from the correct field
- Add a Jest test for the evaluate route's response shape so it can
  never silently change

Owner: **debugger → frontend** (and possibly backend if the contract
itself is bad), **qa**, **reviewer**.

## 5. Private-IP VPN warning everywhere a private server IP is shown (18E)

**Goal:** Whenever a server has a private IP (10/8, 172.16/12,
192.168/16, 169.254/16, 127/8, fc00::/7, ::1), display a warning
banner near the connect / request flow:

> 🛜 **Private network address** — `10.6.30.14` looks like a private
> IP. The Shellius backend can only reach this host if it (or your
> browser, for direct downloads) is on the same network. **Make
> sure you're connected to the appropriate VPN before connecting.**

**Where to surface it:**
- Servers list row hover / detail view (subtle muted-amber pill)
- QuickConnectModal — full warning banner above the Connect button
- AccessRequest creation form (RequestForm.jsx)
- Servers add/edit form (ServerForm.jsx) — soft-warn at create time
- ServerDetail header

**Implementation:**
- New helper `frontend/src/utils/network.js` exporting
  `isPrivateIP(addr): boolean` covering all RFC 1918 + link-local
  + loopback + RFC 4193 IPv6 ULA ranges
- New `frontend/src/components/servers/PrivateIPWarning.jsx` that
  takes an `ipAddress` prop and renders the banner when private,
  nothing when public
- Drop the component into the four locations above

Owner: **frontend**, **qa**, **reviewer**.

## Sub-tasks

| ID  | Title                                                  | Agent     | QA | Review |
|-----|--------------------------------------------------------|-----------|----|--------|
| 18A | DataTable rows-per-page server-pagination wiring       | frontend  | 18Q-A | 18R-A |
| 18B | Sidebar collapse: avatar, icon alignment, group dividers | frontend | 18Q-B | 18R-B |
| 18C | QuickConnect AR validity guard (expiry + status)        | debugger → frontend + backend | 18Q-C | 18R-C |
| 18D | Policy Evaluator outcome unwrap fix                    | debugger → frontend | 18Q-D | 18R-D |
| 18E | Private-IP VPN warning helper + component + 4 placements | frontend | 18Q-E | 18R-E |

## Workflow rule
Same as Phases 14–17. Each implementation task only ticks `[x] Done`
after qa + reviewer gates clear.
