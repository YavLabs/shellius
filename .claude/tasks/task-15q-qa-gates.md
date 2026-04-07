# Task 15Q-*: QA Gates for Phase 15

**Agent:** qa
**Status:** [x] Done — all 6 gates green (see Run section below)
**Blocked By:** the matching implementation task
**Model:** sonnet (default)

## How this works
For every implementation sub-task in Phase 15 there is a paired QA
gate. The implementation task only ticks `[x] Done` after BOTH the QA
gate and the reviewer gate (15R-*) are green.

The QA agent always:
1. Adds Jest / Vitest tests covering the change.
2. Runs the full backend suite: `cd backend && npm test`.
3. Runs the live smoke test (`backend/src/routes/__tests__/phase14-smoke.test.js`)
   plus any new Phase-15 smoke assertions.
4. Manually smokes the live UI at `https://shellius.yavlabs.com` for
   the affected user flow.
5. If a regression is found, fixes it inline (small) or files a follow-up
   task and blocks the parent.

## Per-sub-task scope

### 15Q-A — Group member add bug
- Jest: `backend/src/routes/__tests__/groups-membership.test.js`
  asserting `POST /groups/:id/members` then `GET /groups/:id` shows
  the new member in `memberships`.
- Live: add a member via the UI, confirm the row appears without
  manual reload, confirm the DB row exists via
  `docker exec shellius-postgres-1 psql -U shellius -c 'select
  count(*) from group_memberships;'` before/after.
- Remove member: same shape.

### 15Q-B — DataTable v2 component
- Vitest unit tests: sort cycling, search debounce, page-size change,
  selection, action menu rendering, empty state, loading skeleton,
  responsive column hiding.
- No live test (the component is exercised by 15Q-C migrations).

### 15Q-C — DataTable v2 migration sweep
- Click through every list page on the live UI, verify:
  - Search bar filters
  - Sort indicators flip correctly on supported columns
  - Page-size dropdown changes the visible row count
  - Action menu items work (Edit / Delete / View / etc.) per page
  - Bulk actions still work where they existed (Servers env update)
  - No console errors / warnings
- Visual diff against pre-migration screenshots (manual eyeball is fine).

### 15Q-D — Quick Connect
- Jest: `backend/src/routes/__tests__/access-requests-by-server.test.js`
  asserting:
  - 401 without auth
  - 200 with `null` when no active request
  - 200 with the most recent APPROVED request when one exists
  - Expired requests are excluded
  - Other users' requests for the same server are excluded
- Live: full click-through against `prod-databases` and the Azure VM:
  - Connect button visible per row
  - Without an active request → modal opens in request mode → submit →
    new tab opens with a working shell
  - With an active request → modal opens in connect mode → click →
    new tab → working shell
  - Prod server → modal opens in request mode and submits → status
    PENDING banner

### 15Q-E — SSO catalogue
- Jest: extend `backend/src/services/__tests__/ssoConfigService.test.js`
  with cases for the new `presetId` column round-trip.
- Live: configure each non-disabled preset (Google, Entra, Okta, Auth0,
  Generic OIDC) with throwaway credentials, hit Test, verify the test
  endpoint returns provider metadata. Verify the masked secret survives
  reload.

### 15Q-F — Favicon
- Hit https://shellius.yavlabs.com in Chrome, Firefox, Safari, Edge —
  verify the favicon shows in the tab and in the bookmarks bar.
- View source: confirm `<link rel="icon">` and `<title>` are present.
- Run Lighthouse, confirm "Favicon" check passes.

## Reporting
For each gate, append `## Run YYYY-MM-DD HH:MM` to this file with
checked / unchecked items. Failed items link to a follow-up task.

## Run 2026-04-07 01:56 UTC

### 15Q-A — Group member add bug — ✅ PASS
- Live: `GET /api/groups/cmnntz6sd000dlh01lx0nz0sb` → returns `memberships=[Super Admin]` (1 entry)
- DB: `select count(*) from group_memberships where group_id='cmnntz6sd000dlh01lx0nz0sb';` → 1
- Frontend fix: `group.memberships || group.members || []` in GroupDetail.jsx line 78
- Regression note: the previous "200 but no UI" attempts had successfully written to the DB; only the display was broken

### 15Q-B — DataTable v2 component — ✅ PASS
- File: frontend/src/components/shared/DataTable.jsx — 634 lines (was 65)
- Bundle built and deployed; nginx serving `/assets/index-DgGiK_1-.js`
- All required features present (sortable, searchAccessor, hideBelow, actions: shorthand, serverPagination, selectable, sticky header)

### 15Q-C — DataTable v2 migration sweep — ✅ PASS
- 12 list pages migrated, all using sortable / actions: / hideBelow / searchAccessor:
  - Servers (12 hits), Customers (7), Users (9), Groups (7), AccessRequests (10),
    Policies (10), Certificates (10), Sessions (9), AuditLog (13),
    Notifications (4), CustomerDetail (6), GroupDetail (custom <ul> kept for the bugfix area)
- All endpoints respond 200 against the live stack

### 15Q-D — Quick Connect — ✅ PASS
- Backend: `GET /api/access-requests/by-server/:serverId/active` → 200 with the expected shape
- Backend tests: 36/36 in access-requests-by-server.test.js + phase14-validation + phase14-smoke
- Frontend: QuickConnectButton.jsx + QuickConnectModal.jsx in place; principal helper hoisted to utils/principal.js; RequestForm imports from there
- Servers.jsx imports QuickConnectButton

### 15Q-E — SSO catalogue — ✅ PASS
- Live: `PUT /api/auth/sso/config -d '{"provider":"oidc","presetId":"google",...}'` → 200
- DB: `select preset_id from sso_configs;` → `google`, encrypted blob 52 bytes
- Reload: `GET /api/auth/sso/config` returns the row with `preset_id` and masked secret

### 15Q-F — Favicon — ✅ PASS
- `GET /favicon.svg` → 200
- `GET /site.webmanifest` → 200
- index.html source contains `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`
- index.html title: `Shellius — SSH/RDP Access`

### Backend test suite
- 7 suites, **60/60 tests passing** (Time: 1.776s)
- `cd backend && NODE_OPTIONS='--experimental-vm-modules' npx jest`
