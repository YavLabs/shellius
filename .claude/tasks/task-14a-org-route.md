# Task 14A: Organization Route + Service

**Agent:** backend
**Status:** [x] Done
**Blocks:** 14D
**Blocked By:** None

## Objective
Create `GET /api/org` and `PUT /api/org` so the Settings → Organization tab
can read and persist organization-level settings (name, domain, logoUrl).
Right now the frontend save handler is a stub with a 600 ms delay and a
visible "TODO" banner.

## Deliverables
- `backend/src/routes/org.js`:
  - `GET /` — returns the current org row scoped via `req.orgId`
  - `PUT /` — admin+; validates `{ name, domain?, logoUrl? }` with Joi,
    updates the row, audits as `org.update`
- `backend/src/services/orgService.js`:
  - `getById(orgId)`, `update(orgId, data, actorId)`
- Register the router in `backend/src/app.js`
- Prisma `Organization` model already exists — verify columns: `name`,
  `domain` (nullable), `logoUrl` (nullable). Add a migration if missing.

## Validation
- `name` required, 1-255 chars
- `domain` optional, valid hostname pattern
- `logoUrl` optional, valid URL
- Reject `slug` updates — only super_admin can rename slugs (separate flow)

## Audit
Wrap `PUT /` with the audit middleware so `org.update` events appear in
the audit log with `before` / `after` diffs.

## Acceptance
- `curl PUT /api/org -d '{"name":"Acme"}'` updates the row and returns the
  fresh row in `data.organization`.
- Settings → Organization tab (after Task 14D) shows the saved values on
  reload, no TODO banner.
