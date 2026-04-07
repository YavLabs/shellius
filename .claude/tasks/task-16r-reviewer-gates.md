# Task 16R-*: Reviewer Gates for Phase 16

**Agent:** reviewer
**Status:** [ ] Pending
**Blocked By:** matching implementation + QA gate
**Model:** sonnet

Same workflow as 15R-*: per-sub-task security/UX/a11y review, high/
critical findings fixed inline, medium/low filed as follow-ups.

## 16R-A — SMTP config
- SMTP password encrypted at rest with existing crypto helper
- GET endpoint masks the password, never returns plaintext
- Test endpoint rate-limited (reuse authLimiter or a dedicated one)
- SMTP transport creation does not log credentials
- SSRF: test-email destination is the caller's own address only — no
  arbitrary recipient input

## 16R-B — SSO env defaults
- `source` map in the GET response does not leak env-var values —
  only the string `'env'` or `'db'`
- Wizard does not send env-default secrets to the frontend in plain;
  if the DB row is empty but the env default is set, the UI shows
  "env default" + the clientId (not the secret)

## 16R-C — Email template infra
- All variable interpolation goes through `escape()` — no raw
  template literals interpolating user-supplied data
- No `${}` expression in layout.js evaluates user input

## 16R-D — Callsite rewrites
- No regressed audit log entry (every pre-existing audit call
  survives the refactor)
- No password/token leak in the HTML body or subject

## 16R-E — Group audit
- Audit middleware wired on BOTH add + remove
- RBAC still enforced (admin+ only)

## 16R-F — SSO preset regex
- Backend Joi patterns match the frontend patterns
- No open redirect via a crafted domain that matches the regex but
  is non-ASCII or contains `@`

## 16R-G — Docs
- No credentials or tokens in committed docs or .env.prod.example
