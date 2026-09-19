# RBAC audit and custom-roles plan

Audit date: 2026-09-18, before custom roles. It covers every API endpoint (204 HTTP routes and 4 WebSocket modes), every role check hidden in services, every role-gated UI element (153), and the seeded access policies.

## Files in this folder

| File | What it is |
|---|---|
| `permission-matrix.csv` | **The matrix to review and edit.** One row per permission (61), with columns for which roles have it today (`before_*`) and which built-in roles get it by default (`default_*`). Rows whose defaults change are marked `changed`, and the audit finding each change fixes is listed. It is generated from `backend/src/config/permissions.js`. Regenerate with `node backend/scripts/rbac-matrix.mjs`. |
| `endpoint-matrix.csv` | Every endpoint before custom roles: method, path, file:line, and member / manager / admin / super_admin access (`Y` yes, `N` no, `C` conditional, `S` self only), plus the hidden conditions. |
| `access-policies.md` | How the seeded groups and policies work, how policy evaluation and approvals work, a role × environment × auth-mode scenario table, and policy-specific gaps (`G1`–`G24`). |
| `rbac-audit.md` | This file: how RBAC works, what each role can do, all gaps ranked, and the custom-roles design. |

## How RBAC works today

- **Roles.** There are four fixed roles, `super_admin > admin > manager > member` (Prisma `enum OrgRole`). CLAUDE.md's `operator` / `viewer` do not exist, although the SSO default and the users import template still use them.
- **Route guards.**
  - `requireRole('admin', 'super_admin', …)` spells out an allow-list at about 150 call sites, in 12 distinct combinations.
  - `super_admin` passes every check.
  - About 58 authenticated routes have no guard. Most of these are correct self-service routes. Five are not (see F-01, F-03, F-07).
- **Hidden checks.**
  - Five copies of a role-rank table.
  - Inline `['super_admin','admin'].includes(role)` checks.
  - Two settings keyed on role names: `prodApprovalBypassMinRole` and `quickConnect.minRole`.
  - A hard-coded super_admin shortcut in the policy engine.
- **Freshness.** The role is re-read from the database on every request, including the WebSocket path. A role change also signs the user out everywhere, so there is no stale-role bug on the backend. The UI keeps the old role until its next API call returns 401.
- **Frontend.**
  - Eight copies of `ROLE_RANK` / `isAtLeast`.
  - A `can()` helper that only one page uses, and 3 of its 22 entries disagree with the backend.
  - Route and nav visibility defined in four places that are kept in sync by hand.
- **Groups grant no API permissions.** They only make users policy subjects or approvers. Being in the seeded `Admin` group does *not* skip prod approval, even though the group's description says it does.

## What each role can do today (summary)

The complete list is in `endpoint-matrix.csv`.

