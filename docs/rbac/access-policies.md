# Shellius Access Policies: How They Actually Work

Scope: `backend/` as of 2026-09-18 (before custom roles). Paths are relative to `backend/`; line numbers refer to that snapshot.

> **Role enum reality check.** The code's roles are `super_admin > admin > manager > member` (`prisma/schema.prisma:10-15`). CLAUDE.md still says `operator`/`viewer`, and that is out of date. The "Groups" (`Admin`, `Managers`, `Approvers`, `Developers`) are separate from roles. Nothing syncs a user's role with group membership.

---

## 1. Default seeded groups and policies

### 1.1 Where they come from and when

| Mechanism | File | When it runs | What it does |
|---|---|---|---|
| `seedRolesAndPolicies(prisma, orgId)` | `src/services/defaultSeedService.js:124-190` | Called by both paths below | Upserts 4 groups by `(orgId,name)` (`:128-132`). For each baseline policy it looks the policy up by `(orgId,name)`. If the name exists, the policy is skipped and **never updated** (`:141-145`). If it is missing, the policy and its `PolicySubject` rows are **created** (`:149-184`). |
| `prisma db seed` | `prisma/seed.js` | Only when run manually | Upserts the Organization by `SEED_ORG_SLUG` (`:76-87`). Creates or updates the super admin, forcing `role: 'super_admin'` (`:98-130`). Calls `seedRolesAndPolicies` (`:133`). Adds the super admin to the **`Admin` group** (`:142-149`). Makes sure a CA key pair exists (`:154-164`). |
| Boot job `seedDefaultPolicies()` | `src/jobs/seedDefaultPolicies.js:17-33`, called from `src/jobs/index.js:68-72`, started by `src/app.js:117` | **On every backend start**, for **every** org in the DB | Runs the same `seedRolesAndPolicies`. It is fire-and-forget: errors are logged and never block boot. |

"Org creation" means the seed script. `prisma/seed.js:76` is the only place that creates an `Organization`. There is no signup or create-org API (grep for `organization.create`/`upsert` finds nothing else). An org created some other way (for example by SQL) gets its defaults on the next backend restart.

**Behaviour on restart** (`defaultSeedService.js:128-145`):
- **Groups:** re-created if deleted. A group's `description` is **overwritten** on every boot (`update: { description }`, `:130`). A renamed group (for example `Admin` renamed to `Administrators`) brings back a new, empty `Admin` group.
- **Policies:** if an operator **deleted or renamed** a default policy, it is **re-created with defaults on the next restart**, subjects included. Edits to a policy that keeps its default name are preserved. The comment at `jobs/index.js:68` ("seed default policies for any org with zero rows") is wrong: the check is per policy name, not per org.
- **Subjects:** only written when the policy itself is created. The seed never re-adds subjects that were removed from an existing policy.

### 1.2 Baseline groups (`defaultSeedService.js:20-25`)

`Admin`, `Managers`, `Approvers`, `Developers`. They are all **empty**, except that `prisma/seed.js` puts the seed super admin into `Admin`. Nothing else ever adds members automatically. The only way is `groupService.addMember` (`src/services/groupService.js:110-124`), which needs admin+ (`src/routes/groups.js:94`).

### 1.3 Baseline policies (`defaultSeedService.js:45-114`)

All four share these settings: `effect: ALLOW`, `customerId: null` (org-wide), `targetServerIds: []` (all servers), `targetLabels: {}` (default), `allowedPrincipals = ['ubuntu','ec2-user','azureuser','root','admin']` (`:29`), `allowKeyDownload: true`, `isActive: true`.

| # | Name | Envs | Subjects: ROLE | Subjects: GROUP | Max duration | requireApproval | autoApprove | isBreakGlass | Approver routing | Priority (lower wins) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Dev & Staging Access** (`:46-61`) | dev, staging, demo | admin, manager, member | Developers, Managers, Admin | 8h (28800) | false | true | false | none | 100 |
| 2 | **Production Access — Admins & Managers** (`:62-79`) | prod | admin, manager | Admin, Managers | 2h (7200) | false | true | false | **none** | 40 |
| 3 | **Production Access — Approval Required** (`:80-97`) | prod | member | Developers | 2h (7200) | true | false | false | `approverGroup: Approvers` + `approverRoles: [admin, manager, super_admin]` | 50 |
| 4 | **Break-glass Production** (`:98-113`) | prod | admin | Admin | 1h (3600) | false | true | **true** | **none** | **10** |

