# Phase 17: Connect Bugs, Uninstaller, Profile + GDPR, Default Policies, Help, Notification UI

Six items reported by the user — a mix of bugs and net-new features. All
follow the same workflow rule: every implementation task is paired with
a `qa` gate (Jest + live smoke) and a `reviewer` gate (security/UX/a11y),
and only ticks Done when both gates are green.

All agents already use `sonnet`. No agent model changes.

## 1. QuickConnect bugs (17A)

**Symptoms:**
- On the Servers list, clicking **Connect** opens the modal as designed.
  But typing in the username field triggers the modal close + navigation
  to the server detail page. Almost certainly a click-outside or focus
  handler bug — the keyboard input is being interpreted as a row click.
- On the **server detail page**, the action bar always shows **Request
  Access** instead of switching to **Connect** when an active approved
  AR exists.
- The list-vs-detail Connect/Request decision must be **identical**
  across both views.

**Fix:**
- `QuickConnectModal.jsx` — find the click handler that's closing the
  modal early. Likely culprits: missing `e.stopPropagation()` on the
  Input onChange or a portal/Dialog root that bubbles input events to
  the row click handler.
- `Servers.jsx` — confirm the row's `onRowClick` is null'd (or guarded)
  while a modal is open, OR confirm the modal renders in a portal that
  blocks event bubbling to the underlying row.
- `ServerDetail.jsx` — replace the static "Request Access" button with
  the same `QuickConnectButton` component used in the list. Then both
  views share one source of truth for the Connect-vs-Request decision.

Owner: **debugger** → **frontend**, **qa**, **reviewer**.

## 2. Default-to-saved SSH user with optional override (17B)

**Symptom:** when creating a server, the operator already specified the
SSH user. The Quick Connect modal should default the principal field to
`server.sshUser` (not `defaultPrincipal(currentUser)`), and only fall
back to the user's email-local-part when `server.sshUser` is empty.

**Fix:**
- `QuickConnectModal.jsx` — principal default order:
  1. `activeRequest.requestedPrincipal` (if connecting to an existing AR)
  2. `server.sshUser` (the value the operator stored)
  3. `defaultPrincipal(currentUser)` (email local-part)
  4. `'ubuntu'`
- Add an "Override username" toggle. When OFF, the input is read-only
  and the saved `server.sshUser` is used. When ON, the input becomes
  editable. Default state: OFF (lock to the saved value).

Same change in `RequestForm.jsx` for consistency.

Owner: **frontend**, **qa**, **reviewer**.

## 3. Bootstrap UNINSTALLER (17C)

**Goal:** reverse what `install.sh` did, without touching anything else
on the host. Specifically:
- Remove `/etc/ssh/shellius_ca.pub`
- Remove `/etc/ssh/sshd_config.d/99-shellius.conf` if present
- If the inline `# >>> shellius >>> ... # <<< shellius <<<` block was
  used in `/etc/ssh/sshd_config`, strip ONLY that block, leaving every
  other line untouched
- Remove `/etc/shellius/agent-token` and the `/etc/shellius/` directory
- Remove `/usr/local/sbin/shellius-check-principals`
- `sshd -t` to validate the cleaned config
- Reload sshd

**Critical safety rules** (from the user):
- The script must NEVER touch any unrelated sshd_config line.
- It must NEVER touch authorized_keys, host keys, the user's existing
  trusted CAs, or any other SSH-adjacent file.
- It must back up the modified sshd_config to `sshd_config.shellius.bak`
  before any edit so the operator can roll back.
- Run `sshd -t` BEFORE reloading, and refuse to reload if the test
  fails (preserve the working config no matter what).
- Print a clear summary of what was removed.

**Delivery:**
- New backend route `GET /api/bootstrap/uninstall.sh?token=<jwt>`
  that emits a self-contained bash uninstaller, same one-liner UX as
  the install script.
- New frontend modal `UninstallHostModal.jsx` (mirrors `BootstrapModal`)
  triggered from the Servers row menu and the ServerDetail action bar
  via a "Uninstall Shellius Agent" item.
- Inline self-test at the end of the uninstaller verifies the relevant
  files are gone and that `sshd -T` no longer mentions
  `TrustedUserCAKeys /etc/ssh/shellius_ca.pub`.

Owner: **backend** + **frontend**, **qa**, **reviewer**.

## 4. Default policies on first boot + per-page Help (17D)

### Default policies seed
On first install (when no `AccessPolicy` rows exist for the org), seed
3 starter policies via a Prisma `seed` script extension OR a one-time
boot job in the backend:

1. **`default-allow-non-prod`** — priority 100 — effect ALLOW —
   subjects: any user — targets: any server where
   `environment IN ('demo','dev','staging')` — constraints:
   `maxSessionDuration: 3600`, `requireApproval: false`,
   `autoApprove: true`
2. **`default-prod-requires-approval`** — priority 50 — effect ALLOW —
   subjects: any user — targets: any server where
   `environment === 'prod'` — constraints:
   `maxSessionDuration: 1800`, `requireApproval: true`,
   `autoApprove: false`. (Documented note: prod approval is enforced
   regardless by the backend invariant — this policy makes the rule
   explicit in the UI.)
