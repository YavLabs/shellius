# Keystore, Key Deployment & Quick Connect

Shellius's primary access model is **certificate-based**: hosts are bootstrapped
to trust the org CA, and every connection uses a short-lived cert. Some hosts
can't or shouldn't be bootstrapped (appliances, customer-owned boxes, legacy
systems). For those, Shellius provides a **Keystore** — Termix/Termius-style
stored identities — plus **Key Deployment** (push/rotate keys across hosts) and
**Quick Connect** (ad-hoc sessions without saving a server).

## Security model (exception to "zero static keys")

The Keystore is a deliberate, admin-sanctioned exception to the zero-static-keys
principle. Guard rails:

- All secret material (`SshKey.privateKeyEncrypted`, `passphraseEncrypted`,
  `Credential.passwordEncrypted`, Quick Connect tickets) is AES-256-GCM
  encrypted via `utils/crypto.js`. Secrets are decrypted in memory only at
  connect / deploy time, or on an explicit, audited admin export.
- List/get endpoints NEVER return secrets — only `hasPassword`,
  `hasPassphrase`, public key and fingerprint.
- Secrets are never logged. Audit entries record ids/names/fingerprints only.
- **Prod invariant preserved**: connecting to a saved server (any `authMode`)
  still goes through the access-request flow, so `environment === 'prod'`
  always requires approval. Quick Connect refuses any host that matches a saved
  `prod` server (by IP or hostname) — users must use the request flow.
- Host keys are pinned (TOFU) on `Server.hostKeyFingerprint` for every ssh2
  connection; a mismatch refuses the connection until an admin resets the pin.
- Every connection creates a `Session` row (recorded when storage is
  configured), including Quick Connect sessions (`serverId = null`).

## Data model (see `backend/prisma/schema.prisma`)

- `SshKey` — stored key pair. `source`: generated | imported.
- `Credential` ("Identity" in the UI) — `username` + `authType`
  (password | key | key_password), optional `passwordEncrypted`, optional
  `sshKeyId`. Reusable across many servers.
- `Server.authMode` — `certificate` (default, bootstrap/CA) | `credential`
  (uses `Server.credentialId`; no bootstrap required).
- `KeyDeployment` — one push/removal of a key to one server; rows sharing a
  `batchId` were submitted together.
- `Session.authMethod` — certificate | credential | quick_connect.

## Roles

| Action | Min role |
| --- | --- |
| List/view keys & identities (no secrets), test identity | manager |
| Create/edit/delete keys & identities, export private key | admin |
| Assign identity / authMode on a server | manager (same as editing a server) |
| Deploy / remove / rotate keys | admin |
| Quick Connect | org setting `quickConnect.minRole` (default `manager`); `quickConnect.enabled` default `true` |
| Save a Quick Connect target as a server | manager (+ admin if creating a new identity) |
| Reset pinned host key | admin |

## REST API

All endpoints are under `/api`, use `authenticate` + `tenant`, and the standard
envelope `{ success, data }` / `{ success:false, error:{code,message} }`.
Mutations are audited.

### Keys — `/api/keystore/keys`

`SshKeyDTO`:
```json
{ "id", "name", "description", "keyType": "ed25519|rsa|ecdsa", "bits", "publicKey",
  "fingerprint": "SHA256:...", "comment", "source": "generated|imported",
  "hasPassphrase": false, "createdAt", "updatedAt", "lastExportedAt",
  "createdBy": { "id", "name" } | null,
  "credentialCount": 0, "deploymentCount": 0 }
```

