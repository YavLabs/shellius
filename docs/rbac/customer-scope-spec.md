# Customer scope — specification

Status: **accepted, in build**. Decisions in §8 were made on 2026-09-20. Target: `backend/` + `frontend/` as of 2026-09-20.
Paths are relative to the repo root; line numbers refer to that snapshot.

Related: [access-policies.md](./access-policies.md), [rbac-audit.md](./rbac-audit.md),
[permission-matrix.csv](./permission-matrix.csv).

---

## 1. The problem

Authorization has three layers today, and only two of them are enforced per resource:

| Layer | Enforced on | Filters listings? |
|---|---|---|
| Org tenancy (`middleware/tenant.js`) | every query, via `orgId` | yes — this is the only row filter |
| RBAC permissions (role → permission keys) | API verbs and pages | no |
| `AccessPolicy` (`policyService.evaluate`) | connecting to a server | no |

Policies decide **connecting**. They never touch **visibility**. Server listings filter on
the org and nothing else:

```js
// backend/src/services/serverService.js:101
const where = { orgId };
if (customerId) where.customerId = customerId;   // a user-chosen filter, not a scope
```

`servers.view` and `customers.view` are **member defaults**
(`backend/src/config/permissions.js`), so every member of an org can enumerate every
customer's fleet — hostnames, IP addresses, environments, labels, prod included — even
when no policy would ever let them connect.

For a single-company deployment that is mostly harmless. For an MSP running many customers
out of one org, it is the difference between "Shellius is multi-tenant" and "Shellius is
multi-tenant for the operator, not for the operator's clients".

**Non-goal:** more `Organization` rows. An org is a hard tenant boundary with its own users,
CA, keystore and policies; using one per customer would force an account per customer for
every engineer. Customer scope is a filter *inside* one org.

---

## 2. Model

### 2.1 Schema additions

```prisma
enum AccessScope {
  ALL         // sees the whole org (today's behaviour, the default)
  CUSTOMERS   // sees only the customers resolved below
}

model User {
  // ...
  accessScope AccessScope @default(ALL) @map("access_scope")
  customerScopes UserCustomerScope[]
}

/// Customers a user may see, when accessScope = CUSTOMERS.
model UserCustomerScope {
  id         String   @id @default(cuid())
  userId     String   @map("user_id")
  customerId String   @map("customer_id")
  createdAt  DateTime @default(now()) @map("created_at")

  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@unique([userId, customerId])
  @@index([userId])
  @@map("user_customer_scopes")
}

/// Customers every member of a group may see. Additive with the rows above.
model GroupCustomerScope {
  id         String   @id @default(cuid())
  groupId    String   @map("group_id")
  customerId String   @map("customer_id")
  createdAt  DateTime @default(now()) @map("created_at")

  group    Group    @relation(fields: [groupId], references: [id], onDelete: Cascade)
  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@unique([groupId, customerId])
  @@index([groupId])
  @@map("group_customer_scopes")
}
```

`Server` already carries `customerId` and is indexed for this exact predicate —
`@@index([orgId, customerId])` (`backend/prisma/schema.prisma:68`), so the filter costs
nothing extra.

### 2.2 Effective scope

```
effective(user):
  if user.role == super_admin        -> ALL
  if user.accessScope == ALL          -> ALL
  else -> union( UserCustomerScope[user], GroupCustomerScope[groups of user] )
```

Rationale for letting **groups** contribute: groups already exist
(`backend/prisma/schema.prisma:338`), already act as policy subjects and approver targets,
and carry no attributes of their own today. Scoping "Acme Support" once gives its members
both the visibility and the policy subject from a single assignment, instead of two parallel
lists that drift apart.

### 2.3 Rules

1. **`super_admin` is never scoped.** They can edit their own scope, so enforcing it would
   be theatre. Every other role, `admin` included, can be scoped — an MSP wants
   customer-admins.
2. **Out-of-scope is 404, never 403.** Existence is not disclosed. This matches the rule the
   personal vault already follows (`backend/src/routes/keystore.js`, `ownerForItem`).
3. **An empty set means nothing is visible.** Allowed, but the assignment UI warns, because
   it is far more often a mistake than an intent.
4. **Scope never widens access, only narrows it.** It is intersected with policies, never
   substituted for them. A scoped user still needs an ALLOW policy to connect.
