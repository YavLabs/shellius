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
  (Step 2 now needs a confirmation for password and privileged accounts —
  see "Linking SSO accounts" below.)
  `allowedDomains` (empty = any) gates both sign-in and provisioning.
  `defaultRole` can never be `super_admin`.
- On success the callback redirects to `/auth/callback#code=<one-time code>`
  (Redis, 60s, single use) — tokens never travel in the URL. The SPA calls
  `POST /api/auth/sso/exchange { code }` → login-shaped response (so MFA
  applies to SSO).
- On failure: `/auth/callback#error=<code>` where code ∈ `domain_not_allowed`,
  `email_not_verified`, `account_disabled`, `provisioning_disabled`,
  `identity_conflict`, `state_mismatch`, `sso_not_configured`, `sso_failed`,
  `org_not_allowed` (GitHub `allowedOrgs`, see Revision 2).
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

---

## Revision 2 — multiple SSO providers, GitHub, avatars, prod approval

### Multiple SSO providers (incl. GitHub)

An org can enable several providers at once; each active provider renders its
own button on the login page. `SsoConfig` is no longer one-per-org, and linked
accounts live in `UserIdentity` (one row per provider per user; unique on
`(ssoConfigId, subject)`).

`SsoProviderDTO`:
```json
{ "id", "name", "provider": "oidc|github", "presetId": "google|entra|okta|auth0|generic|github",
  "clientId", "hasClientSecret", "issuerUrl", "callbackUrl" /* to register at the IdP */,
  "scopes", "defaultRole", "defaultGroupId", "autoProvision", "allowedDomains",
  "allowedOrgs" /* github only */, "requireVerifiedEmail", "isActive", "displayOrder",
  "userCount", "source": "db|env" }
```

- `GET /api/auth/sso/providers` (super_admin) → `{ providers }`
- `POST /api/auth/sso/providers` (super_admin) `{ name, presetId, clientId, clientSecret, issuerUrl?, scopes?, defaultRole, defaultGroupId?, autoProvision, allowedDomains, allowedOrgs, requireVerifiedEmail, isActive }` → 201 `{ provider }`
- `PATCH /api/auth/sso/providers/:id` — same fields, all optional; blank `clientSecret` keeps the stored one.
- `DELETE /api/auth/sso/providers/:id` — cascades that provider's `UserIdentity` rows (users keep their accounts). Refused (409 `LAST_SIGN_IN_METHOD`) if any user would be left with no password and no other identity, unless `?force=true`.
- `POST /api/auth/sso/providers/:id/test` and `POST /api/auth/sso/providers/test` (unsaved draft) → `{ ok, message, details }`
- `PUT /api/auth/sso/providers/order` `{ ids: [] }`
- Legacy `GET/PUT /api/auth/sso/config` keep working against the first provider.
- Public: `GET /api/auth/sso/public-status?orgSlug=` and `POST /api/auth/login-options` add `providers: [{ id, name, presetId, provider }]` (active only, ordered). Legacy `ssoEnabled` / `ssoPresetId` remain (first provider).
- Start: `GET /api/auth/sso/:orgSlug?provider=<id>` (default: first active).
  Callback: `GET /api/auth/sso/callback/:providerId` (new; `callbackUrl` in the
  DTO). Legacy callback paths keep working for existing registrations.
- **GitHub** (OAuth 2.0, not OIDC): authorize `…/login/oauth/authorize`, token
  `…/login/oauth/access_token`, with state + PKCE (S256); identity from
  `GET /user`, email from `GET /user/emails` (**primary + verified only**);
  subject = GitHub numeric user id; `allowedOrgs` enforced via
  `GET /user/memberships/orgs/{org}` (state `active`, needs `read:org`).
  GitHub Enterprise Server: `issuerUrl` = `https://ghe.example.com` (API at
  `/api/v3`); default `https://github.com`. Error code `org_not_allowed`.
- Reconcile order: `UserIdentity(ssoConfigId, subject)` → verified-email link
  (same rules as before) → JIT provision. Creates/updates the `UserIdentity`
  row and `lastLoginAt`.
- Env Google preset (`SSO_GOOGLE_*`) appears as a virtual provider
  `{ id: 'env-google', source: 'env' }` when no DB provider has `presetId: google`.
  Implementation note: it is materialised into a real `SsoConfig` row lazily,
  at the start of the **first login** that uses it (`resolveProviderForStart`),
  not at the callback. That row's real id is what gets stored in the login's
  Redis `state` and becomes its `callbackUrl` for that attempt, so the
  callback never needs to special-case the literal `env-google` id. Once
  materialised, `listProviders`/`public-status` stop returning the virtual
  entry (a real, editable DB row exists instead).