Notes:
- No seeded policy has a `super_admin` ROLE subject. super_admin relies on the hard-coded bypass in `evaluate()`, or on being in the `Admin` group.
- In `evaluate()`, `autoApprove` and `isBreakGlass` are **never read** when deciding outcomes (see §5). So on prod, what separates these policies is only their priority, TTL and approver routing.
- Break-glass has priority 10, so it outranks policy #2 (priority 40) for anyone with ROLE `admin` or in GROUP `Admin`. **The policy that actually governs admin prod requests is "Break-glass Production" (1h, no approver routing), not "Admins & Managers" (2h).**

---

## 2. How policy evaluation works (`src/services/policyService.js:182-384`)

Input: `{ orgId, userId, serverId, requestedPrincipal?, policyId?, draftPolicy? }`.

1. **Load the server**, scoped to the org (`:188-189`). `isProd = server.environment === 'prod'` (`:191`).
2. **super_admin short-circuit** (`:198-225`). This runs **before** any policy is loaded:
   - Non-prod: returns `allowed: true`, `requiresApproval: false`, `maxTtl` of 24h, and `principals = [requestedPrincipal]`. It **ignores all policies, DENY policies included**, and every principal/customer/label filter.
   - Prod: reads `getProdApprovalBypassRole(orgId)` (`src/services/orgService.js:22-26`, default `'admin'`). If the value is not `'none'`, it returns the same result plus `prodBypass: true`. If it is `'none'`, evaluation falls through to Mode C like any other user.
3. **Mode A, draft policy** (`:230-254`), and **Mode B, a specific saved policy by id** (`:259-290`). These are only used by the admin tool `POST /api/policies/evaluate` (`src/routes/policies.js:161-194`). They **do not apply the prod or bypass-role rule**: they return the policy's own `requireApproval`, so a prod test can report "allow" when the real outcome is "requires approval".
4. **Mode C, org-wide evaluation** (the real path):
   1. Resolve the user's group IDs (`:40-46`) and role (`:297-301`).
   2. **Subject match** (`loadMatchingPolicies`, `:57-84`): active policies in the org with at least one subject where `USER = userId`, `GROUP ∈ userGroupIds`, or `ROLE = user.role`. These are ORed, so a user matches a policy through **any** of the three.
   3. **Target filters** (`filterPolicies`, `:120-147`), in this order:
      1. `customerId`: null means org-wide; otherwise it must equal `server.customerId`.
      2. `targetEnvironments`: empty means all; otherwise it must include `server.environment`.
      3. `targetLabels`: `{k:v}` requires `"k:v"` in `server.labels` (`:99-108`).
      4. `targetServerIds`: empty means all.
      5. `allowedPrincipals`: only applied when a principal was requested, the list is non-empty, **and `server.authMode !== 'credential'`** (`:141`).
   4. **No match** → `allowed: false`, reason "No matching policy" (`:309-318`). `submit()` turns this into **403**.
   5. **DENY-before-ALLOW** (`:321-339`): any matching DENY wins, **whatever its priority**.
   6. **Pick the best ALLOW** (`:342-346`): sort by `priority` ascending and take the first. Ties fall back to the DB order (`orderBy [effect asc, priority asc]`, `:80`), which is effectively arbitrary. There is **no merging**: principals, TTL and approver routing all come from that one winning policy.
   7. **Approval decision** (`:353-360`):
      - Prod: `requiresApproval = !roleBypassesProd(userRole, bypassRole)` (`:22-27`), using rank `super_admin 4 > admin 3 > manager 2 > member 1`. The policy's `requireApproval` **and** `autoApprove` are both ignored on prod.
      - Non-prod: `requiresApproval = bestPolicy.requireApproval`.
   8. Returns `{ allowed: true, requiresApproval, autoApprove: bestPolicy.autoApprove, principals, maxTtl: bestPolicy.maxSessionDuration, policyId, prodBypass: isProd && !requiresApproval }` (`:373-383`).