5. **Nobody may widen their own scope**, mirroring `roleService.canActOnRole`.
6. **Writes and connect paths are guarded too**, not just lists (§4.2). Creating a server
   under an out-of-scope customer, requesting access to an out-of-scope server, or opening a
   terminal ticket for one must fail exactly as if the server did not exist.

### 2.4 New permission

| Key | Default tier | Gates |
|---|---|---|
| `users.assign_scope` | admin | changing any user's `accessScope` and customer rows, and editing `GroupCustomerScope` |

Added to the catalogue with a higher `since`, so `syncSystemRoles()` back-fills it onto
existing roles by tier at boot (`backend/src/config/permissions.js`).

---

## 3. Enforcement

### 3.1 Where the scope is computed

Alongside permissions in `backend/src/middleware/auth.js:59-96`, which already re-loads the
user on every request (so a scope change takes effect immediately, no re-login):

```js
req.scope = { mode: 'all' | 'customers', customerIds: [...] };
```

### 3.2 One helper, used everywhere

A single module — `backend/src/lib/scope.js` — so the predicate exists in exactly one place:

```js
serverScopeWhere(scope)    // {} | { customerId: { in: ids } }
customerScopeWhere(scope)  // {} | { id: { in: ids } }
sessionScopeWhere(scope, userId)
  // {} | { OR: [ { server: { customerId: { in: ids } } },
  //              { serverId: null, userId } ] }      // own Quick Connect sessions
assertServerInScope(scope, server)     // throws 404
assertCustomerInScope(scope, customerId)
```

`Session.serverId` is nullable for Quick Connect (`backend/prisma/schema.prisma:684`), hence
the `OR` — otherwise a scoped user would lose sight of their own ad-hoc sessions.

### 3.3 Why not a Prisma middleware

`CLAUDE.md` says org scoping is enforced by Prisma middleware. It is not:
`backend/src/middleware/tenant.js` only sets `req.orgId`, and every service passes it
explicitly. A global interceptor would therefore be a much larger change than this feature,
and it would have to know which model a query targets and which request it belongs to. The
predicate is threaded explicitly instead, and §6 covers how we prove nothing was missed.

---

## 4. Query sites

Every site below either needs the predicate or needs an explicit decision that it does not.
`scoped: no` is a valid answer, but it has to be a written one (§6.1).

### 4.1 Reads that must be filtered

