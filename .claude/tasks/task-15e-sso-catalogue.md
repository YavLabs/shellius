# Task 15E: SSO Provider Catalogue + Wizard

**Agent:** planner → frontend → backend
**Status:** [x] Done
**Blocks:** 15Q-E, 15R-E
**Blocked By:** None
**Model:** sonnet (default)

## Objective
Settings → SSO today is a free-form OIDC issuer URL field. Vaulthive
ships preset cards for Google Workspace, Microsoft Entra ID (Azure AD),
Okta, Auth0, generic OIDC, and SAML 2.0, each with copy-paste
instructions. Match that.

## Step 1 — Planner: write the catalogue spec

`frontend/src/config/ssoProviders.js`:
```js
export const SSO_PROVIDERS = [
  {
    id: 'google',
    label: 'Google Workspace',
    protocol: 'oidc',
    icon: 'google',          // resolved to a component in the wizard
    issuerUrl: 'https://accounts.google.com',
    requiredScopes: 'openid email profile',
    defaultScopes: 'openid email profile',
    setupSteps: [
      { title: 'Open Google Cloud Console', body: '...' },
      { title: 'Create OAuth client (Web app)', body: '...' },
      { title: 'Add the redirect URI shown above', body: '...' },
      { title: 'Copy the Client ID + Client Secret here', body: '...' },
    ],
    fields: ['clientId', 'clientSecret'],   // issuerUrl is hardcoded for this preset
  },
  {
    id: 'entra',
    label: 'Microsoft Entra ID (Azure AD)',
    protocol: 'oidc',
    icon: 'microsoft',
    issuerUrl: 'https://login.microsoftonline.com/{tenantId}/v2.0',
    requiredScopes: 'openid email profile',
    defaultScopes: 'openid email profile User.Read',
    setupSteps: [
      { title: 'Open Microsoft Entra ID > App registrations', body: '...' },
      { title: 'New registration', body: '...' },
      { title: 'Add Web platform with the redirect URI', body: '...' },
      { title: 'Add a client secret', body: '...' },
      { title: 'Copy Application (client) ID + Directory (tenant) ID', body: '...' },
    ],
    fields: ['tenantId', 'clientId', 'clientSecret'],
    deriveIssuerUrl: ({ tenantId }) => `https://login.microsoftonline.com/${tenantId}/v2.0`,
  },
  {
    id: 'okta',
    label: 'Okta',
    protocol: 'oidc',
    icon: 'okta',
    issuerUrl: 'https://{your-domain}.okta.com/oauth2/default',
    requiredScopes: 'openid email profile',
    defaultScopes: 'openid email profile groups',
    setupSteps: [...],
    fields: ['oktaDomain', 'clientId', 'clientSecret'],
    deriveIssuerUrl: ({ oktaDomain }) => `https://${oktaDomain}/oauth2/default`,
  },
  {
    id: 'auth0',
    label: 'Auth0',
    protocol: 'oidc',
    icon: 'auth0',
    issuerUrl: 'https://{your-tenant}.auth0.com',
    requiredScopes: 'openid email profile',
    defaultScopes: 'openid email profile',
    setupSteps: [...],
    fields: ['auth0Domain', 'clientId', 'clientSecret'],
    deriveIssuerUrl: ({ auth0Domain }) => `https://${auth0Domain}`,
  },
  {
    id: 'generic-oidc',
    label: 'Generic OIDC',
    protocol: 'oidc',
    icon: 'oidc',
    issuerUrl: '',
    requiredScopes: 'openid email profile',
    defaultScopes: 'openid email profile',
    setupSteps: [...],
    fields: ['issuerUrl', 'clientId', 'clientSecret', 'scopes'],
  },
  {
    id: 'saml',
    label: 'SAML 2.0',
    protocol: 'saml',
    icon: 'saml',
    setupSteps: [...],
    fields: ['metadataUrl'],   // SAML wiring is in a future task — render
                                 // an "available in Phase 16" notice for now
    disabled: true,
  },
];
```

## Step 2 — Backend

`backend/src/services/ssoConfigService.js` already accepts arbitrary
`provider`, `issuerUrl`, `clientId`, `clientSecret`. Extend to also
accept and persist `presetId` (string, optional) so the GET response
can re-hydrate the wizard.

Schema migration: add `preset_id TEXT` column to `sso_configs`. Joi
schema gets `presetId: Joi.string().valid(...)` — list pulled from
the catalogue (export from a small JSON shim that backend can read).

## Step 3 — Frontend wizard

Rebuild `frontend/src/pages/Settings.jsx` `SsoTab` as a two-step flow:

1. **Step 1: Pick a provider.** Render a grid of `<Card>`s, one per
   `SSO_PROVIDERS` entry. Card has the provider icon + label + brief
   description. Disabled cards are greyed out.
2. **Step 2: Configure.** Selected provider's `setupSteps` rendered as
   a numbered list on the left. On the right, a form auto-built from
   `fields`. The redirect URI is shown at the top with a Copy button —
   computed as `${TRAEFIK_HOST}/api/auth/sso/callback`.
3. **Test connection** button calls the existing `POST
   /api/auth/sso/config/test` and renders the discovered metadata.
4. **Save** persists via the existing `PUT /api/auth/sso/config`,
   storing `presetId` so the wizard re-hydrates next time.

Use the existing `Button`, `Input`, `Select`, `Card` UI primitives. No
new dependencies. Provider icons can be inline SVG or simple lucide
fallbacks (e.g. `Cloud`, `Building2`) — don't fetch external assets.

## Acceptance
- Selecting Google Workspace → form pre-fills issuer + scopes →
  entering ClientID/Secret → Save → Test → green check.
- Same for Entra, Okta, Auth0 with provider-specific derived issuers.
- Generic OIDC still works (free-form).
- SAML card visible but disabled with "Coming in Phase 16" badge.
- Reloading Settings → SSO restores the previously saved provider in
  the wizard, masked secret intact.
