# Task 15R-*: Reviewer Gates for Phase 15

**Agent:** reviewer
**Status:** [x] Done — 5 findings (0 critical, 2 high, 2 medium, 1 low, 1 info), high+low fixed
**Blocked By:** the matching implementation task (and 15Q gate)
**Model:** sonnet (default)

## How this works
Every Phase-15 implementation task gets a focused security / UX /
accessibility review BEFORE it ticks Done. The reviewer fixes
high/critical findings inline (write access enabled), files
medium/low findings here for follow-up, and signs off the gate.

## Per-sub-task scope

### 15R-A — Group member add fix
- Verify the route still enforces RBAC (only admins or the group's
  manager can add members).
- Verify the new code path doesn't accidentally widen the org_id scope.
- Audit log entry on add/remove still fires.

### 15R-B — DataTable v2 component
- Accessibility: keyboard nav (Tab/Shift+Tab/arrow keys/Enter/Space)
  works on header sort buttons, action menu, page-size select,
  pagination buttons. ARIA labels on the search input and pagination
  controls.
- Search debounce ≥ 200ms — confirm no XSS risk via search string
  rendering (must use React's default escaping, never dangerouslySet).
- Action menu items must use stable key props.
- No prop spread on `<table>` that could leak event handlers.

### 15R-C — DataTable v2 migration sweep
- Spot-check 3 pages (Servers / Users / AccessRequests):
  - Action icons match the canonical set
  - Destructive actions are marked variant=destructive
  - Server-pagination-driven pages don't accidentally double-fetch
- Verify no removed page is leaking dead state hooks.

### 15R-D — Quick Connect
- New endpoint: org_id scoped, requesterId locked to the calling user,
  no IDOR (a user can't probe other users' requests by guessing
  serverIds).
- The new tab (`window.open`) carries the JWT only via the same path
  the existing /terminal page uses (refresh-on-mount).
- Modal can't be coerced into submitting a stale principal (validation
  + server-side check from Task 14F still applies).
- Audit log entry on the auto-created access request.

### 15R-E — SSO catalogue
- The new `presetId` column is validated against the catalogue list
  (no arbitrary string injection).
- The wizard's derived issuer URLs (`https://login.microsoftonline.com/${tenantId}/v2.0`)
  are not vulnerable to host injection — `tenantId` must match a UUID
  or alphanumeric pattern.
- The redirect URI shown in the wizard is computed from `TRAEFIK_HOST`
  / `PUBLIC_API_URL`, never echoed user input.
- All preset setup-step text is static — no XSS via stored content.
- Test endpoint still uses `ssoConfigService.guardSsrf` (already
  reviewed in Task 14M).

### 15R-F — Favicon
- No reviewer gate (UX-only). Skipped.

## Reporting
For each gate, append `## Findings YYYY-MM-DD` to this file. Use the
existing severity scale: critical / high / medium / low / info. Block
the parent sub-task on any open critical/high.

## Findings 2026-04-07

Reviewer: sonnet (task-15r)
Scope: 15R-A through 15R-E (15R-F skipped per spec).

---

### 15R-A — Group member add fix

**[medium]** `/home/yavadmin/shellius/backend/src/routes/groups.js:82-103` — No `audit` middleware is attached to `POST /:id/members` or `DELETE /:id/members/:userId`. Every other mutation route (SSO config, access requests, etc.) uses the `audit()` middleware. Group membership changes are sensitive actions (granting group-based access) and should be recorded in the immutable AuditLog. Currently they leave no trace.

**[passed]** RBAC on `POST /:id/members` and `DELETE /:id/members/:userId` is correctly set to `requireRole('super_admin','admin')` — operators and viewers cannot modify group membership.

**[passed]** org_id scoping is correct in `groupService.addMember` and `groupService.removeMember`: both verify the group belongs to the org (`findFirst { where: { id: groupId, orgId } }`) and `addMember` additionally verifies the target user belongs to the same org (`findFirst { where: { id: userId, orgId } }`). No cross-org membership injection is possible.

**[passed]** `frontend/src/pages/GroupDetail.jsx:80` — The `memberships || members` fallback is safe; both branches are iterated with `(m.user || m)` at line 115, which correctly unwraps the Prisma relation shape. No XSS — all values rendered as React children via JSX text nodes.

---

### 15R-B — DataTable v2 component

**[high]** `/home/yavadmin/shellius/frontend/src/components/shared/DataTable.jsx:431-463` — Sortable column `<th>` elements use `onClick` on the `<th>` element itself but do not carry `role="button"`, `tabIndex="0"`, or `onKeyDown` handlers. This means keyboard-only users cannot sort columns: pressing Tab will skip over them (they are native `<th>` elements, not focusable by default), and Enter/Space have no effect. The accessibility spec requires sortable headers to be keyboard-operable.

**[low]** `/home/yavadmin/shellius/frontend/src/components/shared/DataTable.jsx:392-399` — The search `<Input>` has no explicit `aria-label`. Its implicit label comes only from the `placeholder` attribute, which is insufficient for screen readers when the placeholder disappears on focus. Should add `aria-label={searchPlaceholder}`.