- `GET /api/auth/me` adds `identities: [{ id, providerId, providerName, presetId, email, lastLoginAt }]`;
  `DELETE /api/auth/identities/:id` unlinks (409 `LAST_SIGN_IN_METHOD` if it
  would leave the user without any way to sign in).

### Avatars

- `PUT /api/users/me/avatar` `{ dataUrl }` — `data:image/(png|jpeg|webp);base64,…`,
  ≤ 150 KB decoded (the UI resizes to 128×128 WebP first). `DELETE /api/users/me/avatar`.
- SSO logins set `avatarUrl` from the IdP picture (`picture` / GitHub
  `avatar_url`) **unless** the user uploaded a custom avatar (a `data:` URL).
- Every API that embeds a user (users, audit log actor, access request
  requester/reviewer/approvers, sessions, group members, certificates,
  keystore createdBy/deployedBy, notifications actor) returns
  `{ id, name, email, avatarUrl }` so the UI can render one consistent user cell.

### Production approval

`server.environment === 'prod'` requires approval **unless the requester's role
holds `access.prod_bypass`** (Admin and Super admin by default; edited under
Administration → Roles) **and** the org switch `Organization.settings.access.prodBypassEnabled`
is on. With the switch off nobody skips approval — not even super admins — and
break-glass can't reach prod either. Policy `autoApprove` is **ignored on prod**.
A bypass still creates an `APPROVED` AccessRequest (reason required), is audited
as `access_request.prod_bypass`, and notifies the server's approvers after the
fact (or, with no approver routing, everyone who can revoke access).

- `GET /api/org/access-settings` (`org.access_settings`) →
  `{ prodBypassEnabled, rolesWithBypass: [{id,key,name,isSystem}], prodApprovalBypassMinRole }`
  (`prodApprovalBypassMinRole` is a derived legacy summary).
- `PUT /api/org/access-settings` (`org.access_settings`) `{ prodBypassEnabled }`.
  The legacy `{ prodApprovalBypassMinRole: 'admin'|'super_admin'|'none' }` is
  still accepted: it sets the switch and grants/removes the built-in Admin
  role's `access.prod_bypass`.
- Upgrades: the old setting is migrated onto the built-in roles when they are
  first created (`roleService.syncSystemRoles`).

### Search totals

`GET /api/search` `counts` are **total** matches per type (not the truncated
page), so the UI can show "12 more…".

---

## Linking SSO accounts

An SSO identity (`UserIdentity`, unique on `(ssoConfigId, subject)`) can be
attached to an existing Shellius account in four ways. Every link is audited as
`auth.identity.linked` with `metadata.method` = `auto` | `confirmed` |
`email_approved` | `connect`, and the account is emailed (`identityLinked`
template: "A <Provider> account was linked to your Shellius account. If this
wasn't you, contact your administrator.").

### Sign-in that matches by email

`reconcileSsoUser` (services/ssoService.js):

1. `UserIdentity(ssoConfigId, subject)` match → signed in. No confirmation —
   the identity was linked before.
2. Email match in the org (email verified by the IdP, or the provider has
   `requireVerifiedEmail: false`; same-provider different-subject →
   `identity_conflict`; disabled account → `account_disabled`):

   | Matched account | What happens |
   |---|---|
   | Has a password (any role, including super admins) | **Confirm with password.** A pending link is stored in Redis (`sso:link:<sha256(token)>`, 10 min, single use) and the browser goes to `/sso/link#token=…`. |
   | No password, **privileged** | **Approve by email.** A one-time link (`/sso/link/approve?token=…`, 30 min, single use) is emailed to the account; the browser goes to `/sso/link#status=approval_sent`. |
   | No password, not privileged | Linked on the spot (`method: auto`), as before. |

   *Privileged* = the role holds any permission in `PRIVILEGED_PERMISSIONS`
   (config/permissions.js): every non-view permission in the Users, Roles and
   Settings groups, plus `access.prod_bypass`. Derived from the catalogue —
   never from role names.
3. No match → JIT-provision (`autoProvision`), unchanged.

Every pending link is audited as `auth.identity.link_pending`; cancels, burned
tokens and connect failures as `auth.identity.link_failed`.

### Confirm with password — `/sso/link`

- `POST /api/auth/sso/link/info { token }` → `{ providerName, presetId,
  identityEmail, accountEmail (masked), mfaRequired, methods }`.
- `POST /api/auth/sso/confirm-link { token, password }`:
  - wrong password → 401 `INVALID_CREDENTIALS` ("Incorrect password"); counts
    toward the account's lockout exactly like password login (and locked
    accounts get 423 `ACCOUNT_LOCKED`); max 5 attempts per token, then it is
    burned (429 `LINK_TOO_MANY_ATTEMPTS`); `authLimiter` per IP.
  - MFA enrolled → `{ linkMfaRequired: true, methods, emailHint }`; the page
    then sends `{ token, method, code }` (email codes via
    `POST /api/auth/sso/confirm-link/send-code { token }`).
  - otherwise (or after the code) → the identity is linked and a normal
    session is returned (`{ accessToken, refreshToken, user }`). MFA was
    verified in this flow, so the user is **not** asked again by `mfaGate`.
