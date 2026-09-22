# API Tokens

Before 2.0 every credential in Shellius belonged to a human. CI, Terraform or
a deployment script had to impersonate a person using a JWT issued to a
browser — which meant a short-lived credential nobody could rotate, an audit
trail that named the wrong actor, and a pipeline that broke when that person
left.

2.0 adds two kinds of long-lived credential:

| | Personal access token | Service account token |
|---|---|---|
| Belongs to | a person | the organization |
| Minted by | that person, for themselves | an administrator |
| Permissions | a subset of the owner's, live | the service account's own role |
| Prefix | `shp_` | `shs_` |
| Survives the owner leaving | no | yes |
| Permission to mint | `tokens.personal` | `service_accounts.manage` |

Use a personal token for your own scripting. Use a service account for
anything another person will depend on — a service account is the answer to
"whose token is this, and what happens when they go?".

## The seam

`middleware/rbac.js` reads exactly one thing: `req.user.permissions`, a `Set`.
That is the entire coupling surface between authentication and authorisation,
so a token-authenticated request that populates the same `req.user` inherits
every route, every permission check and every customer-scope rule with **no
route changes at all**.

Authentication is chosen by sniffing the bearer prefix
(`middleware/auth.js`): a value that looks like an API token goes to
`apiTokenAuth`, anything else to the JWT path, which is unchanged.

A service account is a **real `User` row** with `kind: 'service'`. That was a
deliberate choice over a nullable `actorTokenId` on `AuditLog`: `actorId` is a
foreign key to `User`, so a synthetic id cannot be attributed, and the audit
UI, the actor filter and the CSV export would each have needed a second code
path. Service users have a non-routable `@service.invalid` email, no password
hash, and `authenticate` refuses them outright — a service account can never
hold a browser session.

## Permissions never widen

A token's permissions are computed **per request**, never stored:

```
granted = (token scopes ∩ the user's live role permissions) − NON_DELEGABLE
```

Three consequences worth stating plainly:

- **Demotion is immediate.** Narrow someone's role and every outstanding token
  they hold narrows on its next call. There is nothing to re-mint and no
  snapshot to go stale.
- **An empty scope list means "everything the owner has"**, still intersected
  live. It is a convenience, not an escalation.
- **Non-delegable permissions are stripped unconditionally**, whatever the
  owner holds. These are the ones marked `delegable: false` in
  `backend/src/config/permissions.js` — the permissions that would let a token
  escalate itself or disable the controls that watch it (SSO, MFA, audit
  sinks, audit retention, role editing, CA operations).

Minting is additionally guarded by `roleService.assertCanActOnRole`, so nobody
creates a token more powerful than themselves.

## What a token may not reach

Blocked on prefix, before any database work
(`FORBIDDEN_PREFIXES` in `middleware/apiTokenAuth.js`):

| Path | Why |
|---|---|
| `/api/auth`, `/api/mfa`, `/api/settings/mfa`, `/api/auth/sso` | a token is not a login, and must not weaken the controls that protect accounts |
| `/api/vault` | another person's personal vault, never |
| `/api/terminal` | interactive shells belong to people |
| `/api/tokens`, `/api/service-accounts` | a token must never mint or revoke a credential |

One exception: `GET /api/auth/me`, because machines legitimately need a
whoami.

## Two checks deliberately not applied

Both of these are choices, not omissions:

- **`sessionsValidFrom` is ignored.** "Sign out everywhere" ends interactive
  sessions. Silently killing a CI credential because someone changed their
  password would be a bad surprise at 3am. Revoking tokens is its own explicit
  action, shown next to it in the UI.
- **The org MFA gate is not applied.** A token is minted from an
  MFA-satisfied session and then used by a machine that cannot answer a
  challenge.

What *is* applied: an inactive or suspended principal is refused, and
disabling an account revokes its tokens outright as part of the same cascade
that revokes its certificates.

## Lifecycle

- **Shown once.** Only a SHA-256 hash is stored, `@unique`. A lost token is
  rotated, never recovered.
- **Expiry is required.** Default 90 days, maximum 365
  (`API_TOKEN_MAX_DAYS`). There is no "never expires".
- **Rotation has no grace window.** Rotating issues a new value and
  invalidates the old one immediately; a window would mean two live
  credentials for one row and no way to tell which was used.
- **Revocation keeps the row**, so the audit trail still resolves the token's
  name long after it stopped working.
- **`lastUsedAt` and `lastUsedIp`** are written throttled to 60s — enough to
  answer "is this token still in use?" without a write per request.

## Using one

```bash
curl -H "Authorization: Bearer shs_..." https://shellius.example.com/api/servers
```

Audit entries name the service account as the actor and carry
`via: 'api_token'` with `credentialId` and `credentialName` in their metadata,
so "which credential did this?" is answerable without guessing. (They are
called `credential*` rather than `token*` because the log scrubber redacts any
field whose name contains "token" — the right trade: rename the field, never
weaken the scrubber.)

## Not in 2.0

**TUI/CLI support.** The Go client stores a JWT pair
(`tui/internal/config/config.go`); teaching it long-lived tokens is its own
release, and `docs/tui-parity.md` has higher-priority gaps.

## Related

- `backend/src/config/permissions.js` — the catalogue, including which
  permissions are non-delegable
- `docs/rbac/permission-matrix.csv` — generated from it
- `docs/auth-hardening.md` — the JWT path this sits beside
