# Phase 15: DataTable v2, Quick Connect, SSO Catalogue, Favicon, Group Membership Bug

Four user-reported items, scoped together because they all touch frontend
list/table flows + the access-request → terminal pipeline. Each sub-task
is paired with a `qa` smoke test and a `reviewer` security/UX pass — no
change ships without both gates.

All agents in `.claude/agents/` already use `sonnet`. No agent model
updates required.

## 1. Group member add — silent failure (bug)

**Symptom:** Add Member modal in `/groups/:id` returns HTTP 200 but the
member never appears in the list. DB state unverified.

**Suspected root cause class:** the same envelope-unwrap bug that hit
Servers / AccessRequests / Groups list earlier. `addGroupMember()` in
`groupService.js` returns `r.data.data` (the wrapper `{ membership }`)
and the page either ignores the return or refetches but the refetch
unwraps the wrong field, so the new member never lands in state.

Owner: **debugger** → reproduce → **backend** if route is broken,
otherwise **frontend** for the unwrap. Then **qa** for the regression
test, then **reviewer** for the patch.

## 2. DataTable v2 — feature parity with Vaulthive

Today's `components/shared/DataTable.jsx` is dumb: rows + columns + a
loading skeleton, no filters/sort/pagination/page-size/global search.
Every list page implements its own filter bar and pagination buttons,
which means inconsistent UX, no row-selection contract, no search
debounce, and no column-level controls.

**Build a single replacement** based on Vaulthive's
`frontend/src/components/ui/data-table.jsx`:

- Header with column labels + per-column sort indicators
- Built-in global search input (debounced) with magnifying-glass icon
- Slot for page-specific filter chips/selects above the search
- Footer with: "Showing X-Y of Z", page-size select (10/20/50/100),
  page-prev/next, page-number direct input
- Row click handler + per-row action menu (Radix DropdownMenu) with
  proper Lucide icons (Eye, Pencil, Trash2, Activity, Download,
  Terminal, KeyRound, etc.)
- Empty state with optional CTA
- Loading skeleton matched to column count
- Optional row selection (checkbox column) with bulk-action bar
- Sticky header on long lists
- Responsive: collapses extra columns to a "more" overflow on narrow
  viewports

**Migrate every list page** to use it. The list pages currently using
`DataTable`:

- Servers, ServerDetail (members) — Customers — Users — Groups —
  GroupDetail (members) — AccessRequests — Policies — Certificates —
  Sessions — AuditLog — Notifications — CloudConnectors (if implemented)

For each migration: keep the existing column definitions, drop the
ad-hoc filter bar / pagination JSX, wire the new component's slots.

Owner: **frontend** for the new component + each migration. **qa** runs
visual + functional smoke after each batch. **reviewer** spot-checks
accessibility + the action-menu icon set per page.

## 3. Quick Connect on Servers + SSO catalogue parity

Two pieces:

### 3a. Quick Connect button on Servers row

Right now you have to: Servers → row menu → Request Access → fill form
→ wait for approval → click row → Open Web Terminal. Five clicks.

New flow:
- Each row gets a primary **Connect** button (or **Request Access** if
  no APPROVED-and-non-expired request exists for the current user +
  this server).
- Clicking **Connect** opens a small modal: shows the principal that
  will be used (auto-detected from the user's email local-part or a
  configured default), the host, the protocol, and a **Connect** CTA.
  Optional inline override of the principal.
- Clicking **Connect** in the modal:
  - If an approved request exists: opens `/terminal?requestId=<id>`
    in a **new tab**.
  - If not: silently creates the access request, waits for auto-approval
    (non-prod), then opens the terminal in a new tab. For prod, falls
    back to the normal Request Access flow with a banner.
- All certificate issuance happens server-side (existing flow). The
  user only sees the modal + new tab.

**Backend addition:** new endpoint `GET /api/access-requests/by-server/:serverId/active`
that returns the current user's most recent APPROVED-and-non-expired
access request for that server, or null. The frontend uses this to
decide between Connect and Request Access.

Owner: **backend** (new endpoint), **frontend** (new component +
button), **qa** (full click-through), **reviewer**.

### 3b. SSO catalogue parity with Vaulthive

