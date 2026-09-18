# Authentication — contract & hardening notes

This documents the auth API contract between backend and frontend after the
OIDC/MFA/session hardening pass (parity with, and in places beyond, ledgrr).

## Tokens

- Access token (JWT, 15m, `JWT_SECRET`): `{ typ: 'access', userId, orgId, role, email, fid, iat }`.
  `fid` = refresh-token family id (one per sign-in / device).
  `verifyAccessToken` rejects any token without `typ === 'access'` — MFA
  challenge, bootstrap and gateway tokens can never be used as bearer tokens.
- MFA challenge token: `{ typ: 'mfa_challenge', userId, orgId, jti }`, 5 min,
  signed with a key derived from `JWT_SECRET` (HKDF, distinct purpose). Max 5
  verification attempts per challenge (Redis), then it is burned.
- Refresh token (JWT, `JWT_REFRESH_SECRET`), stored hashed. Single-use; each
  rotation stays in the same **family**. Reuse of a rotated token outside a
  10s grace window revokes the whole family (audit `auth.refresh_reuse`).
  Families have an absolute lifetime (`SESSION_ABSOLUTE_TTL`, default 30d).
- `authenticate` loads the user on every request: non-`active` users, and
  tokens with `iat` < `user.sessionsValidFrom`, get **401 `SESSION_REVOKED`**.
  The role from the DB is authoritative (demotions apply immediately).
- In production the server refuses to start with default JWT secrets.

## Error codes (`error.code` in the envelope)

| HTTP | code | meaning / `error.details` |
| --- | --- | --- |
| 401 | `INVALID_CREDENTIALS` | generic bad email/password (no enumeration) |
| 423 | `ACCOUNT_LOCKED` | `{ retryAfterSeconds }` — 5 failures → 15 min lock (env `AUTH_LOCKOUT_THRESHOLD`, `AUTH_LOCKOUT_MINUTES`) |
| 403 | `ACCOUNT_DISABLED` | suspended / deactivated / deleted |
| 401 | `MFA_INVALID` | `{ attemptsRemaining }` |
| 429 | `MFA_TOO_MANY_ATTEMPTS` | challenge burned — restart sign-in |
| 401 | `MFA_CHALLENGE_EXPIRED` | restart sign-in |
| 401 | `SESSION_REVOKED` | clear tokens, go to `/login?reason=session_revoked` |
| 403 | `MFA_SETUP_REQUIRED` | org enforces MFA and user not enrolled — go to `/mfa-setup` |

## Login-shaped response

Returned by `POST /api/auth/login`, `POST /api/auth/mfa/verify`,
`POST /api/auth/sso/exchange`, `POST /api/auth/password-reset/:token/reset`,
`POST /api/auth/invite/:token/accept`:

```json
{ "accessToken", "refreshToken", "user" }
// or, when a second factor is required:
{ "mfaRequired": true, "mfaToken", "methods": ["totp","email","backup"], "emailHint": "j***@acme.com" }
```