**Approver routing** comes from a separate query, `findApproverPolicy()` (`:401-415`). It re-runs subject and target matching and returns the best ALLOW **without looking at DENY**. It is always the same "best ALLOW" as in step 6.

### How `submit()` uses the result (`src/services/accessRequestService.js:212-517`)

1. The server must be "onboarded" (`:29-40`, `:236-238`). Credential-mode and RDP servers always count as onboarded.
2. **Principal resolution** (`:261-302`):
   - RDP: the credential username, or `rdpUsername`, or `'Administrator'`. The principal filter is skipped (`:312`).
   - Credential mode: always `server.credential.username` (`:271-278`).
   - Certificate mode: the default is the JIT principal (if a JIT policy matches) or `server.sshUser || 'root'`. **Non-admins** may only choose one of those two. **admin/super_admin** may request any string (`:289`).
3. `evaluate()` (`:308-313`).
4. **If `requiresApproval`** (`:320-396`): resolve approvers (§4). If there are none, **400 "No approver is configured"** (`:337-342`). Otherwise create a `PENDING` request with `AccessRequestApprover` rows, send in-app notifications and one-click email links, and write audit `access_request.submitted`.
5. **Else if `!allowed`**: 403 (`:398-400`).
6. **Else auto-approve**: `APPROVED` immediately. Duration is `min(requestedDuration, policy.maxTtl)` (`:403-406`). If `prodBypass`, the audit is `access_request.prod_bypass` and the server's resolved approvers are notified after the fact (`:446-497`). Otherwise the audit is `access_request.auto_approved`.

**What `autoApprove` does per role:** nothing, for any role. `submit()` only branches on `requiresApproval` and `allowed`. A non-prod policy with `requireApproval=false, autoApprove=false` is still approved instantly. A prod policy with `autoApprove=true` still needs approval below the bypass role.

**Expiry:**
- A PENDING request expires after 24h (`accessRequestService.js:1282-1330`).
- An APPROVED request becomes EXPIRED at `expiresAt` and its linked cert is revoked (`:1210-1269`).
- Live web-terminal sessions are cut at the request's `expiresAt` (`src/services/terminalHub.js:558-585`).
- On the host, `check-principals` → `/api/certificates/verify` rejects a cert once its request is no longer APPROVED. This only happens in per-host-token mode (`src/services/certificateService.js:366-375`).

---

## 3. Scenario table (defaults: seeded policies unchanged, `prodApprovalBypassMinRole='admin'`, Quick Connect settings unset)

Assumptions:
- `server.sshUser` is one of `ubuntu/ec2-user/azureuser/root/admin`. Otherwise see row X.
- The server is onboarded and has no custom DENY policy.
- "Req. mgr" means the requester's `User.managerId`.
- "TTL" means the approved duration.

### 3.1 Saved servers via the access-request flow (web terminal / TUI / key download)

