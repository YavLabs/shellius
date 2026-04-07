# Task 14G: User Invite + Password Reset Flow

**Agent:** backend + frontend
**Status:** [x] Done
**Blocks:** 14L
**Blocked By:** None

## Objective
Users.jsx can create users but there is no path to actually onboard them
(no invite email) and no path to recover lost credentials (no password
reset). Both flows must exist end-to-end.

## Deliverables

### Backend
- `backend/src/services/inviteService.js`:
  - `createInvite(orgId, userId)` — creates a single-use token (JWT or
    DB row), TTL 7 days; returns the absolute invite URL
- `backend/src/routes/users.js`:
  - On `POST /api/users` with `status: 'invited'`, automatically issue
    an invite token and email it (existing email transport, see
    `notificationService`)
  - `POST /api/users/:id/resend-invite` — admin+; re-issues
  - `POST /api/users/:id/password-reset` — admin+ or self; emails a
    reset link
- New public routes:
  - `GET /api/auth/invite/:token` — verifies the token and returns the
    invite metadata (user, org)
  - `POST /api/auth/invite/:token/accept` — sets the user's password and
    marks status `active`
  - Same shape for `/api/auth/password-reset/:token`

### Frontend
- Users page row menu: "Resend invite" (when status is `invited`),
  "Send password reset"
- New public pages:
  - `/invite/:token` — set initial password form
  - `/password-reset/:token` — set new password form
- Both wired up in `App.jsx` outside the authenticated layout

## Email body
Use a minimal HTML template; no third-party dependency. Reference
`SHELLIUS_DOMAIN` (or `TRAEFIK_HOST`) when building absolute links.

## Acceptance
- An admin can invite a user, the invitee receives an email with a
  one-click link, sets a password, and lands on the dashboard logged in.
- An admin can trigger a password reset for any user.
- A user can request their own password reset from the login page.
