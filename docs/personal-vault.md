# Personal vault and My hosts

Shellius is both an org-wide access tool and a personal SSH manager. Every
Keystore identity and SSH key now has a **scope**:

| Scope | Stored as | Who sees / uses it |
|-------|-----------|--------------------|
| **Organization** | `ownerId = null` | People with `keystore.view` see it; `keystore.manage` edits it; it can be bound to org servers, used for key deployment, and (with `quick_connect.use_stored_identity`) used in Quick Connect. Unchanged from before. |
| **Personal** | `ownerId = <user id>` | **Only its owner.** Nobody else — not admins, not super admins — can list, read, use, edit, export or delete it through the app. Admins see audit log entries (names, never secrets). |

On top of that, each user can keep **My hosts**: a private list of SSH
targets (name, host, port, username, identity). My hosts are *not* servers:
they never appear in the inventory, policies, approvals, dashboards, health
checks, search or the TUI, and nobody else can see them.

## Permissions

| Key | Default | What it allows |
|-----|---------|----------------|
| `vault.use` | every built-in role | Keep personal identities and SSH keys; use them in Quick Connect and My hosts; export your own keys. |
| `vault.hosts` | every built-in role | Save personal hosts and connect to them. |

Both are removable per role on the Roles page. The org switch
`Organization.settings.vault.enabled` (Settings → Access, `org.access_settings`,
default **on**) turns the whole feature off: while off, personal items are
kept but can't be listed, created or used by anyone.

## Rules (enforced in the backend)

1. **Private means private.** Every Keystore query is scoped: org views filter
   `ownerId: null`; personal views filter `ownerId: <caller>`. A personal item
   id belonging to someone else is a 404, never a 403 (no existence oracle).
2. **No mixing.** A personal identity may only use the owner's personal keys;
   an org identity only org keys. Personal identities/keys can never be bound
   to org servers (`authMode: credential`), used for key deployment (key or
   deploy-auth identity), or saved with a Quick Connect "save as server".
3. **Same connection guards as Quick Connect.** Connecting to a personal host
   (or using a personal identity in Quick Connect) goes through the Quick
   Connect ticket engine: target guard (no loopback / link-local / metadata
   addresses), **production hosts refused** (any host matching a saved prod
   server by name or resolved IP), DENY policies for matching saved servers,
   single-use encrypted tickets, audit (`quick_connect.ticket`, `vault.host.connect`),
   session rows and the org's recording rules. Personal hosts do **not** need
   `quick_connect.use` or the Quick Connect org switch — they have their own
   permission and switch.
4. **Org identities on personal hosts** are allowed only with
   `quick_connect.use_stored_identity` (same rule as Quick Connect).
5. **Host keys** on personal hosts are pinned on first successful connection
   (TOFU) and checked on every connection after; the owner can reset their
   own pin.
6. **Move to organization.** An owner who also holds `keystore.manage` can
   move their personal identity (together with its key, if no other personal
   identity uses that key) or key into the org Keystore. Moving is one-way and
   audited (`keystore.credential.move_to_org`, `keystore.key.move_to_org`).
7. **Offboarding.** Deleting a user deletes their personal identities, keys and
   hosts. Suspending keeps them (unusable while suspended).
8. **Not searchable.** Global search only returns org Keystore items; personal
   items and My hosts never appear there.
9. **Names** are unique per scope: org names across the org, personal names
   per owner. Two users can both have an identity called "home".

## API

### Keystore (`/api/keystore`) — scope aware

All DTOs carry `scope: 'org' | 'personal'`.

| Endpoint | Change |
|----------|--------|
| `GET /keys?scope=org\|personal`, `GET /credentials?scope=…` | `scope` defaults to `org` (needs `keystore.view`); `personal` needs `vault.use` + switch and returns only the caller's items. |
| `GET /keys/:id`, `GET /credentials/:id` | Personal items: owner only. Personal key detail has no servers / deployments. |
| `POST /keys/generate`, `POST /keys/import`, `POST /credentials` | Body `scope` (`org` default → `keystore.manage`; `personal` → `vault.use`). `sshKeyId` must be in the same scope. |
| `PATCH` / `DELETE` on keys and credentials | Personal: owner. Org: `keystore.manage`. |
| `POST /keys/:id/export` | Personal: owner (audited). Org: `keystore.export_private`. |
| `POST /credentials/:id/test` | Personal: owner, `{ host, port }` only (prod / DENY guards apply). Org: unchanged. |
| `POST /keys/inspect` | `keystore.view` **or** `vault.use`. |
| `POST /credentials/:id/move-to-org`, `POST /keys/:id/move-to-org` | Owner + `keystore.manage`. 409 on a name clash or a key shared by other personal identities. |

### My hosts (`/api/vault`)

| Endpoint | Body / result |
|----------|---------------|
| `GET /status` | `{ enabled, canUseVault, canUseHosts, canUseOrgIdentities }` |
| `GET /hosts` | `{ hosts: PersonalHost[] }` |
| `POST /hosts` | `{ name, host, port?, username?, credentialId?, description?, tags?, newIdentity? }` → `{ host }` |
| `PATCH /hosts/:id` | any of the above (except `newIdentity`) → `{ host }` |
| `DELETE /hosts/:id` | `{ id }` |
| `POST /hosts/:id/connect` | `{ auth? }` → `{ ticket, expiresIn }` (open the terminal with the ticket exactly like Quick Connect) |
| `POST /hosts/:id/host-key/reset` | `{ host }` |

`PersonalHost`:

```json
{
  "id": "…", "name": "home-lab", "host": "10.0.0.5", "port": 22,
  "username": "yash",            // null = use the identity's username
  "description": null, "tags": [],
  "credential": { "id": "…", "name": "Home", "username": "yash", "authType": "key", "scope": "personal" } | null,
  "hostKeyFingerprint": "SHA256:…" | null, "hostKeyPinnedAt": "…" | null,
  "lastConnectedAt": "…" | null, "lastStatus": "connected" | "failed" | null, "lastError": null,
  "connectCount": 3, "createdAt": "…", "updatedAt": "…"
}
```

- `username` is required when there's no `credentialId`.
- A host without an identity needs one-off `auth` on connect —
  `{ type: 'password', password }` or `{ type: 'key', privateKey, passphrase?, password? }`
  (never stored); otherwise `409 SECRET_REQUIRED`.
- `newIdentity: { name, auth }` (same `auth` shape) creates a personal identity
  in the same transaction and links it — used by Quick Connect's "Save to My hosts".
- Errors: `403 VAULT_DISABLED` (org switch off), `403 PERMISSION_DENIED`,
  `403 QUICK_CONNECT_PROD_HOST`-style prod refusals from the ticket engine,
  `409` name clash.

### Quick Connect

- `GET /api/quick-connect/settings` adds `canUsePersonalIdentity`.
- `POST /api/quick-connect/tickets` with `auth.type: 'credential'` accepts the
  caller's personal identities (needs `vault.use`), as well as org identities
  (needs `quick_connect.use_stored_identity`).

### Org settings

`GET/PUT /api/org/access-settings` adds `personalVaultEnabled` (boolean).
The signed-in user's profile (`/api/auth/me`, login) adds
`features: { personalVault: boolean }`.