| Role | Env | Auth mode | Winning policy | Outcome | Who can approve | Max duration |
|---|---|---|---|---|---|---|
| member | demo / dev / staging | certificate | Dev & Staging (ROLE member) | **Auto-APPROVED** | n/a | min(req, **8h**) |
| member | demo / dev / staging | credential | Dev & Staging (principal filter skipped) | **Auto-APPROVED**. Connects as the stored identity's username. Key download refused (`routes/accessRequests.js:354-359`) | n/a | min(req, 8h) |
| member | prod | certificate / credential | Prod — Approval Required (50) | **PENDING** | Members of the `Approvers` group **plus every active admin, manager and super_admin in the org**, minus the requester | **Not clamped.** Requested value up to 7d (`routes/accessRequests.js:41`), or whatever the approver sets up to 7d. The policy's 2h is **ignored** on this path (§5) |
| member in `Managers` group | prod | any | Admins & Managers (40) beats #3 (50) | **PENDING** | Policy #2 has no routing, so **Req. mgr only**. With no manager: **400, cannot request** | unclamped |
| member in `Admin` group | prod | any | Break-glass (10) | **PENDING** (role member < admin) | Req. mgr only. With no manager: 400 | unclamped |
| member in `Developers` only / in no group | any | any | Same as plain member. The ROLE subject already matches, so group membership changes nothing for the defaults | as above | as above | as above |
| manager | demo / dev / staging | any | Dev & Staging | **Auto-APPROVED** | n/a | min(req, 8h) |
| manager | prod | any | Admins & Managers (40) | **PENDING** (manager < admin; `'manager'` cannot be picked as a bypass role) | **Req. mgr only**. No manager: **400**. Being in `Developers` doesn't help, because priority 40 wins | unclamped |
| admin | demo / dev / staging | any | Dev & Staging | **Auto-APPROVED** | n/a | min(req, 8h) |
| admin | prod | any | **Break-glass Production (10)** | **Auto-APPROVED as prod bypass**. Audit `access_request.prod_bypass`. The "approvers notified" step resolves Break-glass routing (none), then Req. mgr, so **usually nobody is notified** | n/a | min(req, **1h**), not the 2h that policy #2 advertises |
| admin, bypass=`super_admin` or `none` | prod | any | Break-glass (10) | **PENDING** | Req. mgr only. None: **400**. The admin can still use `POST /api/access-requests/break-glass` (self-approved, 1h), which ignores the bypass setting | unclamped |
| super_admin | demo / dev / staging | any | **none evaluated** (hard bypass) | **Auto-APPROVED**. DENY policies, customer, label and principal filters are all ignored | n/a | min(req, **24h**) |
| super_admin, bypass=`admin` / `super_admin` | prod | any | none (hard bypass) | **Auto-APPROVED**, prod_bypass audit. Notification: Break-glass (if in `Admin`), then Req. mgr, so usually nobody | n/a | min(req, 24h) |
| super_admin, bypass=`none` | prod | any | Seed super admin is in `Admin`, so Break-glass (10) | **PENDING**, routed to Req. mgr only. super_admins normally have no manager, so **400** | n/a | n/a |
| super_admin not in `Admin` group, bypass=`none` | prod | any | No seeded policy has a `super_admin` ROLE subject | **403 "No matching policy"** | n/a | n/a |
| any non-super_admin | any | certificate | **X.** `server.sshUser` not in the 5 default principals (for example `deploy`, `centos`, `debian`) and no JIT policy | **403 "No matching policy"** (`policyService.js:141-143`) | n/a | n/a |
| any role | any | any | **No matching policy** (policies deleted or deactivated, ROLE subjects removed and user not in a group, or `customerId`/labels exclude the server) | **403** at submit (`accessRequestService.js:398-400`). super_admin non-prod and bypassed prod still pass | n/a | n/a |
| any role | any | any | A matching **DENY** policy | **403** whatever its priority. Exceptions: super_admin non-prod, super_admin bypassed prod, the break-glass endpoint, and Quick Connect | n/a | n/a |

Connect-time checks (`src/services/terminalService.js:882-1001`): the requester must be the caller, the request must be APPROVED, and it must not be expired.
- Credential mode connects with the server's Keystore identity (`:924-951`).
- Certificate mode mints an ephemeral key and a CA cert for `[requestedPrincipal, sshUser]` with TTL equal to the request's remaining time (`accessRequestService.js:666-838`). **admin/super_admin may override the principal to any valid Linux username at connect time**, and no policy check runs (`:703-726`, `terminalService.js:956-961`).

### 3.2 Quick Connect (`src/services/quickConnectService.js`)

No policy or access request is involved. The gate is `Organization.settings.quickConnect = { enabled (default true), minRole (default 'manager') }` (`:52-59`).

| Role | Target | Outcome |
|---|---|---|
| member | anything | **403 `QUICK_CONNECT_FORBIDDEN`** (rank 1 < manager) (`:187-189`) |
| manager / admin / super_admin | Host matching a saved **prod** server by string or resolved IP | **403 `PROD_HOST_REQUIRES_APPROVAL`**, for every role including super_admin (`:103-161`, `:221`) |
| manager / admin / super_admin | Any other host, including saved demo/dev/staging servers | **Connect immediately.** No policy or DENY check, no approval, no TTL (the session has no request deadline). Auth can be an ad-hoc password or key, or **any Keystore credential in the org** (`:198-201`) |
| any | Quick Connect disabled | 403 `QUICK_CONNECT_DISABLED` |