| # | Endpoint | Service (`file:line`) | Today's `where` | What leaks |
|---|---|---|---|---|
| 1 | `GET /api/servers` (`routes/servers.js:141`) | `serverService.listServers:101` | `{ orgId }` — `customerId` is a caller *filter*, not a scope | The whole inventory: hostname, IP, env, labels, cloud ids, plus `total` |
| 2 | `GET /api/servers/:id` (`:194`) | `serverService.getServer:142` | `{ id, orgId }` | 404 when out of scope |
| 3 | `GET /api/servers/health/summary` (`:152`) | `healthCheckService.getHealthSummary:115` | `groupBy { orgId }` | A fleet-size oracle even without row access |
| 4 | `GET /api/servers/:id/delete-impact` (`:249`) | `serverService.getDeleteImpact:255` | `{ id, orgId }` | |
| 5 | `GET /api/customers` (`routes/customers.js:36`) | `customerService.listCustomers:17` | `{ orgId }` | Every customer + `_count.servers`; feeds every dropdown |
| 6 | `GET /api/customers/:id` (`:45`), `/stats` (`:54`), `/delete-impact` (`:85`) | `customerService.getCustomer:46`, `getCustomerStats:175`, `getDeleteImpact:103` | `{ id, orgId }` | Stats break the fleet out by env and health; delete-impact returns a hostname list |
| 7 | `GET /api/sessions`, `/active`, `/:id` | `sessionService.list:173`, `listActive:208`, `getById:229` | `{ orgId }` | `SESSION_INCLUDE:9-33` embeds server hostname/IP/env. Needs the `serverId: null` OR-branch (§3.2) |
| 8 | `GET /api/sessions/:id/recording` (`routes/sessions.js:107`) | `getById:229` then object storage | `{ id, orgId }` | **The highest-value leak in the list** — a full terminal recording of any org session |
| 9 | `GET /api/certificates` (`routes/certificates.js:142`) | `certificateService.list:228`, `getById:263` | `{ orgId }` | No `customerId` column — filter through the `issuedFor` relation |
| 10 | access requests `tab=all` (`routes/accessRequests.js:145`) | `accessRequestService.list:1178` | `{ orgId }` | `REQUEST_INCLUDE:184-200` already carries `customerId` — convenient |
| 11 | `GET /api/access-requests/intent?serverId=` (`:190`) | `getAccessIntent:1521` | `server findFirst { id, orgId }` | Confirms a serverId exists and returns its `sshUser`/`environment` — an enumeration primitive that needs no `servers.view` |
| 12 | `GET /api/policies/my-access` (`routes/policies.js:145`) | `policyService.getAccessibleServers:429` | evaluates every active org server | **Auth-only, no permission gate.** Returns full server rows + customer objects. Scope makes it both safe and cheaper |
| 13 | `POST /api/policies/evaluate` (simulator, `:158`) | `policyService.evaluate:187` | `server findFirst { id, orgId }` | Server-existence + a full decision for any (userId, serverId) pair. See open question 1 |
| 14 | `GET /api/policies`, `/:id` (`:197`, `:226`) | `policyService.list:469`, `getById:504` | `{ orgId }` | Policy bodies expose `targetServerIds` and customer names |
| 15 | `GET /api/keystore/keys/:id` (`routes/keystore.js:147`) | `keystoreService.getKey:159` | `{ id, orgId, ownerId }` | Reaches servers through **three** relations (`:172`, `:182`, `:192`) — a key detail page is an inventory listing |
| 16 | `GET /api/keystore/credentials`, `/:id` (`:305`, `:315`) | `listCredentials:553`, `getCredential:578` | `{ orgId, ownerId }` | `serverCount`, and the detail returns bound servers **including IPs** |
| 17 | `GET /api/keystore/deployments`, `/batches` (`:457`, `:447`) | `keyDeploymentService.listDeployments:267`, `listBatches:307` | `{ orgId }` | Rows embed server hostnames |
| 18 | `GET /api/search` (`routes/search.js:28`) | `searchService.searchServers:84`, `countServers:268`, `searchCustomers:129` | **raw SQL** `$queryRaw` | Palette returns hostname, IP, env, customer name — and a per-type **total count** that defeats `limit`. One of only two raw-SQL sites (with `auditService`), so it needs a SQL fragment, not a Prisma `where` |
| 19 | `GET /api/import/:id` (`routes/import.js:57`) | `importService.getJob:664` | `{ id, orgId }` | Echoes every parsed row: hostnames, IPs, customer names |
| 20 | recents / history | `sessionService.listRecentServersForUser:307`, `quickConnectService.listHistory:669` | own rows, but the server hydrate is org-scoped | A server that *leaves* your scope would otherwise linger in your recents |

### 4.2 Writes and connect paths that must be guarded

Filtering lists alone leaves a boundary you can walk through by guessing an id.

| # | Path | Site | Guard |
|---|---|---|---|
| 21 | create / update server | `serverService.createServer:151` (customer check `:153`), `updateServer:194` | Target `customerId` in scope |
| 22 | **bulk server update** | `serverService.bulkUpdate:295`, `where { id: { in }, orgId }` `:311` | Can **reassign servers between customers** (`:308`), and its `{updated}` count is a membership oracle. Check both source and target |
| 23 | provision (SSE), health-check, host-key reset, connection IP, delete | `routes/servers.js:293`, `:280`, `:270`, `:206`, `:258` | `assertServerInScope` |
| 24 | terminal WS (SSH + RDP) | `terminalService.js:875`, `:954`; `rdpService.js:429` | Check at ticket mint **and** at redemption — a valid access request must not override scope |
| 25 | access request submit / break-glass | `accessRequestService.submit:225`, `createBreakGlass:1705` | Break-glass currently reaches any org server |
| 26 | direct certificate issue | `routes/certificates.js:92` → `certificateService.issue:57` | Mints access to any org server |
| 27 | key deployment create / retry / credential test | `routes/keystore.js:435`, `:467`, `:362` | Target server list |
| 28 | Quick Connect save-as-server | `quickConnectService.saveAsServer:455`, customer check `:464` | Chosen customer in scope |
| 29 | bulk import commit | `importService` (`:191`, `:235`, `:250`) | Reject per row with a reason, never silently skip |
| 30 | customer create / update / delete | `routes/customers.js`; delete reassigns servers (`customerService:146`) | A scoped user creating a customer they then cannot see is a trap — auto-add to their scope, or deny |
| 31 | policy create / update | `policyService` `customerId` field | Don't let a scoped user target a customer they cannot see |
| 32 | bootstrap token minting | `routes/bootstrap.js:115`, `routes/servers.js:332` | Scope at mint time; the install URLs themselves are token-bound |

