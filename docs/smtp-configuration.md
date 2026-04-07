# SMTP Configuration

Shellius can resolve SMTP credentials from two sources, in this
precedence order:

1. **UI override** — per-org row in the `smtp_configs` table, set via
   Settings → Notifications → SMTP. Fields the row has filled in win
   over the env defaults.
2. **Environment defaults** — `SMTP_*` env vars set in `.env.prod` (or
   the deployment's environment). Used as fallbacks for any field the
   UI override leaves blank.

If neither source is configured, Shellius runs in **log-only mode**:
emails are not sent, but the structured logger captures the would-be
body so an admin can copy out the URL (useful for invite/reset flows
in dev).

## Environment variables

```bash
SMTP_HOST=smtp.sendgrid.net          # required to enable email
SMTP_PORT=587                        # default 587
SMTP_USER=apikey
SMTP_PASS=SG.xxxxxxxxxxxxxxxxxxx
SMTP_FROM=noreply@shellius.example.com
SMTP_SECURE=true                     # set to 'false' to disable STARTTLS
```

These are picked up automatically on container boot. **No restart is
needed when you change the UI override** — `mailer.js` resolves the
config fresh on every send via `smtpConfigService.getEffective()`.

## Per-org override (UI)

1. Go to Settings → Notifications → SMTP
2. Fill in host, port, username, password, from address
3. Click **Test** — Shellius sends a test email to your own account
4. Click **Save** — the row is encrypted at rest using the existing
   `crypto.encrypt()` helper (AES-256-GCM with `SERVER_ENCRYPTION_KEY`)

The UI never displays the stored password. The Save form shows
"Stored — leave blank to keep" when a password is already set;
submitting with an empty password preserves the existing one.

To revert to env defaults, click **Delete configuration** in the SMTP
card — the DB row is removed and the next email will fall back to the
env vars.

## Field-level provenance

`GET /api/settings/smtp` returns a `source` map showing where each
field's value came from:

```json
{
  "config": {
    "host": "smtp.example.com",
    "port": 587,
    "username": "apikey",
    "fromAddress": "noreply@example.com",
    "useTls": true,
    "configured": true,
    "hasPassword": true,
    "source": {
      "host": "db",
      "port": "db",
      "username": "db",
      "password": "db",
      "fromAddress": "db"
    }
  }
}
```

Possible source values:
- `"db"` — set via UI override
- `"env"` — picked up from an env var
- `"default"` — built-in default (e.g. port 587 when neither source set it)
- `null` — not set anywhere

The Settings → Notifications → SMTP UI uses this map to display
"Environment default" badges next to fields that fall back to an env
var, and "Overridden" indicators on fields the UI has explicitly set.

## Test endpoint

`POST /api/settings/smtp/test` (admin-only) sends a test email to
**the caller's own email address only** — no arbitrary recipient is
accepted. This is a defense-in-depth measure: a compromised admin
account can't be used to send arbitrary mail through your relay.

## Security

- Password encrypted at rest with the existing `SERVER_ENCRYPTION_KEY`
  (AES-256-GCM).
- Plaintext password never returned to the frontend — only `hasPassword: bool`.
- Test endpoint rate-limited via the existing audit middleware.
- Every mutation (`PUT`, `DELETE`, `POST /test`) writes an immutable
  audit log entry.