- `GET /keystore/keys?search=` → `{ keys: SshKeyDTO[] }`
- `GET /keystore/keys/:id` → `{ key: SshKeyDTO, credentials: [{id,name,username}], deployments: KeyDeploymentDTO[] (latest 50) }`
- `POST /keystore/keys/generate` `{ name, description?, keyType: 'ed25519'|'rsa'|'ecdsa' = 'ed25519', bits?: 2048|3072|4096 (rsa) | 256|384|521 (ecdsa), comment?, passphrase? }` → 201 `{ key }`
- `POST /keystore/keys/import` `{ name, description?, privateKey, passphrase? }` → 201 `{ key }` (public key + fingerprint derived server-side; 400 on bad key / wrong passphrase)
- `PATCH /keystore/keys/:id` `{ name?, description?, comment? }` → `{ key }`
- `DELETE /keystore/keys/:id` → 409 `KEY_IN_USE` if any credential references it
- `POST /keystore/keys/:id/export` (admin) `{ includePrivate: true }` → `{ publicKey, privateKey, passphraseProtected: bool }` — audited `keystore.key.export`

### Identities — `/api/keystore/credentials`

`CredentialDTO`:
```json
{ "id", "name", "description", "username", "authType": "password|key|key_password",
  "hasPassword": true, "tags": [], "lastUsedAt", "createdAt", "updatedAt",
  "sshKey": { "id", "name", "fingerprint", "keyType" } | null,
  "serverCount": 3 }
```

- `GET /keystore/credentials?search=` → `{ credentials: CredentialDTO[] }`
- `GET /keystore/credentials/:id` → `{ credential, servers: [{id,hostname,displayName,environment,ipAddress}] }`
- `POST /keystore/credentials` `{ name, description?, username, authType, password?, sshKeyId?, newKey?: { privateKey, passphrase? } | { generate: true, keyType?, bits? }, tags? }` → 201 `{ credential }`. `newKey` creates an `SshKey` named "`<name>` key" and links it.
- `PATCH /keystore/credentials/:id` — same fields; omitted/empty `password` keeps the existing one; `clearPassword: true` removes it.
- `DELETE /keystore/credentials/:id` → 409 `CREDENTIAL_IN_USE` if servers reference it (unless `?force=true`, which detaches servers and flips them back to `authMode: certificate`)
- `POST /keystore/credentials/:id/test` `{ serverId } | { host, port? }` → `{ ok, message, hostKeyFingerprint, hostKeyAlgorithm, durationMs }`

### Deployments — `/api/keystore/deployments`

`KeyDeploymentDTO`:
```json
{ "id", "batchId", "action": "deploy|remove|rotate", "status": "pending|running|success|failed",
  "targetUser", "authMode": "server|credential|certificate", "error", "output",
  "startedAt", "finishedAt", "createdAt",
  "server": { "id", "hostname", "displayName", "environment" },
  "sshKey": { "id", "name", "fingerprint" },
  "deployedBy": { "id", "name" } | null }
```

- `POST /keystore/deployments` (admin)
  ```json
  { "sshKeyId", "serverIds": ["..."], "action": "deploy|remove|rotate",
    "targetUser": "optional — defaults to the auth user on each server",
    "auth": { "mode": "server" }                       // server's own identity (credential servers) or CA cert (certificate servers)
         | { "mode": "credential", "credentialId" },   // a specific identity
    "useSudo": false,                                  // write another user's authorized_keys via sudo
    "rotate": { "oldSshKeyId", "updateCredentials": true } }  // action=rotate only
  ```
  → 202 `{ batchId, deployments: KeyDeploymentDTO[] }`. Processed async
  (BullMQ `key-deployments` queue). `rotate` = deploy new key → verify login
  with the new key → remove old key → (optionally) repoint every Credential
  that used `oldSshKeyId` to the new key.
- `GET /keystore/deployments?batchId=&sshKeyId=&serverId=&page=&pageSize=` → `{ deployments, meta: { total, page, pageSize } }`
- `GET /keystore/deployments/batches?limit=20` → `{ batches: [{ batchId, action, sshKey:{id,name}, createdAt, deployedBy, counts:{pending,running,success,failed,total} }] }`
- `POST /keystore/deployments/:id/retry` (admin) → `{ deployment }`

### Servers (additions)