3. **`default-deny-inactive`** — priority 10 — effect DENY —
   subjects: users with `status === 'deactivated'` — targets: all
   servers.

The seed runs as part of the existing `prisma seed` flow OR as an
idempotent backend startup job that no-ops when policies already
exist.

### Per-page Help drawer
Each top-level page gets a `HelpDrawer` accessible via a `?` icon in
the PageHeader's right slot. Contents:
- Short "What this page is for" paragraph
- "How to use" numbered list with screenshots/keywords
- Links to related pages

Help content lives in `frontend/src/config/helpContent.js` keyed by
page slug. Pages cover: dashboard, customers, servers, users, groups,
policies, access-requests, certificates, sessions, audit-log,
notifications, settings.

Owner: **db** + **backend** for the seed, **planner** + **frontend**
for the help content + drawer, **qa**, **reviewer**.

## 5. Notification badge UI fix (17E)

**Symptom:** the unread badge in the topbar bell is bigger than the
icon itself. Visual mess.

**Fix:**
- `frontend/src/components/layout/NotificationBell.jsx` — shrink the
  badge to a `h-4 min-w-4` pill positioned at the top-right with
  `-translate-x-1 -translate-y-1` so it overlaps the icon corner
  cleanly. Cap displayed count at `9+`.
- Switch the icon to a **filled** Lucide variant (`BellRing` or
  `BellDot`) when `unreadCount > 0`, plain `Bell` otherwise — gives
  a clear visual cue at a glance.

Owner: **frontend**, **qa**, **reviewer**.

## 6. Profile page + GDPR + registration flow (17F)

This is the largest sub-task and ships in three layers:

### 6a. Profile page (`/profile`)
- Sidebar entry under "Account" (or in the bottom user card)
- Fields:
  - Avatar (placeholder initials for now)
  - Name (editable for everyone)
  - Email (read-only — managed by SSO/admin)
  - Role (read-only)
  - Created at, last login (read-only)
- "Change password" section — only rendered when:
  - `user.passwordHash != null` (the user has a local password)
  - `user.ssoProvider == null` (the user is not SSO-only)
- Form: current password + new password + confirm. Calls
  `PUT /api/users/me/password`.

### 6b. GDPR data export + delete account
- "Export my data" button → calls `GET /api/users/me/export` →
  downloads a JSON blob with the user's row + their access requests +
  their certificates + their session metadata + their audit log
  entries (filtered to actorId = self).
- "Delete account" danger zone — requires typing `DELETE` to confirm
  → calls `DELETE /api/users/me` → soft-delete (status='deleted')
  with a 30-day grace period before hard delete. The endpoint:
  - revokes all the user's access requests
  - revokes all their active certificates
  - logs them out (invalidates refresh tokens)
  - writes an immutable audit entry
  - sends a "Your account has been deleted" email (using the new
    HTML template infrastructure from Phase 16)
- Soft-deleted users are filtered out of every list endpoint and
  cannot log in.
- A nightly job hard-deletes rows older than the grace period.

### 6c. Registration flow for invited users
The invite flow today (Phase 14G) hands the invitee a one-time URL
that lets them set a password. That's already a "registration" path
in spirit, but the UX wording is "Accept Invitation". Rename and
generalize:
- Rename `AcceptInvite` page UI copy to "Set up your account" with
  fields:
  - Email (read-only, from invite)
  - Full name (editable, pre-filled from invite if present)
  - Password + confirm
  - Checkbox: "I agree to the Terms and Privacy Policy" (linked
    placeholders for now)
- Backend already has the consume endpoint — just needs to accept
  an optional `name` field to update the user row.
- For self-service registration (super admin enables it via a
  setting), open `POST /api/auth/register` — creates a new user
  with a pending status, sends a verification email.
- The Login page gets a "Don't have an account? Sign up" link that
  becomes visible only when self-service registration is enabled
  for the org.

Owner: **db** (schema for soft-delete + verify token), **backend**
(routes + service + jobs), **frontend** (page + form), **planner**
(GDPR copy), **qa**, **reviewer**.

## Sub-tasks

| ID  | Title                                          | Agent           | QA | Review |
|-----|------------------------------------------------|-----------------|----|--------|
| 17A | Quick Connect modal close bug + ServerDetail   | debugger → frontend | 17Q-A | 17R-A |
| 17B | Default to server.sshUser + override toggle    | frontend        | 17Q-B | 17R-B |
| 17C | Bootstrap uninstaller (script + UI + safety)   | backend + frontend | 17Q-C | 17R-C |
| 17D | Default policies seed + per-page Help drawer   | db + backend + frontend | 17Q-D | 17R-D |
| 17E | Notification badge UI fix                       | frontend        | 17Q-E | 17R-E |
| 17F | Profile + GDPR + registration                  | db + backend + frontend | 17Q-F | 17R-F |

## Workflow rule
Same as Phases 14, 15, 16: every implementation task only ticks Done
when its matching qa gate AND reviewer gate are both green. The
reviewer fixes high/critical findings inline before sign-off.