`minRole` can be changed by admin+ (`src/routes/quickConnect.js:96`). "Save as server" needs manager+, and creating a new identity there needs admin (`src/routes/quickConnect.js:167`; `quickConnectService.js:366`).

### 3.3 Other paths that grant access

- **Break-glass endpoint** (`POST /api/access-requests/break-glass`, `src/routes/accessRequests.js:242-257`; `accessRequestService.js:1628-1726`): admin/super_admin only. Any server and any environment. The request is self-approved (`reviewerId = invoker`). TTL is 5 to 60 minutes. Audit `access_request.break_glass` with severity HIGH, and **all admins and super_admins are notified**. It ignores policies, DENY and `prodApprovalBypassMinRole`.
- **Direct cert issue** (`POST /api/certificates/issue`, `src/routes/certificates.js:89-119`; `certificateService.js:49-192`): any authenticated user. See §5, items G1 and G2.

---

## 4. Approver resolution and review

**Resolution** (`accessRequestService.js:140-166`), from the best ALLOW policy (`findApproverPolicy`):
- The approver set is the union of:
  - `approverUserIds`
  - every active, non-deleted org user whose `role ∈ approverRoles`
  - members of `approverGroupId`
- The requester is always excluded (`:143`).
- If that set is empty, the requester's direct manager (`User.managerId`) is used. If there is no manager either, **submit fails with 400** (`:337-342`).
- The set is snapshotted into `AccessRequestApprover` rows. `reviewerId` is set to the first approver, kept for legacy reasons (`:346-360`).

**Who can act** (`review()`, `:534-643`): only the snapshotted `reviewerId` or any `AccessRequestApprover` (`:552-557`). There is **no admin override**: an admin who is not in the set cannot approve. The email one-click path (`src/routes/approvals.js:72-107`) calls the same `review()` using the approver bound to the token.

| Question | Answer |
|---|---|
| Can a requester approve their own request? | **No.** They are excluded at resolution (`:143`), so they are never in the set. The exception is break-glass, which is self-approved by design (`:1661`). |
| Can a manager approve prod? | **Yes, for members.** Policy #3 lists `approverRoles: [admin, manager, super_admin]`, so **every** manager in the org is an approver on every member's prod request. Managers can also approve anyone whose `managerId` points at them, through the fallback. A manager **cannot** approve their own prod request, and their own requests go only to *their* manager. |
| Can an approver approve for a server outside their "scope"? | **Yes.** Approver scope is not tied to customer or server. `approverRoles` matches the role **org-wide** (`:149`), and the manager fallback ignores the server. The only scoping is whatever the admin encodes into the policy (`customerId`, `targetServerIds`, labels). Even then, `approverRoles` still means "anyone in the org with that role". |
| Is the approver re-validated at decision time? | **No.** `review()` does not re-check the approver's current role, status, group membership, or whether the policy still applies. A demoted, suspended or deleted approver can still approve through an unexpired (24h) email link, because `getResourceToken` doesn't check `user.status` (`src/services/inviteService.js:119-143`). |
| Can the approver change the duration? | In-app, yes: `approvedDuration` from 60s to 7d (`src/routes/accessRequests.js:94-98`). By email, no: it defaults to `requestedDuration`. **In both cases the policy's `maxSessionDuration` is never applied** (`accessRequestService.js:566-570`). |
| Who can revoke? | admin+ **or** the primary `reviewerId` (`:1007`). Other approvers in the set cannot revoke. |
| Who can view the request (`GET /:id`)? | admin+, the requester, or the primary `reviewerId` (`:1187-1190`). **Non-primary approvers get 403 on the detail view** even though they can approve it and see it in the `to-review` tab (`:1131-1138`). |

---

## 5. Gaps, risks and surprising behaviour

Severity is a rough triage: **H** = access-control bypass or escalation, **M** = policy not enforced as configured, **L** = UX or correctness.

