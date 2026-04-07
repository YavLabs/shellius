# Task 16B: SSO Env Defaults + "Overridden" Badges

**Agent:** backend + frontend
**Status:** [x] Done
**Blocks:** 16Q-B, 16R-B
**Blocked By:** None
**Model:** sonnet

## Backend
Extend `backend/src/services/ssoConfigService.js`:
- `getEffective(orgId)` helper that returns the DB row merged with
  env vars per preset:
  - google: SSO_GOOGLE_CLIENT_ID, SSO_GOOGLE_CLIENT_SECRET
  - entra: SSO_ENTRA_TENANT_ID, SSO_ENTRA_CLIENT_ID, SSO_ENTRA_CLIENT_SECRET
  - okta: SSO_OKTA_DOMAIN, SSO_OKTA_CLIENT_ID, SSO_OKTA_CLIENT_SECRET
  - auth0: SSO_AUTH0_DOMAIN, SSO_AUTH0_CLIENT_ID, SSO_AUTH0_CLIENT_SECRET
  - generic-oidc: SSO_ISSUER_URL, SSO_CLIENT_ID, SSO_CLIENT_SECRET
- Attach a `source` map per field: `{ clientId: 'db' | 'env' | null }`
  so the UI can render the badge
- Never return plaintext secrets; `hasSecret` boolean stays

## Frontend
Settings.jsx SsoTab — for every field backed by an env default when
no DB override exists, render an "Environment default" badge next to
the field and pre-fill the value (except secrets, which stay masked
but show the badge).

When the user edits the field, the badge becomes "Will override env
default on save".

## Acceptance
- Setting `SSO_GOOGLE_CLIENT_ID` in env → wizard pre-fills it with
  the badge.
- Saving a different value → badge flips to "overridden" and future
  logins use the DB value.
- Clearing the field in UI + saving → falls back to env default on
  next GET.
