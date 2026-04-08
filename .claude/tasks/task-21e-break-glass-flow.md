# Task 21e — Break-glass access flow

**Phase:** 21A
**Plan:** `.claude/plans/phase-21-jit-user-provisioning.md`
**Agent:** backend + frontend
**Depends on:** task-21a

## Scope
Implement an admin-only emergency access flow that bypasses normal approval and notifies all admins.

## Steps (backend)
1. `POST /api/access-requests/break-glass`:
   - RBAC: `admin` or `super_admin` only.
   - Body: `{ serverId, reason (required, min 20 chars), durationSeconds (max 1h by default) }`.
   - Creates an `AccessRequest` pre-approved (`status: APPROVED`), flagged `breakGlass: true` (add `breakGlass Boolean @default(false)` column if not already present in task-21a).
   - Writes audit log entry with `event: BREAK_GLASS_INVOKED`, high severity, full request details.
   - Fan-out notification: email + in-app to every admin/super_admin in the org.
2. Update `accessRequestService` to honor the flag in downstream flows.

## Steps (frontend)
1. On server detail page, a red "Break-glass access" action (admin-only).
2. Confirmation modal: mandatory reason (>=20 chars), duration picker (15m / 30m / 1h), prominent red "This will page all admins" warning.
3. On submit, open the web terminal immediately using the new AR.

## Verification
- Admin can break-glass into any server in the org, even one they have no normal policy access to.
- Non-admin sees no button and the endpoint returns 403.
- All admins receive the notification email + in-app.
- Audit log shows the event with severity HIGH.
