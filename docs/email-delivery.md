# Email delivery

Shellius sends email for invitations, password resets, access-request
approvals, certificate expiry warnings, account deletion and email sign-in
codes. Admins with the **Email delivery** permission (`settings.smtp`) choose
how it is sent under **Settings → Email**.

## How Shellius picks a sender

For every email, fresh on each send (no restart needed):

1. **The org's active email provider** (Settings → Email). An org can define
   several providers; exactly one — or none — is active.
2. **`SMTP_*` environment variables**, when no provider is active. This is
   the behaviour of earlier releases and is reported as transport `env-smtp`.
3. **Log-only mode** when neither exists: nothing is sent, and the backend
   log records the subject and the start of the text body (so an admin can
   copy an invite or reset link). The Users page shows such links directly.

If the active provider fails, Shellius does **not** silently fall back to the
environment settings: the send fails, the caller sees `delivered: false`
(email sign-in codes show an error, invites show the link to copy), and the
backend log records the provider's name, type and its own error message.

The Email tab says which of these applies when no provider is active
("Emails use the server's SMTP_* settings" or "Emails are not being sent").

## Managing providers

- **Add provider** → pick a type → fill in its settings. Secret fields (API
  keys, client secrets, passwords, the service-account key, the Google refresh
  token) are write-only: they are encrypted at rest (AES-256-GCM with
  `SERVER_ENCRYPTION_KEY`) and never returned by the API — the UI shows
  "Stored" instead. Leave a secret blank when editing to keep it.
- **Make active** switches all outgoing email to that provider (the previous
  one is deactivated in the same transaction). **Deactivate** or **Delete** on
  the active provider leaves none active, so the environment fallback applies.
- **Send test email** sends a real message (to your own address by default,
  or any address you type) through that provider — active or not — and shows
  the provider's error text if it fails. The result is stored as "Test
  passed / failed" on the card. Test sends are limited to 10 per minute per
  user.
- The **From address** is required for SendGrid, Mailgun, Postmark and Resend.
  Google uses the connected account (or delegated mailbox) and Microsoft 365
  the sender mailbox when it's left blank; SMTP uses the username if it is an
  email address.

Every change is audited (`email_provider.create`, `.update`, `.delete`,
`.activate`, `.deactivate`, `.test`, `.google_connect`). Audit entries record
names, types and which fields changed — never secret values.

## Providers

All providers except SMTP talk to fixed, provider-owned HTTPS endpoints (no
user-supplied URLs), never follow redirects, and time out after 15 seconds.

### SMTP

Any SMTP server or relay (Postfix, Exchange, Amazon SES SMTP, Mailgun/SendGrid
SMTP relays…).

| Field | Notes |
|---|---|
| Host | Bare hostname or IP (no `smtp://`, no port). Internal relays are allowed. |
| Port | 587 (STARTTLS) or 465 (TLS) usually; 25 for internal relays. |
| Security | **STARTTLS** — plain connect, TLS upgrade required. **TLS** — implicit TLS from the first byte (port 465). **None** — TLS not required; Shellius still upgrades with STARTTLS if the server offers it. |
| Username / Password | Optional; sent only when both are set. |

In earlier releases the TLS switch only took effect on port 465 (STARTTLS was merely
opportunistic elsewhere). The explicit **Security** setting replaces it.

### Google (Gmail API)

Sends with `users.messages.send` as a Gmail or Google Workspace mailbox. Two
authentication modes:

**Connect a Google account (OAuth)**

1. In Google Cloud Console, enable the **Gmail API** for a project.
2. Create an **OAuth client ID** of type *Web application*. Add the
   **Authorized redirect URI** shown in the Add-provider dialog:
   `https://<your Shellius host>/api/settings/email/google/callback`.
   (If the OAuth consent screen is "Testing", add the sending account as a
   test user, or publish it.)
3. In Shellius, add a **Google** provider with that client ID and secret. If
   the server already has `SSO_GOOGLE_CLIENT_ID` / `SSO_GOOGLE_CLIENT_SECRET`
   set (for Google SSO) you can leave both blank to reuse them — add the
   redirect URI above to that client.
4. Click **Connect Google account** and sign in as the mailbox that should send
   email. Shellius asks only for `https://www.googleapis.com/auth/gmail.send`
   (plus `openid email` to show which account is connected), with offline
   access. The refresh token is stored encrypted; the card then shows
   "Connected as …". Use **Reconnect** to switch accounts.
5. Send a test email, then **Make active**.

The connect link is valid for 10 minutes and can be used once; it is bound to
the org, the provider and the admin who started it, and that admin must still
hold Email delivery when Google redirects back.

**Workspace service account (domain-wide delegation)**

1. Create a service account and a JSON key in Google Cloud.
2. In the Workspace Admin console → Security → API controls → Domain-wide
   delegation, add the service account's client ID with the scope
   `https://www.googleapis.com/auth/gmail.send`.
3. Add a **Google** provider, choose *Workspace service account*, paste the
   JSON key and enter the mailbox to send as.