| # | Sev | Finding | Location |
|---|---|---|---|
| G1 | **H** | **`POST /api/certificates/issue` with no `serverId` skips policy evaluation completely.** Any authenticated user (member included) can get a cert signed by the org CA for **arbitrary principals** (for example `root`), valid up to **7 days**, with **user-controlled `extensions`/`criticalOptions`**, and even `certType: 'HOST'`. The only protection is on hosts: `verify()` rejects a cert with no host binding in per-host-token mode. Hosts on the legacy `AGENT_SHARED_SECRET`, or hosts that trust the CA without `check-principals`, accept it. | `src/routes/certificates.js:35-46, 89-119`; `src/services/certificateService.js:80-87, 336-348` |
| G2 | **H** | Even with a `serverId`, `/certificates/issue` only checks **`principals[0]`** against the policy. Every other principal in the array is signed without any check. An allowed direct issue also creates **no AccessRequest**, so for admin/super_admin prod issuance there is no `prod_bypass` audit and no approver notification, only `certificate.issued`. | `certificateService.js:88-93, 131-140` |
| G3 | **H** | **`PUT /api/org` (admin) can write `settings` wholesale**, including `settings.access.prodApprovalBypassMinRole` and `settings.quickConnect`. That sidesteps the super_admin-only `PUT /api/org/access-settings`. The change is audited as `org.update`, not `org.access_settings.update`. | `src/routes/org.js:22-27, 41-49` vs `:67-77`; `src/services/orgService.js:5, updateOrg` |
| G4 | **H** | **The approved duration is never clamped to the policy's `maxSessionDuration` on the approval path.** A member can request 7 days on prod, and one click on the email link grants 7 days (the "2h" prod policy is not enforced). The cert TTL then equals the request's remaining time. | `accessRequestService.js:566-570`; `routes/accessRequests.js:41, 94-98`; `routes/approvals.js:86-91` |
| G5 | **H** | **The break-glass endpoint ignores `prodApprovalBypassMinRole`.** With the org set to `'none'` or `'super_admin'`, any admin can still self-approve 1h prod access. It also ignores DENY policies and onboarding state. It is loudly audited and notified, but it defeats the "no one bypasses" setting. | `accessRequestService.js:1628-1674`; `routes/accessRequests.js:242-257` |
| G6 | **H** | **Quick Connect skips policies entirely** for non-prod targets, saved non-prod servers included. DENY policies, `requireApproval` on staging, customer/label scoping and TTL are all ignored. Any Keystore credential in the org can be used against any host. The prod guard only covers hosts that match a *saved* prod server. | `quickConnectService.js:182-247, 198-201, 103-161`; `terminalService.js:821-880` |
| G7 | M | **`autoApprove` is dead**: `submit()` never reads it. **`isBreakGlass` on a policy is also dead**: it is never read by evaluation and causes no extra audit. So "Break-glass Production" (priority 10) silently becomes the routine prod policy for every admin, and TTL drops to 1h. Its description ("Audited as a high-severity event") is false. | `accessRequestService.js:320-400`; `policyService.js:342-383`; `defaultSeedService.js:98-113` |
| G8 | M | **Prod-bypass "approvers are notified" usually notifies nobody.** For admins (and super_admins in `Admin`) the best ALLOW is Break-glass, which has no routing, so it falls back to the requester's manager, who is often unset. The loop runs over an empty array with no warning. This contradicts CLAUDE.md principle #2. | `accessRequestService.js:466-497`; `policyService.js:401-415` |
| G9 | M | **Managers cannot request prod at all unless they have a `managerId`.** Policy #2 (priority 40) has no approver routing and outranks #3, so the result is 400 "No approver is configured". The same happens to members in the `Managers` or `Admin` groups, and to admins when bypass is `super_admin`/`none`. | `defaultSeedService.js:62-79`; `accessRequestService.js:163, 337-342` |
| G10 | M | **Seeded text says an org can lower the bypass role to include managers. It can't.** Only `admin`, `super_admin` and `none` are valid. | `defaultSeedService.js:22, 40-43, 65-66`; `orgService.js:11`; `routes/org.js:54` |
| G11 | M | **Deleted or renamed default policies and groups come back on every restart**, and group descriptions are reset. An operator who deletes "Dev & Staging Access" to force approvals on dev will find it silently restored. | `defaultSeedService.js:128-145`; `jobs/index.js:68-72` |
| G12 | M | **super_admin on non-prod ignores DENY policies** and every target and principal filter (24h TTL). Setting `prodApprovalBypassMinRole='none'` leaves super_admin with no working prod path, apart from break-glass: they get 403 or 400 (see §3.1). | `policyService.js:198-225` |
| G13 | M | **The key-download gate checks for *any* ALLOW policy in the org with `allowKeyDownload`, not the matched policy.** All seeded policies set it to true, so downloads are effectively always allowed. | `routes/accessRequests.js:361-371` |
| G14 | M | **Admins can override the principal at connect time to any Linux user** without the policy's `allowedPrincipals` being checked. The cert is signed for `[override, sshUser]`. Also, the cert *always* includes `server.sshUser`, even when the policy's principal list excludes it. | `accessRequestService.js:703-734`; `terminalService.js:956-961` |
| G15 | M | **Default principals exclude common cloud users** (`debian`, `centos`, `fedora`, `opc`, `core`, custom ones like `deploy`). Non-super_admins get 403 "No matching policy" on those servers, even though the server's `sshUser` is the only principal they are allowed to request. | `defaultSeedService.js:29`; `policyService.js:141-143`; `accessRequestService.js:286-301` |
| G16 | M | **Approvals are not re-validated at decision time**: role, status, group and policy can all have changed since submit. Email tokens bypass the user status check. | `accessRequestService.js:541-557`; `inviteService.js:119-143` |
| G17 | M | **`revoke()` loads the request by id with no `orgId` filter** and authorizes with `isAdminOrAbove`. An admin in org A could revoke org B's request if they knew its id (a multi-tenant violation). `review()` also looks up by id without an org filter; it is mitigated by the approver-set check. | `accessRequestService.js:1000-1010, 541-547` |
| G18 | L | **Priority ties are broken arbitrarily** (DB order). Seeded policies don't tie, but user-created ones default to 100, the same as Dev & Staging. | `policyService.js:80, 342-344` |
| G19 | L | **`POST /api/policies/evaluate` with `policyId` or `policy` (draft) ignores the prod and bypass rule.** The route comment still says prod returns `allowed:false, requiresApproval:true`, which is stale. | `policyService.js:230-290`; `routes/policies.js:178-190` |
| G20 | L | **GROUP and USER subject IDs, `approverGroupId` and `approverUserIds` are not checked for org membership** on policy create or update. Evaluation is still org-scoped, so this is a data-integrity issue. **Imported ROLE subjects are not validated against the enum**: a typo means the subject never matches. | `policyService.js:559-643`; `routes/policies.js:40-47, 75-77`; `importService.js:579` |
| G21 | L | **Non-primary approvers can approve but cannot open `GET /api/access-requests/:id`** (403), and they cannot revoke. | `accessRequestService.js:1187-1190, 1007` |
| G22 | L | **`getAccessIntent.requiresApproval` is simply `isProduction`.** It is wrong for admins (who bypass) and for non-prod policies with `requireApproval=true`. | `accessRequestService.js:1519` |
| G23 | L | **The Quick Connect prod guard also blocks super_admin and admins**, which is stricter than the bypass role. Probably intended, but inconsistent with the bypass setting. | `quickConnectService.js:103-161` |
| G24 | L | **Groups and roles are independent.** A `member` placed in the `Admin` group matches Break-glass (a different TTL and routing), and an `admin` who isn't in the `Admin` group still matches through ROLE. For the defaults, group membership only changes *which* policy wins, never whether access is allowed. | `defaultSeedService.js:59-111`; `policyService.js:57-84` |