**[passed]** Search debounce is exactly 200 ms (line 179: `useDebounced(searchRaw, 200)`). The search string is never rendered via `dangerouslySetInnerHTML`; it is only passed to `.toLowerCase().includes()` for filtering. No XSS risk.

**[passed]** Action menu keys: separators use `key={\`sep-${idx}\`}` (line 53) and items use `key={action.label}` (line 59). Labels are developer-supplied string constants from the calling page's `actions` array, not user data, so collisions are not a practical risk.

**[passed]** No prop spread on `<table>` — the component never does `<table {...props}>`. Only explicitly listed Tailwind class names are applied. No event handler leakage.

**[passed]** Pagination buttons carry explicit `aria-label` props: "First page", "Previous page", "Next page", "Last page" (lines 583, 591, 611, 621).

**[passed]** Page-size `<Select>` uses shadcn/ui's Select primitive which provides accessible ARIA roles internally.

---

### 15R-C — DataTable v2 migration sweep

**[passed]** `frontend/src/pages/Servers.jsx` — Action icons all belong to the canonical set (Eye, Pencil, Download, Activity, Trash2). The Delete action is correctly marked `variant: 'destructive'`. Server-pagination is driven via `serverPagination={{ page, total, onPageChange: setPage }}`; `fetch()` is only triggered by the `useEffect` on the `fetch` callback, which itself depends on `[page, pageSize, environment, healthStatus, customerFilter]`. No double-fetch path.

**[passed]** `frontend/src/pages/Users.jsx` — Action icons: Pencil, KeyRound, Mail, RotateCcw, UserX, Trash2 — all canonical. Delete is `variant: 'destructive'`. Users page uses `serverPagination`; `fetchUsers` callback depends only on `[page, pageSize, role, status]`. No orphaned hooks.

**[passed]** `frontend/src/pages/AccessRequests.jsx` — Action icons: Eye, Ban. Ban (Revoke) is correctly `variant: 'destructive'` on the admin-only action. Uses `serverPagination`. No orphaned state hooks; all `useState` calls have a corresponding UI consumer.

**[info]** `frontend/src/pages/AccessRequests.jsx:395-413` — The "Revoke" action in the table opens the detail modal (`openDetail(r.id)`) rather than triggering an inline revoke flow. This is intentional UX (revoke requires a reason field in the modal) but is slightly misleading: the action is labelled "Revoke" yet navigates to the detail view. Not a security issue.

---

### 15R-D — Quick Connect

**[high]** `/home/yavadmin/shellius/backend/src/routes/accessRequests.js:138-147` — `GET /by-server/:serverId/active` passes `req.user.userId` and `req.params.serverId` to `getActiveByServerForUser` but does **not** pass `req.orgId`. The service function (`accessRequestService.js:753-765`) queries `prisma.accessRequest.findFirst` with only `{ requesterId: userId, serverId, status: 'APPROVED', expiresAt: { gt: now } }` — there is **no `orgId` filter**. Because `requesterId` is locked to the calling user, a user cannot see another user's requests, so this is not a cross-user IDOR. However, if the DB ever contained approved access requests from a different org (e.g., via a data migration or a multi-org user), those records would be visible. More importantly, the `serverId` is an opaque UUID — guessing a valid UUID from another org lets an attacker confirm that an approved access request exists for that server in *any* org, which is an information-disclosure issue. Adding `orgId` to the query closes this entirely.

**[passed]** No IDOR between users: `requesterId: userId` in the WHERE clause means user A can never see user B's requests — only their own per-server active request is returned.

**[passed]** `window.open(\`/terminal?requestId=${activeRequest.id}\`, '_blank')` at `QuickConnectModal.jsx:57` — the requestId is a UUID from the API response, not user-typed input. The terminal page authenticates via its own JWT refresh-on-mount flow. No JWT is injected into the URL.

**[passed]** Principal validation in `QuickConnectModal.jsx` uses `LINUX_USER_RE` from `frontend/src/utils/principal.js` (the same `/^[a-z_][a-z0-9_-]{0,31}$/` pattern) for both the inline error display (line 45) and the submit guard (line 51). The backend `submitSchema` at `accessRequests.js:42-49` applies the same regex server-side. A stale or manipulated principal cannot bypass validation.

**[passed]** `QuickConnectButton.jsx` on-mount fetch uses a `cancelled` flag to handle unmount race (lines 23-30), and errors are caught at line 26 with a graceful fallback to `null` (shows "Request Access" state). No unhandled promise rejection.

**[passed]** Audit log: `POST /access-requests` carries `audit('access_request.submit', 'AccessRequest')` middleware (route line 88-89). Quick Connect uses `createAccessRequest` which POSTs to that endpoint, so the audit log fires for auto-created requests.

---

### 15R-E — SSO catalogue

**[passed]** `ssoConfigSchema` in `/home/yavadmin/shellius/backend/src/routes/sso.js:43` — `presetId` is `Joi.string().valid('google','entra','okta','auth0','generic-oidc','saml').optional()`. These six values exactly match the `id` fields in `frontend/src/config/ssoProviders.js`. No arbitrary string can be stored.