- Server create/update accept `authMode: 'certificate'|'credential'` and
  `credentialId` (required when `authMode === 'credential'`, must belong to org).
- Server responses include `authMode`, `credentialId`,
  `credential: { id, name, username, authType } | null`, `hostKeyFingerprint`,
  `hostKeyAlgorithm`, `hostKeyPinnedAt`.
- `POST /servers/:id/host-key/reset` (admin) → clears the pin (audited).
- Credential-mode servers count as onboarded (no agent needed).

### Quick Connect — `/api/quick-connect`

- `GET /quick-connect/settings` → `{ enabled, minRole, allowed: bool }` (any authed user; `allowed` = can the caller use it)
- `PUT /quick-connect/settings` (admin) `{ enabled, minRole }`
- `POST /quick-connect/tickets`
  ```json
  { "host", "port": 22, "username",
    "auth": { "type": "password", "password" }
          | { "type": "key", "privateKey", "passphrase?" }
          | { "type": "credential", "credentialId" },   // username optional → identity's username
    "expectedHostKey": "SHA256:... (optional)" }
  ```
  → 201 `{ ticket, expiresIn: 60 }`. Ticket is single-use, bound to the
  caller's userId, stored encrypted in Redis (TTL 60s). 403
  `PROD_HOST_REQUIRES_APPROVAL` if the host matches a saved prod server
  (response includes `serverId` so the UI can link to it).
- `POST /quick-connect/save` (manager)
  ```json
  { "host", "port", "username", "hostname?", "displayName?", "customerId", "environment", "description?",
    "hostKeyFingerprint?", "hostKeyAlgorithm?",
    "identity": { "mode": "existing", "credentialId" }
              | { "mode": "new", "name", "auth": <same shape as ticket auth, not credential> }  // admin only
              | { "mode": "none" } }                  // saved as a certificate-mode server
  ```
  → 201 `{ server }` (created with `authMode` credential when an identity is given).

### WebSocket — `/api/terminal/ssh`

- Existing: `?token=<JWT>&requestId=<id>&cols&rows[&principal=]` — for
  credential-mode servers the backend connects with ssh2 using the server's
  identity instead of a CA cert.
- New: `?token=<JWT>&ticket=<quickConnectTicket>&cols&rows`.
- Control frames sent by the server as JSON text (in addition to the existing
  `{type:'error', message}`):
  - `{ "type": "hostkey", "fingerprint", "algorithm", "status": "pinned|matched|new" }`
  - `{ "type": "connected", "sessionId", "authMethod", "host", "port", "username" }`
- Client → server: raw input, or `{ "type": "resize", "cols", "rows" }` (real
  PTY resize on the ssh2 path).

---

## Revision 2 — unified SSH engine, key import formats, search

### One SSH engine (ssh2) for every connection

All outbound SSH — web terminal (certificate, identity and Quick Connect),
key deployment, credential tests and auto-provisioning — goes through
`backend/src/services/sshConnect.js` (ssh2). The OpenSSH `ssh` binary is no
longer spawned by the backend. OpenSSH user-certificate auth is supported by a
narrowly scoped override of ssh2's publickey signing (the signature blob must
carry the base algorithm, e.g. `ssh-ed25519`, while the userauth request
carries `ssh-ed25519-cert-v01@openssh.com`); `ssh2` is pinned to an exact
version and an end-to-end test covers it.

`connectSsh()` accepts any combination of: `privateKey` (+ `passphrase`),
`certificate` (paired with the key), `password`. Auth order: certificate →
publickey → password → keyboard-interactive (answering password prompts).
Servers that require *both* a key and a password (`AuthenticationMethods
publickey,password`) work via SSH partial success.

Target guard (Quick Connect, credential test, save-as-server): the host is
resolved once; loopback, link-local (incl. `169.254.169.254`), unspecified and
multicast addresses are refused (`TARGET_NOT_ALLOWED`); the connection is made
to the resolved IP (no DNS rebinding). The prod guard compares the *resolved*
IPs against every saved prod server's `ipAddress`/resolved `hostname`.