Current Settings → SSO supports a free-form OIDC issuer URL. Vaulthive
ships **provider presets** for Google Workspace, Microsoft Entra ID
(Azure AD), Okta, Auth0, and generic OIDC, each with:

- Pre-filled issuer URL / discovery URL
- Required-scope hint
- Step-by-step setup instructions (where to create the OAuth client,
  what redirect URI to copy, what attributes to map)
- Automatic SAML alternative for providers that support it

**Plan:**
- Backend: extend `ssoConfigService` to accept a `presetId` field;
  store the preset name on the row; the test endpoint already works
  for any OIDC provider via discovery so no transport changes.
- Frontend: rebuild Settings → SSO tab as a two-step wizard:
  1. Pick a provider (cards: Google / Entra ID / Okta / Auth0 / Generic
     OIDC / SAML 2.0)
  2. Fill the preset's required fields with copyable redirect URI and
     inline instructions
- Catalogue lives in `frontend/src/config/ssoProviders.js` so support
  can add a new provider without code changes elsewhere.
- All form inputs use the new `ui/select` and `ui/input` components for
  consistency with the rest of the UI.

Owner: **planner** (write `ssoProviders.js` shape + per-provider docs),
**backend** (route + service tweaks), **frontend** (wizard UI), **qa**
(test save + test-connection per provider), **reviewer** (SSRF guard
still applies to every provider, secret never round-trips).

## 4. Browser tab favicon

Symptom: blank tab in every browser. Vite's default `vite.svg` was
removed during a previous frontend cleanup but no replacement was added.

Fix: drop a `favicon.ico` (and a 32×32 PNG fallback) into
`frontend/public/`, reference it in `index.html` `<head>`, and add an
`<title>` that includes the org name.

Owner: **frontend** (10-min task). **qa** verifies in Chrome / Firefox /
Safari.

## Sub-tasks (and gates)

| ID  | Title                                          | Agent            | QA gate | Review gate |
|-----|------------------------------------------------|------------------|---------|-------------|
| 15A | Diagnose + fix group member add silent fail   | debugger → frontend | 15Q-A | 15R-A |
| 15B | DataTable v2 — build the component            | frontend         | 15Q-B   | 15R-B  |
| 15C | DataTable v2 — migrate every list page        | frontend         | 15Q-C   | 15R-C  |
| 15D | Quick Connect modal + Connect-or-Request flow | frontend         | 15Q-D   | 15R-D  |
| 15D2| `GET /access-requests/by-server/:id/active`   | backend          | 15Q-D   | 15R-D  |
| 15E | SSO provider catalogue + wizard               | frontend + backend + planner | 15Q-E | 15R-E |
| 15F | Favicon + page title                          | frontend         | 15Q-F   | —     |
| 15Q-* | Per-task qa smoke + Jest test                | qa               | —       | —     |
| 15R-* | Per-task reviewer pass                       | reviewer         | —       | —     |

## Workflow rule (applies to every task in this phase)

Before marking a sub-task `[x] Done`:
1. Implementation agent ships code + rebuilds + redeploys.
2. **qa agent** runs the matching `15Q-*` task: writes (or extends)
   Jest / supertest cases, runs the live smoke test against
   `https://shellius.yavlabs.com`, fixes any regressions inline.
3. **reviewer agent** runs the matching `15R-*` task: focused
   security/UX/accessibility review of the diff, fixes high/critical
   findings inline, files medium/low to a follow-up.
4. Only when both gates pass does the implementation task tick to Done.

## Acceptance for Phase 15

- Adding a member to a group reflects in the UI within one fetch and
  the DB row exists. Regression test in place.
- Every list page in the app uses `DataTable` v2 — same search bar,
  page-size dropdown, sort indicators, action menu icon set, empty
  state — no page implements its own pagination JSX.
- Servers list shows a **Connect** action that, in two clicks, opens a
  live web terminal in a new tab on the target host.
- Settings → SSO offers Google / Entra / Okta / Auth0 / Generic OIDC /
  SAML presets, each with copyable redirect URI and inline instructions.
- Every browser tab shows the Shellius favicon and a page-aware title.
- All Phase 15 sub-tasks `[x] Done`, all qa + reviewer gates green.