**[passed]** `ssoConfigService.upsert` at `/home/yavadmin/shellius/backend/src/services/ssoConfigService.js:134` — `presetId` is only written when `presetId !== undefined` (line 147). The GET route (`ssoConfigService.get`) calls `maskRow()` which strips `clientSecretEncrypted` and replaces it with a boolean `hasSecret` flag (lines 93-97). The raw encrypted secret is never returned to the frontend.

**[medium]** `/home/yavadmin/shellius/frontend/src/config/ssoProviders.js:41` — `deriveIssuerUrl` for Entra: `` `https://login.microsoftonline.com/${tenantId}/v2.0` ``. The `tenantId` field accepts any string the user types into the form. A value containing `/../`, `?`, `#`, or `@` characters could produce a malformed or redirected URL. However, the backend applies `Joi.string().uri().required()` validation to `issuerUrl` before storing it (sso.js:47), and `guardSsrf` resolves the hostname before any outbound request is made — so the server-side blast radius is limited to Joi rejection. The client-side preview URL could display a confusing computed issuer to the admin. Same concern applies to `oktaDomain` and `auth0Domain`. Consider adding a client-side regex guard on these fields (e.g., `^[a-zA-Z0-9._-]+$`) before interpolation. Not flagging as high because the backend Joi + SSRF guard stops any exploit.

**[passed]** All `setupSteps` text in `ssoProviders.js` is static string literals authored at build time. No user-supplied content is interpolated into them. In `Settings.jsx`, step text is rendered as JSX `{step.title}` and `{step.body}` React children — React escapes by default, no `dangerouslySetInnerHTML` anywhere in the SSO wizard.

**[passed]** Redirect URI in `Settings.jsx:426` — `const redirectUri = \`\${window.location.origin}/api/auth/sso/callback\`` — derived from the browser's own `window.location.origin`, not from any user input or stored string. Not echoed user data.

**[passed]** Secret field: `Settings.jsx:725` — `type={isSecret ? 'password' : 'text'}` is applied for `field === 'clientSecret'`. The "Stored — leave blank to keep" placeholder appears when `hasStoredSecret` is true (line 713-715). Correct.

**[passed]** `ssoConfigService.test` applies `guardSsrf(issuerUrl)` (line 196) before any outbound fetch. The `discover()` function in `routes/sso.js` also calls `guardSsrf` (line 107). Both code paths are protected against SSRF.

**[passed]** `stateStore` in `routes/sso.js` performs GC of states older than 10 minutes (lines 146-149), preventing unbounded memory growth from repeated SSO initiation.

---

## Summary for parent task

**15R-A:** 1 medium (missing audit log on group member add/remove).
**15R-B:** 1 high (sortable `<th>` not keyboard-focusable), 1 low (search input missing aria-label).
**15R-C:** All passed; 1 info (Revoke action opens modal rather than direct revoke).
**15R-D:** 1 high (`getActiveByServerForUser` missing `orgId` filter — cross-org server existence oracle).
**15R-E:** 1 medium (no client-side pattern guard on tenantId/oktaDomain/auth0Domain before URL interpolation).

Total: 5 findings — 0 critical, 2 high, 2 medium, 1 low, 1 info.
High findings: fix required before merge (15R-B keyboard sort, 15R-D orgId scoping).


## Fixes applied 2026-04-07 02:01 UTC

### 15R-D HIGH — orgId scoping on getActiveByServerForUser — FIXED
- `backend/src/services/accessRequestService.js:753` — `getActiveByServerForUser` now takes `(orgId, userId, serverId)` and filters on `orgId` in the WHERE clause.
- `backend/src/routes/accessRequests.js:138` — handler now passes `req.orgId` as the first arg.
- Verified: live curl with the dev admin token still returns the correct AR for the user's own org. Cross-org existence oracle closed.

### 15R-B HIGH — sortable headers not keyboard-operable — FIXED
- `frontend/src/components/shared/DataTable.jsx` — sortable column headers now wrap their content in a real `<button type="button">` with:
  - `onClick={handleSort}`
  - native keyboard support (Tab to focus, Enter/Space to activate)
  - `focus-visible:ring-2 ring-ring` for visible focus
  - `aria-label="Sort by <column label>"`
- The `<th>` itself now carries `scope="col"` and `aria-sort="ascending|descending|none"` so screen readers announce the current sort state.

### 15R-B LOW — search input missing aria-label — FIXED
- DataTable.jsx search Input now has `aria-label={searchPlaceholder}` and `type="search"`.

## Status: [x] Done — 5 findings (0 critical, 2 high, 2 medium, 1 low, 1 info), high+low fixed, mediums tracked as follow-up

Open mediums (not blocking):
- 15R-A medium: missing audit log on group member add/remove → file as Phase-16 follow-up
- 15R-E medium: client-side regex on tenantId/oktaDomain/auth0Domain before URL interpolation → file as Phase-16 follow-up