### Identities: password, key, or both

`authType`: `password` | `key` | `key_password` (both stored; key tried first,
then password — also satisfies hosts requiring both). Quick Connect ticket
auth: `{ type: 'password', password }` | `{ type: 'key', privateKey,
passphrase?, password? }` | `{ type: 'credential', credentialId }`. The same
`auth` shape is used by `POST /quick-connect/save` `identity.mode: 'new'`.

### Key import

Supported private key inputs (auto-detected from content, not extension):
OpenSSH (`-----BEGIN OPENSSH PRIVATE KEY-----`, incl. bcrypt-encrypted),
PEM PKCS#1 RSA (`BEGIN RSA PRIVATE KEY`, incl. legacy `Proc-Type: 4,ENCRYPTED`),
SEC1 EC (`BEGIN EC PRIVATE KEY`), PKCS#8 (`BEGIN PRIVATE KEY` /
`BEGIN ENCRYPTED PRIVATE KEY`), PuTTY `.ppk` v2 and v3 (encrypted v3 uses
Argon2). Key types: ed25519, rsa, ecdsa (nistp256/384/521). DSA is rejected
(deprecated). Keys are normalised to OpenSSH format; a passphrase-protected
input stays passphrase-protected at rest (in addition to AES-GCM).

- `POST /keystore/keys/inspect` `{ privateKey, passphrase? }` → `{ format,
  encrypted, keyType, bits, fingerprint, publicKey, comment }` (nothing is
  stored). Errors (400): `KEY_PASSPHRASE_REQUIRED` (key is encrypted; UI shows
  a passphrase field), `KEY_PASSPHRASE_INVALID`, `KEY_UNSUPPORTED_FORMAT`,
  `KEY_UNSUPPORTED_TYPE`.
- `POST /keystore/keys/import` `{ name, description?, privateKey, passphrase?,
  publicKey?, certificate? }` → 201 `{ key }`. `publicKey` (optional) must match
  the private key (`KEY_PUBLIC_MISMATCH`). `certificate` (optional OpenSSH user
  cert) must certify this key (`CERT_KEY_MISMATCH`) and parse
  (`CERT_INVALID`).
- `PATCH /keystore/keys/:id` also accepts `certificate` (string to set, `null`
  to clear).
- `SshKeyDTO` adds `originalFormat` and `certificate: null | { type, keyId,
  principals, validAfter, validBefore, expired, caFingerprint }` (the cert text
  itself is public and is returned by `GET /keystore/keys/:id` as
  `certificateText`).

### Global search — `GET /api/search`

`?q=<text>&limit=5` (min 2 chars) → `{ results: { servers, customers, users,
identities, keys, policies }, counts }`. Each item: `{ id, type, title,
subtitle, href, meta }`, where `meta` carries type-specific fields used for
result actions (servers: `environment, protocol, authMode, ipAddress,
hostname, onboarded`; users: `email, role, status`; identities: `username,
authType`; keys: `fingerprint, keyType`; customers: `serverCount`; policies:
`effect, isActive`). Role gating: servers/customers — any member;
identities/keys — manager+; users/policies — admin+. All org-scoped,
case-insensitive, prefix/contains match on names, hostnames, IPs, emails,
usernames, fingerprints.

### Deep-link actions (used by Quick Actions + command palette)

Pages open their create/import modals from `?action=`:
`/customers?action=new`, `/servers?action=new`, `/users?action=invite`,
`/policies?action=new`, `/access-requests?action=new`,
`/keystore?tab=identities&action=new`, `/keystore?tab=keys&action=generate`,
`/keystore?tab=keys&action=import`, `/keystore?tab=deployments&action=deploy`.
The param is removed from the URL once handled.

### Demo data

`cd backend && npm run db:seed:demo` seeds an idempotent demo dataset (tagged
so it can be removed with `npm run db:seed:demo -- --reset`). Never runs
automatically.