| Role | Can | Cannot |
|---|---|---|
| **Member** | <ul><li>View customers and servers</li><li>Request access (dev/staging/demo auto-approved for 8h; prod needs approval)</li><li>Use the web terminal and RDP on approved requests</li><li>Manage their own profile, MFA, CLI devices and notifications</li><li>Change the IP of any dynamic-IP server (**gap**)</li><li>Get a CA-signed cert for any principal via `/certificates/issue` (**critical gap**)</li></ul> | Quick Connect (default), Keystore, sessions, groups, anything admin |
| **Manager** | Everything a member can, plus: <ul><li>Create and edit customers and servers, including changing a server's **environment** and **bound identity** (**gap**)</li><li>Onboard, provision and health-check hosts</li><li>View all sessions and **download every recording**</li><li>View the Keystore and test identities against **any host** (**gap**)</li><li>Quick Connect, including with stored identities (**gap**)</li><li>View groups</li><li>Approve requests when routed to them (every member's prod request goes to every manager)</li></ul> | See users (not even their own reports), see policies, prod without approval (and without a `managerId` they can't request prod at all: G9) |
| **Admin** | Everything a manager can, plus: <ul><li>Users (invite, edit, suspend, reset, sign out)</li><li>Groups and policies</li><li>Keystore management, private-key export and deployment</li><li>Certificates and audit log</li><li>Terminate sessions</li><li>Bulk import</li><li>Quick Connect settings</li><li>**Prod without approval** (default setting)</li><li>Break-glass</li><li>Choose any login user</li><li>**Take over any super admin account** (**critical gap**)</li><li>**Rewrite the super-admin-only prod setting** via `PUT /api/org` (**gap**)</li></ul> | Delete users, servers or customers; SSO, SMTP, MFA or storage settings; CA rotation; audit export; change the access settings (through the proper route) |
| **Super admin** | Everything. Skips all access policies off-prod, including DENY. | — |

## Findings, ranked

The IDs refer to the detailed write-ups:
- `F-xx`: backend audit
- `G-xx`: `access-policies.md`
- `UI-x.y`: frontend audit

"Fix" says how the custom-roles work resolves each finding.

### Critical — privilege escalation

| ID | Finding | Fix |
|---|---|---|
| F-01 | `PUT /api/users/:id` never compares the target's role with the caller's. An admin can set a super admin's password or email, demote them, or suspend them, including the last super admin. The CSV import overwrite path does the same. None of this is audited. | Users can only be managed by someone who holds every permission the target holds. The last super admin is protected on every path. A password can no longer be set for another user (reset link only). Every change is audited. |
| F-02 | Resend-invite and password-reset work on any user, including a super admin. When email isn't configured, the link comes back in the response, and accepting an invite reactivates suspended accounts. | The same rule as F-01 applies to the target. Invites are refused for users who are active or suspended. |
| F-03 / G1 / G2 | `POST /api/certificates/issue` (any user, no callers in the UI or CLI). Without `serverId` the policy is skipped entirely: a 7-day CA cert for `root`, HOST certs, arbitrary extensions. With `serverId`, only the first principal is checked. | New `certificates.issue_direct` permission, super admin only by default. `serverId` is required, every principal is checked, only USER certs are issued, prod is refused, and extensions come from a fixed set. |
| F-04 | An admin can issue certs *as* another user (for example a super admin) and inherit that user's policy bypass. Prod issuance creates no request and no audit. | Issuing for others requires holding every permission the target holds, and prod is always refused on this path. |

### High

| ID | Finding | Fix |
|---|---|---|
| F-10 / G3 | `PUT /api/org` (admin) writes `settings` wholesale, so it can undo the super-admin-only prod-approval setting. | `PUT /api/org` accepts name, domain and logo only. Settings go through their own permission-gated routes. |
| F-05 | Managers can move servers out of prod (`PUT` and `/bulk`), bind any Keystore identity to a server, and redirect a credential server's IP. None of it is audited. | `servers.change_environment` and `servers.manage_credentials` become separate permissions, admin by default. Server mutations are audited. |
| F-06 | Any member can change the IP of any dynamic-IP server, including prod. | `servers.update_connection_ip`, manager by default. Audited. |
| F-07 / G17 | Access-request revoke looks the request up without the org ID, so it works across orgs. | The lookup is scoped by org. |
| F-09 / G5 | Break-glass and prod key deployment ignore the prod-approval setting. | Both become explicit permissions (`access.break_glass`, `keystore.deploy`). Deploying to prod also requires `access.prod_bypass`. |
| F-16 | Object-storage config is global to the install, but any org's super admin can change it. | The `settings.storage` permission is marked sensitive and documented as install-wide. A true platform-operator role is out of scope. |
| F-17 | Managers can test stored identities against any host, which exposes the secret. Any Quick Connect user can use any stored identity against any non-prod host. | Testing is limited to saved servers unless the user has `keystore.manage`. `quick_connect.use_stored_identity` is admin by default. |
| G4 / F-14 | Approvers can grant up to 7 days. The policy's max duration is ignored. | The approved duration is capped at the matched policy's `maxSessionDuration`. |
| G6 | Quick Connect ignores policies (including DENY) for saved non-prod servers. | A saved server's DENY policies are applied in Quick Connect too. |

### Medium

| ID | Finding |
|---|---|
| F-08 | Self-service `PUT /api/users/:id` is a weaker password change than `/me/password`: no current password, minimum 8 characters, no session revoke. |
| F-11 | Accepting an invite reactivates suspended users. |
| F-12 / G16 | Approvers are snapshotted at submit and never re-checked. Email approval links still work for suspended or demoted approvers. |
| F-13 | Deleting a customer turns its customer-scoped policies into org-wide grants. |
| F-18 / G14 | Admin principal override at connect time isn't checked against the policy's allowed principals. |
| F-20 | Unaudited mutations: user role, status and delete; customers; groups; servers; bootstrap links; recording downloads. |
| F-21 | A demotion leaves already-approved prod access in place. |
| F-22 | Managers can see every recording but not their own direct reports or policies. |
| G7 | The policy fields `autoApprove` and `isBreakGlass` are never read. The seeded "Break-glass Production" policy is silently the routine admin prod policy (1h instead of 2h). |
| G8 | Prod-bypass "approvers are notified" usually notifies nobody. |
| G9 | Managers without a `managerId` can't request prod ("No approver configured"). |
| G11 | Deleted or renamed default policies and groups come back on every restart. |
| G15 | Default principals miss common users (`debian`, `centos`, `deploy`…), so those servers are "No matching policy" for everyone except super admin. |
| UI-2.9 – 2.11 | Approve, revoke and view rules differ between the UI and the API. Secondary approvers can't open the requests they're asked to approve. |
| UI-3.1 | Personal notification preferences are hidden inside the super-admin-only Settings tab. Nobody else can change them. |

### Low

| ID | Finding |
|---|---|
| UI-2.1 – 2.3 | Delete server, customer and user are shown to admins but the API requires super admin. |
| UI-2.4 / 2.5 | The role dropdown offers Super admin to admins, and row actions aren't rank-aware. |
| UI-2.6 / 2.7 | Members get the server bulk-edit bar. Dashboard cards show 0 sessions and 0 certificates to lower roles (a hidden 403). |
| F-19 | The RDP gateway token can be replayed within 5 minutes and is not re-checked. |
| F-25 | SSO `defaultRole` defaults to the nonexistent `viewer`, which breaks JIT sign-up. The import template uses `operator`. |
| F-26 / G13 | The key-download gate checks *any* policy in the org, not the matched one. |
| TUI | The CLI assumes only `super_admin` skips prod approval, but the default is admin and the setting is configurable. |

## Custom roles: design

### Model

- **`Role`** (org-scoped): `key`, `name`, `description`, `permissions String[]`, `baseRole` (tier), `isSystem`, and `catalogVersion`.
  - Four system roles are created per org from the catalogue: `super_admin`, `admin`, `manager` and `member`.
  - Custom roles are added by the org.
- **`User.roleId`** points at the role. The existing `User.role` column stays, holding the role's **base tier**. That keeps these working unchanged:
  - policy ROLE subjects and `approverRoles` (a custom role based on `admin` matches admin policies)
  - the CLI's role display
  - the seeded policies
- **Policies can also target a custom role directly.** A ROLE subject's id may be a custom role key.

### Rules

- **Permission check.** `requirePermission('servers.update')` replaces every `requireRole(...)`. The role's permissions are loaded from the database with the user on every request, so changes apply immediately.
- **Super admin** always has every permission and can't be edited or deleted. At least one active super admin must remain.
- **No escalation (subset rule).** You can only create or edit a role, assign a role, or manage a user if the permissions involved are ones **you hold yourself**. An admin can never make anyone more powerful than themselves.
- **Your own role.** You can't change your own role or edit the role you hold, so nobody can lock themselves out or grant themselves more.
- **Built-in roles** (admin, manager, member) can be edited, and have **Reset to defaults**. Custom roles can be cloned from any role.
- **Who defines roles:** admins and super admins (`roles.manage`). Admins are limited to permissions they hold, so they can build roles up to, but never beyond, Admin.
- **Deleting a role** requires moving its users to another role first. Policies that target it lose that subject, and this is shown before deleting.
- **Settings keyed on role names become permissions.** `prodApprovalBypassMinRole` becomes `access.prod_bypass`, and `quickConnect.minRole` becomes `quick_connect.use`. They migrate from the current settings, so behavior is identical on upgrade.
- **SSO and self-registration** assign a role by id. SSO auto-provisioning can't assign a role holding sensitive permissions.
- **Everything is audited:** `role.created`, `role.updated` (with the permission diff), `role.deleted`, and `user.role_changed`.
- **New permissions added in later releases** are granted to existing roles by their base tier (`catalogVersion`), so custom roles don't silently lose new features.

### Example: "more than admin, less than super admin"

Clone **Admin** into **Senior admin** and add `settings.smtp`, `settings.mfa`, `audit.export` and `users.delete`. Leave out `settings.sso`, `settings.storage`, `ca.rotate` and `roles.manage`. Senior admins then get those extra screens and buttons. A super admin creates it, since it holds permissions admins don't have. An admin can't assign, edit or copy it for the same reason.