- Expired / unknown / reused token → 400 `LINK_EXPIRED`.
- `POST /api/auth/sso/link/cancel { token }` — "Cancel" burns the token and
  returns to `/login`.
- In an org that requires SSO, a password can still be used here: it only
  proves ownership, it doesn't sign in by password.

### Approve by email — `/sso/link/approve`

- `POST /api/auth/sso/link/approve-info { token }` shows what is being linked;
  `POST /api/auth/sso/link/approve { token }` links it. Approving does **not**
  sign anyone in — the person then signs in with the provider. Both use
  `tokenActionLimiter`.
- At most 5 approval emails per account per hour. If the email can't be sent
  (no SMTP, or the server refused it) the token is burned and the browser goes
  to `/sso/link#status=approval_failed`; an administrator can fix email, or
  send a password reset so the user can confirm with a password instead.

### Connect from Profile

- `GET /api/auth/sso/connect/providers` — active providers of the caller's org.
- `POST /api/auth/sso/connect/start { providerId }` (authenticated,
  self-service, 10/min per user) → `{ url }`. The Redis state carries
  `mode: 'connect'` and the signed-in `userId`; audited
  `auth.identity.connect_started`.
- The callback links `(provider, subject)` to **that user only** — never by
  email. `allowedDomains` / GitHub `allowedOrgs` still apply. Redirects to
  `/profile?connected=<provider name>` or `/profile?connect_error=<code>`:
  `identity_in_use` (the IdP account belongs to another Shellius user),
  `already_connected`, `domain_not_allowed`, `org_not_allowed`,
  `email_not_verified`, `state_mismatch`, `sso_not_configured`, `sso_failed`.

### Unlink

- Self: `DELETE /api/auth/identities/:id`. Admin:
  `GET /api/users/:id/identities` → `{ hasPassword, passwordUsable, identities }`
  and `DELETE /api/users/:id/identities/:identityId`, both `users.manage_identities`
  (Admin and Super admin by default) plus the same no-escalation rule as
  managing the user (`roleService.canActOnRole`).
- Refused with 409 `LAST_SIGN_IN_METHOD` when it would leave no way to sign
  in. A password only counts when the user may use it (see "Require single
  sign-on").
- Audited as `auth.identity.unlinked` (`method: self | admin`); the user is
  emailed (`identityUnlinked`).

### Set a password

Accounts without a password (SSO-only) can add one from Profile:

- `POST /api/auth/password/set/send-code` — emails a one-time code (fails with
  503 `EMAIL_NOT_DELIVERED` when it can't be sent).
- `POST /api/auth/password/set { newPassword, method, code }` — same strength
  rules as registration/reset. Proof: a code from an enrolled MFA factor
  (`totp` / `email` / `backup`); with no MFA enrolled, the emailed code
  (`method: 'email'`). 409 `PASSWORD_ALREADY_SET` if one exists; 403
  `SSO_REQUIRED` when the org requires SSO. Audited `auth.password.set`; the
  user gets the "password added" email. Rate-limited per user.

### Require single sign-on

`Organization.settings.access.ssoRequired` (JSON, no migration) — on
`GET/PUT /api/org/access-settings` (`org.access_settings`) as `ssoRequired`,
with `rolesExemptFromSso` and `ssoProvidersActive` in the GET. It can only be
turned on while at least one provider is active (409 `SSO_NOT_CONFIGURED`).

When on, for every user whose role does **not** hold `settings.sso`:

- password login → 403 `SSO_REQUIRED` (the password isn't even checked;
  audited `auth.sso_required_blocked`);
- password reset links (self-service: silently not sent; token reset and the
  admin "Send password reset": 403 `SSO_REQUIRED`), invite acceptance with a
  password, and set-password are refused;
- `POST /api/auth/login-options` returns `ssoRequired: true` and
  `hasPassword: false`, so the login page shows only the SSO buttons ("Your
  organization signs in with single sign-on").

Holders of `settings.sso` (Super admin by default) keep password sign-in, so a
broken identity provider can't lock the organization out.

### Provider setting: require verified email

With `requireVerifiedEmail` off, an email match links even when the IdP doesn't
assert the address is verified. The provider form shows a warning. Password and
privileged accounts are still protected by the confirmation steps above;
password-less, non-privileged accounts are linked on email match alone.