Note also that Quick Connect's guard errors return `details.serverId` (`quickConnectService.js:167`, `:452`), which confirms a host is a saved prod/denied server. Worth suppressing for scoped users.

### 4.3 Deliberately **not** scoped

| Area | Why |
|---|---|
| `tab=to-review` and approver reads of `/api/access-requests/:id` (`accessRequestService.js:1206`, `:1252`) | Approvers are chosen by policy and may sit outside the server's customer. Filtering would silently strand approvals — see open question 3 |
| `GET|POST /api/approvals/:token` (`routes/approvals.js:545`, `:569`) | Deliberately unauthenticated; the token is the credential and there is no `req.user`. Note it bypasses `orgId` entirely today |
| Agent paths: `POST /api/certificates/verify`, `POST /api/hosts/heartbeat` | Machine identity, never a user |
| Bootstrap script downloads (`routes/bootstrap.js:178`, `:223`, `:325`) | Token-bound, executed on the target host |
| Background jobs (`healthCheckService.checkAllServers:79`, `accessRequestService.markExpired:1282`, `certificateService.markExpired:426`, all of `src/jobs/*`) | No user context; must stay global |
| `GET /api/metrics` | Static token, no tenant data |
| Already own-scoped: `/api/vault/*`, `/api/notifications/*`, `/api/certificates/my-certs`, `GET /api/terminal/sessions` | Nothing to add |
| `GET /api/audit` + `/export`, `GET /api/sessions/active`, the policy simulator | Compliance and incident-response surfaces. Silently truncating an auditor's export is worse than denying it outright — decide explicitly rather than filtering by default |

### 4.4 Frontend surfaces

Most of these correct themselves once the API filters, because they render whatever the API
returns. These are the ones that need real work:

| Surface | `file:line` | Work |
|---|---|---|
| `AuthContext` value | `frontend/src/context/AuthContext.jsx:161-179` | Expose `scope` next to `can`, fed from `/auth/me` |
| `/auth/me` payload | `backend/src/services/authService.js:96` | Add `scope` beside `features` |
| `permissions.js` helpers | `frontend/src/lib/permissions.js:17-27` | Add `inScope(user, customerId)` |
| `getServerStats()` | `frontend/src/services/serverService.js:105-121` | Client-side env aggregation over a 500-row page — replace with a real stats endpoint, or accept scoped numbers |
| Customer dropdowns | `Servers.jsx:241`, `ServerForm.jsx:526`, `SaveServerFields.jsx:61`, `PolicyForm.jsx:240`, `DeleteCustomerDialog.jsx:36` | Fixed by #5, but each should show an empty-state that explains scope rather than an empty list |
| Command palette recents | `frontend/src/lib/paletteRecent.js` | localStorage keeps out-of-scope entries after a scope change — clear on scope mismatch |
| User create/edit | `frontend/src/components/users/UserForm.jsx:78-98`, `pages/Users.jsx:505` | Where the scope picker goes |
| Groups admin | `pages/Groups.jsx:32`, `pages/GroupDetail.jsx:40` | Where `GroupCustomerScope` is edited |

**Naming collision:** `frontend/src/components/shared/ScopeBadge.jsx` already means
personal-vs-org vault scope. Customer scope needs a different component name.

---

## 5. Migration and upgrade behaviour

### 5.1 Migration

One migration, `add_customer_scope`:
- `CREATE TYPE "AccessScope" AS ENUM ('ALL','CUSTOMERS');`
- `ALTER TABLE users ADD COLUMN access_scope "AccessScope" NOT NULL DEFAULT 'ALL';`
- `CREATE TABLE user_customer_scopes`, `CREATE TABLE group_customer_scopes` with their
  unique and FK constraints.

No data backfill. Every existing user keeps `ALL`, so **an upgrade changes nothing that
anyone can observe** — the feature is inert until someone is scoped. This is deliberate: a
migration that silently narrowed visibility would look like data loss to an existing org.

### 5.2 Rollback

Dropping the two tables and the column restores the previous behaviour exactly; no other
table is touched and nothing outside these three objects is written.

### 5.3 Interaction with existing flows

