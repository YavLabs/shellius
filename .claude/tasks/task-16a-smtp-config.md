# Task 16A: SMTP Config Table + Env-Merge

**Agent:** backend
**Status:** [x] Done
**Blocks:** 16D, 16Q-A, 16R-A
**Blocked By:** None
**Model:** sonnet

## Objective
Per-org SMTP configuration, with env vars as fallback defaults. Today
mailer.js reads SMTP_HOST etc. at process start and never changes.
Super admins need to override via the UI without a container restart.

## Schema
New Prisma model `SmtpConfig`:
- id, orgId (unique), host, port, username,
  passwordEncrypted (text), fromAddress, useTls (bool), isActive,
  createdAt, updatedAt
- Relation to Organization, cascade delete
- Encrypted with the existing crypto.encrypt() helper

Migration: `add_smtp_config`.

## Routes (new file backend/src/routes/smtp.js)
- GET /api/settings/smtp — admin+; returns the row merged with env
  defaults, password masked (`hasPassword: bool`)
- PUT /api/settings/smtp — admin+; Joi validate, upsert; encrypt
  password if provided, else preserve existing
- POST /api/settings/smtp/test — admin+; sends a test email to the
  caller's address via the effective config (DB merged with env)
- DELETE /api/settings/smtp — admin+; drops the DB row, falls back to
  env defaults

Register in app.js at `/api/settings/smtp`.

## Service (backend/src/services/smtpConfigService.js)
- `getEffective(orgId)` — returns the merged config:
  ```js
  {
    host: dbRow?.host || process.env.SMTP_HOST || null,
    port: dbRow?.port || parseInt(process.env.SMTP_PORT, 10) || 587,
    username: dbRow?.username || process.env.SMTP_USER || null,
    password: dbRow ? decrypt(dbRow.passwordEncrypted) : process.env.SMTP_PASS || null,
    fromAddress: dbRow?.fromAddress || process.env.SMTP_FROM || null,
    useTls: dbRow?.useTls ?? (process.env.SMTP_SECURE !== 'false'),
    source: {
      host: dbRow?.host ? 'db' : 'env',
      username: dbRow?.username ? 'db' : 'env',
      // ... per-field provenance
    },
  }
  ```
- `upsert(orgId, data)` — writes/updates the DB row, encrypts password
- `remove(orgId)` — drops the row

## mailer.js changes
- Remove the lazy-init process-level transport
- Per-call: `getEffective(orgId)` → build a fresh nodemailer transport
  → send → close
- On log-only fallback (no host at all from env or DB), keep the
  existing logger.warn behavior
- Add `auditLog` call on successful/failed send

## Audit
- `smtp.config.updated`, `smtp.config.test`, `smtp.config.deleted`

## Acceptance
- Setting SMTP_HOST in .env.prod and restarting the backend lets
  emails send with those defaults.
- An admin saving an override in Settings → Notifications takes
  effect on the next email without a restart.
- DELETE reverts to env defaults.
- GET response never returns the plaintext password.
