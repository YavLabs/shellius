# Task 14B: SSO Config Route + Service

**Agent:** backend
**Status:** [x] Done
**Blocks:** 14D, 14M
**Blocked By:** None

## Objective
Persist SSO configuration (OIDC / SAML) per org and expose a connection
test endpoint. The Settings → SSO tab currently shows a Save button that
is hard-disabled and a Test button that hits a 404. There's no DB table
for SSO config either.

## Deliverables

### Schema (db agent collaboration)
- New Prisma model `SsoConfig`:
  - `id`, `orgId` (FK, unique), `provider` ('oidc' | 'saml'), `clientId`,
    `clientSecretEncrypted`, `issuerUrl`, `callbackUrl`, `metadata` (JSONB),
    `isEnabled`, `createdAt`, `updatedAt`
- Migration that adds the table and a unique index on `orgId`

### Routes
- `backend/src/routes/sso.js` — extend the existing file:
  - `GET /api/auth/sso/config` — admin+; returns the row or null
  - `PUT /api/auth/sso/config` — admin+; upserts; encrypts client secret
    via the existing `crypto.encrypt()` helper
  - `POST /api/auth/sso/test` — admin+; performs a discovery probe against
    `issuerUrl/.well-known/openid-configuration` for OIDC, or fetches the
    SAML metadata XML; returns `{ ok: true, providerName, scopesSupported }`
    on success or a structured error otherwise

### Service
- `backend/src/services/ssoConfigService.js`: `get`, `upsert`, `test`

## Security
- The client secret is **never** returned to the frontend in plaintext;
  the GET response includes `clientSecretMasked: '****'` and `hasSecret: true`.
- Encryption uses `SERVER_ENCRYPTION_KEY` (already configured).
- Audit `sso.config.update` and `sso.config.test` events.

## Acceptance
- Save button works after Task 14D, server reload shows the saved values
- Test button reports a clear ✅ or ❌ with the discovered metadata
- DB row is encrypted at rest (verify via psql)
- Settings → SSO no longer shows the "Backend endpoint pending" banner
