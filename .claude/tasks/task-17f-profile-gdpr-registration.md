# Task 17F: Profile Page + GDPR Export/Delete + Registration

**Agent:** db + backend + frontend
**Status:** [ ] Pending
**Blocks:** 17Q-F, 17R-F
**Blocked By:** None
**Model:** sonnet

## Part 1 — Profile page

New page `/profile` with:
- Avatar (initials placeholder)
- Name (editable for everyone via `PUT /api/users/me`)
- Email, role, created, last login (read-only)
- "Change password" section — only rendered when:
  - `user.passwordHash != null` AND `user.ssoProvider == null`
- Form: current password + new password + confirm
- Calls `PUT /api/users/me/password` (new endpoint)

Backend:
- `PUT /api/users/me` — updates name (allow-list)
- `PUT /api/users/me/password` — verifies current password via bcrypt,
  rejects if SSO-only, updates `passwordHash`, audit logs
  `user.password.changed`, sends `passwordChanged` HTML email
  (using the Phase 16 template infra)

## Part 2 — GDPR export + delete

### Export
- `GET /api/users/me/export` — admin-or-self; returns a JSON document
  with the user's row + their access requests + their certificates +
  session metadata + audit log entries (filtered to actorId = self).
  No other users' data. No org-wide secrets.
- Frontend: "Export my data" button → triggers download as
  `shellius-export-<userId>-<timestamp>.json`.

### Delete account (soft + hard)
- `DELETE /api/users/me` — soft delete:
  - Sets `status = 'deleted'`, `deletedAt = now()`
  - Revokes all the user's active access requests
  - Revokes all their active certificates
  - Invalidates all their refresh tokens
  - Writes audit entry `user.account.deleted`
  - Sends a "Your Shellius account has been deleted" HTML email
- Schema: add `deletedAt` and `deletedScheduledAt` columns to User,
  add `'deleted'` to the UserStatus enum
- New nightly job `purgeDeletedAccounts.js` — hard-deletes user rows
  whose `deletedAt < now() - 30 days`. Hard delete is irreversible
  (cascades to dependent rows via Prisma `onDelete: Cascade`).
- All list endpoints add `where: { status: { not: 'deleted' } }`
  (or use a Prisma middleware) so soft-deleted users disappear.
- Login is blocked for soft-deleted users.

Frontend:
- "Delete account" danger zone in profile — typed-confirmation
  ("DELETE") + final confirm modal. On success: clears tokens, redirects
  to login with a "Your account has been deleted" banner.

## Part 3 — Registration

### Invited user setup (rebrand)
- `frontend/src/pages/AcceptInvite.jsx` rebranded to "Set up your account":
  - Pre-filled email (read-only)
  - Editable Name (pre-filled from invite if present)
  - Password + confirm
  - Required Terms+Privacy checkbox
- Backend `POST /api/auth/invite/:token/accept` already exists; extend
  to accept an optional `name` and update the row.

### Self-service registration (gated by org setting)
- New org-level setting `selfServiceRegistrationEnabled` (boolean,
  default false) on the Organization model
- New `POST /api/auth/register` — public; creates a user with
  `status='pending_verification'`, sends a verification email with
  one-time token (reuse the UserToken table from Phase 14)
- New `POST /api/auth/verify-email/:token` — completes registration,
  flips status to `active`
- Login page: "Don't have an account? Sign up" link visible only when
  the org has self-service registration enabled. Discovery via a new
  public endpoint `GET /api/auth/registration-status` that returns
  `{ enabled: bool }`.

## Schema additions
- User: `deletedAt DateTime?`, `passwordChangedAt DateTime?`,
  `UserStatus` enum gets `deleted` and `pending_verification`
- Organization: `selfServiceRegistrationEnabled Boolean @default(false)`
- Migration: `add_user_soft_delete_and_registration`

## Acceptance
- /profile page loads, shows the correct fields based on auth method.
- Change password works for local users; hidden for SSO users.
- Export downloads a valid JSON file.
- Delete account flows end-to-end, with proper auth-token cleanup,
  audit log, and confirmation email.
- Soft-deleted users can't log in and don't appear in lists.
- Hard-delete job runs and removes 30-day-old soft deletes.
- Invited user setup page renders the new copy.
- Self-service registration works when the org enables it.