| Flow | Behaviour |
|---|---|
| SSO auto-provisioning | New users get `ALL` unless `SsoConfig.defaultGroupId` puts them in a scoped group; a later phase can map IdP groups to scope |
| Invites | The invite modal offers scope next to role; default `ALL` |
| Bulk import | Importing a server under an out-of-scope customer is rejected per row with a clear reason, not silently skipped |
| Cloud connector sync | Runs as the org, not as a user — unaffected |
| Policy evaluation | Untouched. Scope is applied *before* policies, so `getAccessibleServers` gets a smaller candidate set and gets cheaper |
| Deleting a customer | `onDelete: Cascade` removes the scope rows with it |

---

## 6. Proving nothing leaks

The risk in this feature is not the model, it is a missed query. Three defences:

1. **An endpoint matrix test.** Extend `docs/rbac/endpoint-matrix.csv` with a
   `scoped: yes | no | n/a` column, and add a test that fails when a route appears in the
   Express router but not in the matrix — so a new endpoint cannot be added without making a
   decision about scope.
2. **A two-customer integration fixture.** One org, customers A and B, one user scoped to A.
   For every endpoint marked `scoped: yes`, assert: B's rows are absent from lists, B's ids
   return 404 on read, writes naming B fail, and counts/aggregates exclude B.
3. **A leak test for aggregates specifically** — `customer.serverCount`, dashboard tiles,
   environment breakdowns — because those are computed, not selected, and are the easiest
   place for a total to slip through.

---

## 7. Phasing

| Phase | Contents | Shippable alone? |
|---|---|---|
| 1 | Schema + migration + `req.scope` + `lib/scope.js` + servers/customers reads + tests | Yes — inert until someone is scoped |
| 2 | Writes and connect paths (§4.2), so scope is a boundary and not just a view | Yes |
| 3 | Sessions, certificates, access requests, key deployments, dashboard aggregates | Yes |
| 4 | Admin UI: scope on the user modals, scope on groups, the "Effective access" view | Yes |
| 5 | Audit-log scoping ("activity for my customers"), SSO group→scope mapping | Later |

Phases 1–3 are the security boundary; 4 is what makes it usable; 5 is follow-up.

---

## 8. Decisions

Settled 2026-09-20.

| # | Question | Decision |
|---|---|---|
| 1 | Assignment shape | **Groups + users.** Scope can be set on a group and on an individual user; effective scope is the union. Both tables exist as specified in §2.1 |
| 2 | Can a scoped user reach admin surfaces (audit, policy management, org-wide sessions)? | **No.** Scoped users are simply not granted `audit.view` / `policies.view` / `sessions.view_all`. Those stay unscoped admin surfaces, so no half-filtered compliance view can exist |
| 3 | Approvers outside a server's customer | **They still see the request.** Being named an approver by a policy is an explicit grant that outranks the scope; `tab=to-review` and an approver's read of `:id` are never filtered (§4.3) |
| 4 | Audit log scoping | Deferred. `audit.view` stays unscoped, per decision 2 — revisit only if a scoped role ever needs it |

---

## 9. Pre-existing issues noticed while writing this

None of these are caused by customer scope, and none are blockers — but they were found
while tracing the query sites, and scope work touches all of them.

| # | Finding | Site |
|---|---|---|
| 1 | `notificationService.list` filters on `{ userId }` with **no `orgId`** | `backend/src/services/notificationService.js:63` |
| 2 | `GET /api/policies/my-access` has **no permission gate** — any signed-in user gets full server rows for everything they could request, and it runs one `evaluate()` per server in the org | `backend/src/routes/policies.js:145`, `policyService.js:429` |
| 3 | `GET|POST /api/approvals/:token` looks the request up by id with **no `orgId`** in the `where` — safe only because the token is unguessable | `backend/src/routes/approvals.js:551` |
| 4 | `rdpService` resolves an access request with `findUnique` and no `orgId` | `backend/src/services/rdpService.js:429` |
| 5 | `GET /api/search` returns per-type **total counts**, so `limit` does not bound what a caller learns about fleet size | `backend/src/services/searchService.js:399` |
| 6 | `GET /api/audit/export` has no `take`/limit — a full table dump in one request | `backend/src/services/auditService.js:571` |
| 7 | `CLAUDE.md` states that Prisma middleware enforces org scoping. It does not; `middleware/tenant.js` only sets `req.orgId` | `backend/src/middleware/tenant.js:3` |
