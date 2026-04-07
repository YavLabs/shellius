# Task 14C: User Preferences Route + Service

**Agent:** backend
**Status:** [x] Done
**Blocks:** 14D
**Blocked By:** None

## Objective
Persist per-user notification preferences server-side. Today the
Settings → Notifications tab writes to `localStorage` only, so toggles
don't survive logout / device switches and the backend can't honor them.

## Deliverables
- Prisma: add `preferences` JSONB column to the existing `User` model
  (default `{}`); a migration to back-fill empty objects
- `backend/src/routes/users.js`: extend with
  - `GET /api/users/me/preferences` — any authenticated user
  - `PUT /api/users/me/preferences` — any authenticated user; merges
    `{ emailNotifications?: bool, expiringSoonAlerts?: bool, ... }`
- `backend/src/services/userService.js`: `getPreferences`,
  `updatePreferences` — strict allow-list of keys, no arbitrary fields
- Hook the existing `notifyExpiringAccess` job to read
  `preferences.emailNotifications` before sending an email

## Acceptance
- Toggling Notifications in Settings persists across logout and across
  devices, no localStorage TODO banner.
- The expiry-notification job no longer emails users who opted out.
