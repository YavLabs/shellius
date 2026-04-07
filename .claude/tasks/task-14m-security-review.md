# Task 14M: Security Review of Phase 14 Routes

**Agent:** reviewer
**Status:** [x] Done — 1 high (fixed), 3 medium, 2 low, 1 info
**Blocks:** None
**Blocked By:** 14A, 14B, 14C, 14G

## Objective
Phase 14 introduces several new write paths that touch sensitive data
(SSO secrets, user preferences, invite tokens, password resets). Each
needs a focused security review before they go live.

## Items
- **`org` route (14A)** — only admins can mutate; org_id scoping enforced
- **`sso` route (14B)**:
  - Client secret encrypted at rest with `SERVER_ENCRYPTION_KEY`
  - GET endpoint never returns plaintext secret
  - Test endpoint cannot be used to SSRF arbitrary internal URLs (validate
    `issuerUrl` against an allow-list of public schemes + DNS, reject
    private IP ranges by default unless an env flag explicitly allows)
- **`userPreferences` route (14C)** — strict allow-list of preference
  keys; reject arbitrary payloads
- **Invite + password reset tokens (14G)**:
  - Single-use, TTL ≤ 7 days
  - Token hashed in DB (sha256), never stored plaintext
  - Constant-time comparison on lookup
  - Rate-limit the `/auth/invite/:token/accept` and reset endpoints
  - Email body contains an absolute URL with the token in the path, not
    in a query parameter (avoids log leakage)
- **All routes** — audit log entries for every mutation
- **CA private key handling** is unchanged (already reviewed in earlier
  phases) but verify nothing in 14B/14G accidentally logs secret material

## Reporting
Add a `## Findings` section to this file with one bullet per issue,
severity, and the file:line where it lives. Block the merge if any
high-severity finding is open.

## Findings

### Verified safe
- **[OK]** `inviteService.js:91` — invite/reset tokens are 32 bytes from `crypto.randomBytes`, hashed with `sha256` before DB store. The raw token is never persisted.
- **[OK]** `inviteService.js:9-10` — single-use semantics enforced via `usedAt` flag set on first successful consume; expiry checked on consume.
- **[OK]** `inviteService.js:79` — invite TTL is the documented 168 h (7 days); reset TTL is 1 h. Both are reasonable.
- **[OK]** `routes/auth.js:8,204,277` — both `/invite/:token/accept` and `/password-reset/:token/reset` use `tokenActionLimiter` from the existing rate-limiter middleware. `/password-reset` self-service uses the same limiter.
- **[OK]** `routes/auth.js:321,377` — public `POST /password-reset` always returns 204; the heavy lookup runs in a background promise and any error is logged (not thrown to the client) — no enumeration via status code or response body.
- **[OK]** `ssoConfigService.js:56-103` — SSRF guard rejects 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, ::1, fc00::/7, and bare IP literals before any DNS round-trip. Verified live: `curl -X POST .../sso/config/test -d '{"issuerUrl":"http://127.0.0.1"}'` → 400 "private IP addresses are not allowed".
- **[OK]** `ssoConfigService.js:189-208` — discovery fetch uses `AbortController` with a 5 s timeout.
- **[OK]** `ssoConfigService.js` GET path — secret is masked; the encrypted blob is stripped from the response, only `hasSecret: true` is sent.
- **[OK]** `ssoConfigService.js:128` upsert — if `clientSecret` is omitted, the existing encrypted secret is preserved (rotation only when explicitly provided).
- **[OK]** `routes/org.js` — `requireRole('admin')` (super_admin auto-bypass), `tenant` middleware enforces `req.orgId`, allow-list excludes `slug`/`id`, audit middleware fires on PUT.
- **[OK]** `routes/users.js /me/preferences` — resolves to `req.user.userId`, no path-arg user id, allow-list strict.
- **[OK]** `accessRequests.js requestedPrincipal` — POSIX-ish regex `^[a-z_][a-z0-9_-]{0,31}$` enforced server-side.
- **[OK]** `policies.js priority` — `Joi.number().integer().min(1)` intact; default is 1.
- **[OK]** `app.js BigInt.prototype.toJSON` — placed before any module imports that may instantiate BigInts; correctly stringifies for JSON.

### Issues found

- **[HIGH] [routes/sso.js:`discover()`]** — The legacy OIDC login `discover()` helper called `fetch(issuerUrl + '/.well-known/openid-configuration')` with **no SSRF guard and no timeout**. A tampered or legacy DB row with `issuerUrl: http://169.254.169.254/...` could be used at login-init time to scan internal services or hang the worker indefinitely. The newer `ssoConfigService.test()` had its own guard, but the login-time discovery did not.
  - **Fix applied** — `routes/sso.js` `discover()` now calls `ssoConfigService.guardSsrf(issuerUrl)` before the fetch and wraps the fetch with a 5 s `AbortController`. `ssoConfigService.guardSsrf` was promoted to an `export`.

- **[MEDIUM] [services/mailer.js:64-72]** — When SMTP is unavailable, the would-be email body (including the one-time invite/reset URL with the raw token in the path) is logged at WARN level via the structured logger. This is the *intended* fallback so an admin can extract the URL — but the token is now in the application log file, where it persists for whatever the log retention is. Document explicitly that "log mode" effectively makes log access equivalent to invite acceptance, and consider rotating the structured logger to a separate file when `transport === 'log'`. Not auto-fixed.

- **[MEDIUM] [routes/auth.js password Joi]** — Password validation requires ≥ 12 chars + at least 1 letter + 1 digit, but does not reject obviously weak patterns (`password1234`, `aaaaaaaa1`, repeated chars, top-1k breach lists). Acceptable for an internal tool, but a future hardening pass should add `zxcvbn` or a small denylist. Not auto-fixed.

- **[MEDIUM] [routes/sso.js OIDC `state` store]** — `stateStore = new Map()` is in-memory (per-process). In a multi-replica deployment two requests can land on different workers and the state lookup will fail. Already noted as `TODO: move to Redis for production` (sso.js:21). Not new in Phase 14, but worth flagging as a known production gap.

- **[LOW] [routes/sso.js `discoveryCache`]** — Same in-memory issue (`TODO: persist w/ TTL in Redis`), lower impact since a cache miss just triggers a fresh fetch. Not auto-fixed.

- **[LOW] [services/ssoConfigService.js DNS rebinding]** — `guardSsrf()` resolves DNS once before the fetch. A pathological attacker can theoretically respond with a public IP on the first lookup and a private IP on the actual TCP connect. The fetch does not pin to the resolved IP. This is a known SSRF gotcha; the practical mitigation is enforcing only HTTPS issuers (which we don't yet) plus an outbound network policy at the deployment layer. Not auto-fixed.

- **[INFO]** — All Phase 14 mutating routes (`PUT /api/org`, `PUT /sso/config`, `POST /sso/config/test`, `PUT /me/preferences`, invite/reset endpoints) wire the existing `audit('action.name', 'Resource')` middleware. Audit log entries appear correctly in the `audit_logs` table (verified via `GET /api/audit` after a sample PUT).

## Re-verification

After the high-severity fix, run:
```bash
cd /home/yavadmin/shellius/backend && \
  NODE_OPTIONS='--experimental-vm-modules' npx jest \
    --testPathPattern='phase14|orgService|ssoConfigService|userPreferencesService'
```
50 tests / 6 suites pass. Live curl smoke against `https://shellius.yavlabs.com` continues to return 400 for private-IP issuer URLs and 200 for `https://accounts.google.com`.