---

## 6. Role-name hardcoding in policy and access logic (needs replacing for custom roles and permissions)

### 6.1 Role rank tables (`super_admin 4 / admin 3 / manager 2 / member 1`)
| File:line | Use |
|---|---|
| `src/services/policyService.js:15, 22-27` | `ROLE_RANK` + `roleBypassesProd()` for the prod-approval bypass |
| `src/services/accessRequestService.js:45-49` | `isAdminOrAbove()`, used for revoke (`:1007`), list `tab=all` (`:1127`), and view-any (`:1188`) |
| `src/services/quickConnectService.js:33-34, 57, 63, 187` | Quick Connect `minRole` gate (default `'manager'`) |

### 6.2 Literal role checks inside access logic
| File:line | Check |
|---|---|
| `src/services/policyService.js:199` | `role === 'super_admin'`: full policy bypass (non-prod) and prod bypass |
| `src/services/accessRequestService.js:289` | `callerRole === 'admin' \|\| 'super_admin'`: may request an arbitrary principal |
| `src/services/accessRequestService.js:703` | Same check: may override the principal at credential or connect time |
| `src/services/accessRequestService.js:1517` | `adminCanOverride` in the access intent |
| `src/services/accessRequestService.js:1636` | Break-glass allowed only for `['admin','super_admin']` |
| `src/services/accessRequestService.js:1692` | Break-glass notification fan-out to `role in ['admin','super_admin']` |
| `src/services/quickConnectService.js:366` | Only `['admin','super_admin']` may create a new identity on save |
| `src/routes/certificates.js:95, 161` | `isAdmin` may issue certs for other users and view others' certs |
| `src/routes/accessRequests.js:244` | `requireRole('admin','super_admin')` on break-glass |
| `src/routes/policies.js:163, 202, 216, 231, 244, 259, 268` | Policy CRUD and evaluate are admin+ |
| `src/routes/groups.js:38, 47, 56-110` | Group read is manager+; group writes and membership changes are admin+ |
| `src/routes/quickConnect.js:96, 167` | QC settings are admin+; save-as-server is manager+ |
| `src/routes/org.js:43, 60, 70` | Org update and access-settings read are admin+; access-settings write is super_admin |
| `src/middleware/rbac.js:6` | `super_admin` bypasses **every** `requireRole` |

