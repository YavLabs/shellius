# SSO Configuration

Shellius supports five SSO presets out of the box:

- **Google Workspace** — OAuth 2.0 / OIDC with Google as the IdP
- **Microsoft Entra ID** (Azure Active Directory) — OIDC with `login.microsoftonline.com`
- **Okta** — OIDC with your Okta domain
- **Auth0** — OIDC with your Auth0 tenant
- **Generic OIDC** — any OIDC-compliant IdP that publishes a discovery document

SAML 2.0 is on the roadmap but disabled in the current wizard.

## Precedence (UI override wins)

The same per-org / env-var precedence pattern as SMTP:

1. **UI override** — set via Settings → SSO. Saved values win.
2. **Environment defaults** — `SSO_*` env vars in `.env.prod`. Used to
   pre-fill the wizard the first time an admin opens it. Once saved
   in the UI, the env vars become a fallback only.

The UI shows an "Environment default" badge next to fields backed by
an env var so admins know what's happening before they edit anything.

## Environment variables

```bash
# Google Workspace
SSO_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
SSO_GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx

# Microsoft Entra ID
SSO_ENTRA_TENANT_ID=00000000-0000-0000-0000-000000000000
SSO_ENTRA_CLIENT_ID=00000000-0000-0000-0000-000000000000
SSO_ENTRA_CLIENT_SECRET=...

# Okta
SSO_OKTA_DOMAIN=acme.okta.com
SSO_OKTA_CLIENT_ID=...
SSO_OKTA_CLIENT_SECRET=...

# Auth0
SSO_AUTH0_DOMAIN=acme.auth0.com
SSO_AUTH0_CLIENT_ID=...
SSO_AUTH0_CLIENT_SECRET=...

# Generic OIDC
SSO_ISSUER_URL=https://idp.example.com
SSO_CLIENT_ID=...
SSO_CLIENT_SECRET=...
```

## Per-provider setup

### Google Workspace

1. Open https://console.cloud.google.com/apis/credentials and select
   (or create) a project.
2. **Create credentials → OAuth client ID → Web application**.
3. Add the redirect URI shown in the Shellius wizard
   (`https://<your-shellius-host>/api/auth/sso/callback`) under
   "Authorized redirect URIs".
4. Copy the Client ID and Client Secret into the wizard.
5. (Optional) In OAuth consent screen settings, set User Type to
   **Internal** to restrict logins to your Workspace org.

### Microsoft Entra ID (Azure AD)

1. Go to https://entra.microsoft.com → Identity → Applications → App
   registrations → **New registration**.
2. Name: "Shellius". Supported account types: "Accounts in this
   organizational directory only".
3. Under **Authentication → Add a platform → Web**, paste the
   redirect URI shown in the wizard.
4. Under **Certificates & secrets → New client secret**, copy the
   **Value** (not the Secret ID).
5. From the Overview page, copy the **Application (client) ID** and
   **Directory (tenant) ID**.
6. Paste all three into the Shellius wizard. The issuer URL is derived
   automatically as `https://login.microsoftonline.com/<tenantId>/v2.0`.

### Okta

1. Open your Okta admin console → Applications → Applications →
   **Create App Integration**.
2. Sign-in method: **OIDC - OpenID Connect**. Application type:
   **Web Application**.
3. Set the Sign-in redirect URI to the URL shown in the Shellius
   wizard.
4. Under Assignments, choose who can use this integration.
5. Copy the Client ID, Client Secret, and your Okta domain (e.g.
   `acme.okta.com`) into the wizard.

### Auth0

1. Go to https://manage.auth0.com → Applications → **Create
   Application** → **Regular Web Application**.
2. Paste the redirect URI shown in the wizard into "Allowed Callback
   URLs".
3. Save changes at the bottom of the page.
4. Copy the Domain, Client ID, and Client Secret from the Settings tab.

### Generic OIDC

For any OIDC-compliant IdP:

1. Find the issuer URL — usually it's the prefix of
   `/.well-known/openid-configuration` (paste WITHOUT the
   `/.well-known` suffix).
2. Register Shellius as a confidential web client in your IdP.
3. Add the redirect URI shown in the wizard to the IdP's allowed list.
4. Paste the issuer URL, Client ID, Client Secret, and any custom
   scopes into the wizard. Most providers accept
   `openid email profile`.

## Test connection

After saving (or while typing) you can click **Test** in the wizard.
Shellius performs an OIDC discovery probe against
`<issuerUrl>/.well-known/openid-configuration` with a 5-second
timeout. The result card shows the resolved issuer name, supported
scopes, and the authorization endpoint.

## SSRF guard

The discovery probe is protected by an SSRF guard that rejects:
- Private IPv4 ranges: `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`
- Private IPv6: `::1`, `fc00::/7`
- Bare IP literals (without DNS lookup)

This prevents a tampered or legacy DB row from being used to scan
internal services or hit cloud-metadata endpoints.

## Field validation

`tenantId`, `oktaDomain`, and `auth0Domain` are validated both
client-side (the wizard refuses to enable Save while invalid) and
server-side (Joi pattern in `routes/sso.js`):

- `tenantId` — UUID OR DNS-friendly name (`a-z A-Z 0-9 . -`)
- `oktaDomain`, `auth0Domain` — DNS hostname pattern

Defense in depth: even if the frontend regex is bypassed, the backend
will reject malformed values before they reach `deriveIssuerUrl`.

## Security

- Client secret encrypted at rest with `SERVER_ENCRYPTION_KEY`
  (AES-256-GCM).
- Plaintext secret never returned to the frontend — only `hasSecret: bool`.
- Login-time discovery cache invalidates on save.
- Every mutation (`PUT /api/auth/sso/config`, `POST .../test`) writes
  an immutable audit log entry.
