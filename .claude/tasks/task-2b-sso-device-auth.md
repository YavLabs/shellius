# Task 2B: SSO (OIDC) and Device Authorization Flow

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** none
**Blocked By:** 2A

## Objective
Enable Single Sign-On via OpenID Connect for organizations that require it, and implement the OAuth 2.0 Device Authorization Grant (RFC 8628) so the Go TUI can authenticate users without a browser on the terminal host.

## Deliverables

### Database Models (add to Prisma schema)
- `SsoConfig` — id (uuid), org_id (FK Organization, unique), provider (string: "okta", "azure_ad", "google"), client_id, client_secret_encrypted, issuer_url, redirect_uri, scopes (string), is_active (bool), created_at, updated_at
- `DeviceAuthRequest` — id (uuid), device_code (unique), user_code (unique, 8-char uppercase), client_id, scope, org_id (FK Organization), user_id (FK User, nullable — set on approval), status (enum: "pending", "approved", "denied", "expired"), expires_at, interval (int, default 5), created_at

### SSO Service
- `/backend/src/services/ssoService.js`:
  - `initOidcStrategy(orgId)` — dynamically configure Passport OIDC strategy from SsoConfig for the given org
  - `handleOidcCallback(profile, orgId)` — find-or-create User from OIDC claims (email, name), assign default role (viewer), return user record
  - `getSsoConfig(orgId)` — return SSO config (redacted secrets)
  - `upsertSsoConfig(orgId, configData)` — create or update SSO configuration, encrypt client_secret before storage

### SSO Routes
- `/backend/src/routes/sso.js`:
  - `GET /api/auth/sso/:orgSlug` — redirect to OIDC provider authorize endpoint
  - `GET /api/auth/sso/:orgSlug/callback` — handle OIDC callback, issue JWT tokens, redirect to frontend with tokens

### Device Auth Service
- `/backend/src/services/deviceAuthService.js`:
  - `createDeviceRequest(orgId)` — generate device_code (uuid) + user_code (8-char), store in DeviceAuthRequest, return codes + verification_uri + expires_in + interval
  - `pollDeviceRequest(deviceCode)` — check status: pending returns "authorization_pending", approved returns tokens, denied returns "access_denied", expired returns "expired_token"
  - `approveDeviceRequest(userCode, userId)` — set status to approved, attach user_id, generate tokens

### Device Auth Routes
- `/backend/src/routes/deviceAuth.js`:
  - `POST /api/auth/device/authorize` — body: { org_slug }. Returns: { device_code, user_code, verification_uri, expires_in, interval }
  - `POST /api/auth/device/poll` — body: { device_code }. Returns tokens on approval or appropriate slow_down/pending/expired error
  - `POST /api/auth/device/approve` — Authenticated (browser). body: { user_code }. Approves the request.

### Cleanup
- BullMQ job to expire stale DeviceAuthRequest records older than 15 minutes

## Acceptance Criteria
- SSO login redirects to configured OIDC provider and successfully returns with JWT tokens
- SSO auto-provisions new users from OIDC claims with viewer role on first login
- Device auth flow: TUI calls /device/authorize, displays user_code, polls /device/poll, receives tokens after browser approval
- Polling before approval returns 428 with "authorization_pending" error code
- Polling too fast returns 429 with "slow_down" error code
- Expired device codes return 410 with "expired_token" error code
- User codes are human-readable (uppercase, no ambiguous chars like 0/O, 1/I/L)
- Client secrets are encrypted at rest in SsoConfig (AES-256-GCM)
- Stale device auth requests are cleaned up automatically