### 6.3 Role enum values stored as policy data (the data model itself is role-typed)
| File:line | What |
|---|---|
| `prisma/schema.prisma:10-15, 71` | `enum OrgRole` and `User.role` |
| `prisma/schema.prisma:540` | `AccessPolicy.approverRoles String[]`, holding OrgRole values |
| `PolicySubject { subjectType: 'ROLE', subjectId: <role> }` (`schema.prisma:555-567`) | Role as a policy subject |
| `src/services/policyService.js:65-67` | Subject matching on `subjectType:'ROLE', subjectId: user.role` |
| `src/services/policyService.js:516, 546` | `ROLE_LABELS` for the UI |
| `src/services/jitManifestService.js:67-73` | Duplicate ROLE-subject matching for JIT |
| `src/services/accessRequestService.js:149` | Approver resolution: `role: { in: policy.approverRoles }` |
| `src/routes/policies.js:38, 40-47, 76, 99` | `ORG_ROLES` validation for ROLE subjects and `approverRoles` |
| `src/services/importService.js:579` | CSV `subjectRoles` → ROLE subjects |
| `src/services/defaultSeedService.js:59, 77, 93, 96, 111` | Seeded `subjectRoles` / `approverRoles` |

### 6.4 Settings keyed on role names
| File:line | Setting |
|---|---|
| `src/services/orgService.js:11-12, 22-26`; `src/routes/org.js:54` | `settings.access.prodApprovalBypassMinRole ∈ {admin, super_admin, none}` |
| `src/services/quickConnectService.js:52-59`; `src/routes/quickConnect.js:28` | `settings.quickConnect.minRole ∈ OrgRole` |
| `prisma/seed.js:106, 118` | The seed forces `role: 'super_admin'` |

**Migration note.** A permissions model would need these capabilities at minimum:
- `access.prod.bypass_approval`
- `access.policy_bypass` (today's super_admin shortcut)
- `access.principal.override`
- `access.break_glass`
- `access.request.view_all` / `access.request.revoke_any`
- `quick_connect.use`
- `keystore.identity.create`
- `cert.issue_for_others`
- `policy.manage`
- `group.manage`
- `org.access_settings.manage`

Two data changes are also needed:
1. **ROLE-typed `PolicySubject` rows and `approverRoles`** must be migrated to reference custom role IDs, or replaced by GROUP and permission-based routing.
2. **The rank comparisons** (`>= admin`, `>= minRole`) have no meaning without an ordering. They need explicit permissions instead of "rank ≥ X".