Shellius signs an RS256 JWT for that mailbox and exchanges it at Google's
fixed token endpoint (the key file's own `token_uri` is ignored).

### Microsoft 365 (Graph)

Sends with `POST /users/{sender}/sendMail` using app-only (client credentials)
authentication.

1. In **Microsoft Entra ID → App registrations**, register an application.
2. **API permissions** → Add → Microsoft Graph → **Application permissions** →
   **Mail.Send**, then **Grant admin consent**.
3. **Certificates & secrets** → New client secret. Note its value (not its ID).
4. Strongly recommended: restrict the app to the sending mailbox with an
   Exchange Online **application access policy** (or RBAC for Applications) —
   otherwise Mail.Send lets the app send as any mailbox in the tenant.
5. In Shellius add a **Microsoft 365** provider with the Directory (tenant) ID
   (or `contoso.onmicrosoft.com`), Application (client) ID, client secret and
   the sender mailbox's UPN.

Access tokens are cached until shortly before they expire.

### SendGrid

Create an API key with **Mail Send** permission. The from address must be a
verified single sender or on an authenticated domain. Choose the **EU**
region for accounts with EU data residency (they use
`api.eu.sendgrid.com`).

### Mailgun

Use a sending API key and the sending domain (e.g. `mg.example.com`); the from
address must be on that domain. Choose **EU** for domains hosted in the EU
region (`api.eu.mailgun.net`).

### Postmark

Use the **Server API token** (Server → API Tokens) and, if you don't use the
default, the message stream ID (default `outbound`). The from address must be
a confirmed sender signature or on a verified domain.

### Resend

Create an API key with sending access. The from address must be on a verified
domain.

## Environment fallback (`SMTP_*`)

| Variable | Default | Notes |
|---|---|---|
| `SMTP_HOST` | — | Enables the fallback. |
| `SMTP_PORT` | `587` | |
| `SMTP_USER` / `SMTP_PASS` | — | `SMTP_PASS` is a secret. |
| `SMTP_FROM` | `SMTP_USER` if it is an address | |
| `SMTP_FROM_NAME` | — | Optional display name. |
| `SMTP_SECURITY` | derived | `none`, `starttls` or `tls`. When unset: TLS on port 465 (unless `SMTP_SECURE=false`), otherwise STARTTLS if the server offers it — the same as earlier releases. |
| `SMTP_SECURE` | `true` | Legacy; only consulted when `SMTP_SECURITY` is unset. |

The API only reveals whether `SMTP_HOST` is set, never the values.

## Upgrading from 1.4.x (SMTP settings in the UI)

The `20260921000000_email_providers` migration creates `email_providers` and
copies each org's Settings → Notifications → SMTP row (`smtp_configs`) into an
**SMTP** provider named "SMTP", active if the old row was active.

SQL can't produce the encrypted settings blob (the SMTP password is encrypted
with the server key), so the copied row starts with its settings empty and a
pointer to its source row (`legacy_smtp_config_id`). On boot — and on first
use, should boot-time import fail — the backend decrypts the old password and
writes the provider's encrypted settings. This step is idempotent and only
touches rows whose settings are still empty. The old row's `use_tls` maps to
**Security**: on → TLS for port 465, STARTTLS otherwise; off → None. If your
server doesn't actually support STARTTLS on 587, switch Security to None.

`smtp_configs` is not modified or dropped, so rolling back to 1.4.x keeps its
settings. Changes made after the upgrade are not written back to it.

The old `GET/PUT/DELETE /api/settings/smtp` and `POST /api/settings/smtp/test`
endpoints still work (deprecated): they read and write the org's active SMTP
provider.

## API

All routes need `settings.smtp`, except the OAuth callback.

| Method | Path | |
|---|---|---|
| GET | `/api/settings/email/providers` | List. `meta`: `activeProviderId`, `envSmtpConfigured`, `googleEnvClientConfigured`, `googleRedirectUri`, `types`. |
| POST | `/api/settings/email/providers` | `{ name, type, fromAddress?, fromName?, config, isActive? }` |
| GET | `/api/settings/email/providers/:id` | |
| PUT | `/api/settings/email/providers/:id` | Any of `name`, `fromAddress`, `fromName`, `config`. Omitted/blank secrets are kept; `null` clears. Type can't change. |
| DELETE | `/api/settings/email/providers/:id` | → `{ deleted, wasActive }` |
| POST | `/api/settings/email/providers/:id/activate` | Deactivates the others. |
| POST | `/api/settings/email/providers/:id/deactivate` | |
| POST | `/api/settings/email/providers/:id/test` | `{ to? }` (defaults to the caller). → `{ ok, sentTo, error, provider }`; a failed delivery is `ok: false`, not an HTTP error. |
| POST | `/api/settings/email/providers/:id/google/connect` | → `{ authUrl, redirectUri }` |
| GET | `/api/settings/email/google/callback` | Google redirect target. Redirects to `/settings?tab=email&connected=1` or `&error=<code>`. |

Secrets appear in responses only as `{ "set": true|false }`.

## Code map

- `backend/src/services/mailer.js` — `sendMail({ orgId, to, subject, html, text })` → `{ delivered, transport, error? }`
- `backend/src/services/emailProviderService.js` — CRUD, activation, tests, Google connect, legacy import
- `backend/src/services/email/providers/*.js` — one adapter per type (`validateConfig`, `send`)
- `backend/src/services/email/envSmtp.js` — the `SMTP_*` fallback
- `backend/src/routes/emailProviders.js` — the API
- `frontend/src/components/settings/email/` — the Email tab
- `backend/src/email/` — templates and the branded layout (see `docs/email-templates.md`)
