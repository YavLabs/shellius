# Task 16Q-*: QA Gates for Phase 16

**Agent:** qa
**Status:** [x] Done
**Blocked By:** matching implementation task
**Model:** sonnet

Same workflow as 15Q-*: every sub-task has a QA gate that writes
Jest/Vitest tests, runs the full backend suite, and smokes the live
stack before the implementation task ticks Done.

## 16Q-A — SMTP config
- Jest: smtpConfigService.getEffective merges DB + env correctly per
  field, password encryption round-trip, env-only fallback
- Live: PUT /api/settings/smtp → GET reflects the change → Test
  button actually sends
- Delete → GET falls back to env

## 16Q-B — SSO env defaults
- Jest: ssoConfigService.getEffective returns the right source map
- Live: set SSO_GOOGLE_CLIENT_ID in env, reload Settings → SSO, see
  the pre-filled value + "Environment default" badge. Save a different
  value, reload, see the override.

## 16Q-C — Email template infra
- Jest: each template renders valid HTML + text, `escape()` protects
  against XSS, subject lines start with `[Shellius]`
- Preview: `node backend/scripts/preview-email.js <template>` outputs
  an HTML file that opens in a browser

## 16Q-D — sendMail callsite rewrites
- grep -rn 'sendMail.*text:' backend/src | wc -l → 0 (outside mailer.js)
- Manual trigger of each flow (invite, reset, etc.) → inbox renders HTML

## 16Q-E — Group membership audit
- Jest: POST/DELETE /groups/:id/members writes an AuditLog row with
  the right action and payload
- Live: add member, tail /audit-log page, see the new entry

## 16Q-F — SSO preset regex
- Jest: backend Joi rejects malformed tenantId/oktaDomain/auth0Domain
- Live: form shows red border + disabled save on bad input

## 16Q-G — Docs
- Check every env var in .env.prod.example corresponds to something
  the backend actually reads
- Render docs/*.md in GitHub preview, no broken links