MFA is required whenever the **user** has a factor enrolled (regardless of the
org's `enabled` flag) — for password, SSO, password-reset and invite logins.

## Enforced MFA

If the org's `MfaConfig.enforced` is true and the user has no factor, sign-in
succeeds but `/api/auth/me` returns `user.mfaSetupRequired: true` and every
other API returns 403 `MFA_SETUP_REQUIRED`, except: `GET /api/auth/me`,
`POST /api/auth/logout`, `POST /api/auth/refresh`, `GET /api/auth/sessions`,
everything under `/api/mfa/*`, and `GET /api/settings/mfa/public` (if present).

## Endpoints (new / changed)

- `POST /api/auth/login` — email lowercased; constant-time on unknown email;
  lockout; audit `auth.login`, `auth.login_failed`, `auth.account_locked`.
- `POST /api/auth/logout` — revokes the caller's refresh family.
- `GET /api/auth/sessions` → `{ sessions: [{ id /*familyId*/, clientType, userAgent, ipAddress, createdAt, lastUsedAt, expiresAt, current }] }`
- `DELETE /api/auth/sessions/:id` — revoke one family (own only).
- `POST /api/auth/sessions/revoke-others` → `{ revoked }`.
- `GET /api/auth/me` — `user` adds `mfaSetupRequired`, `mfa: { totpEnabled, emailEnabled, backupCodesRemaining }`, `hasPassword`, `ssoProvider`.
- `PUT /api/users/me/password` `{ currentPassword, newPassword }` → `{ accessToken, refreshToken }`; all other sessions revoked.
- `POST /api/mfa/totp/begin` — stores a *pending* secret (existing TOTP keeps working until confirm).
- `POST /api/mfa/email/send-code` — authenticated, no body. Emails the current
  user a one-time code usable as `{ method: 'email', code }` for
  `/api/mfa/disable` and `/api/mfa/backup-codes/regenerate`. Only sends when
  the user has email MFA enrolled (400 otherwise); rate-limited to 1 per 30s
  and 5 per 15 min per user (429 `MFA_TOO_MANY_ATTEMPTS` beyond that).
- `POST /api/mfa/disable` `{ method: 'totp'|'email'|'backup', code }` or `{ password }` — required.
- `POST /api/mfa/backup-codes/regenerate` `{ method, code }` — required when a factor is enrolled.
- `POST /api/users/:id/unlock` (admin) — clears lockout.
- `POST /api/users/:id/revoke-sessions` (admin) — revokes all refresh families and bumps `sessionsValidFrom`.
- User DTOs (list/get) add `lockedUntil`, `failedLoginCount`, `mfaEnabled`.
- Role change / suspend / deactivate / delete / password reset revoke sessions.

## SSO (OIDC)

- `GET /api/auth/sso/:orgSlug` — generates `state`, `nonce` and a PKCE
  `code_verifier` (S256), stores them in Redis (10 min, single use) and binds
  the state to the browser with an HttpOnly `shellius_sso_state` cookie.
- Callback validates state + cookie, exchanges the code with the verifier,
  **verifies the ID token** (JWKS signature, `iss`, `aud`, `exp`, `nonce`) via
  `jose`, then reconciles the user:
  1. match on `(orgId, ssoProvider, ssoSub)`;
  2. else match on email only when `email_verified` is asserted (if the config
     has `requireVerifiedEmail`) and the account has no different `ssoSub`;
  3. else JIT-provision if `autoProvision`.
  `allowedDomains` (empty = any) gates both sign-in and provisioning.
  `defaultRole` can never be `super_admin`.
- On success the callback redirects to `/auth/callback#code=<one-time code>`
  (Redis, 60s, single use) — tokens never travel in the URL. The SPA calls
  `POST /api/auth/sso/exchange { code }` → login-shaped response (so MFA
  applies to SSO).
- On failure: `/auth/callback#error=<code>` where code ∈ `domain_not_allowed`,
  `email_not_verified`, `account_disabled`, `provisioning_disabled`,
  `identity_conflict`, `state_mismatch`, `sso_not_configured`, `sso_failed`.
- SSO config (`GET/PUT /api/auth/sso/config`) adds `allowedDomains: string[]`
  and `requireVerifiedEmail: boolean`. Env preset: `SSO_ALLOWED_DOMAINS`
  (comma-separated) — surfaced to the admin UI at
  `GET /api/auth/sso/config` → `data.effective.envDefaults.allowedDomains`
  (string array; empty when unset). Discovery-document endpoints (token /
  userinfo / jwks) are subject to the same private-address guard as the
  issuer.

## Known follow-ups (not in this pass)

- Move the refresh token from `localStorage` to an HttpOnly cookie + CSRF
  (requires TUI/CLI token handling changes).
- WebAuthn / passkeys; remember-this-device; SAML.
