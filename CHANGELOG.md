# Changelog

All notable changes to Shellius will be documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Tracked here as work lands on `main`; moved into a dated section on release
(`node scripts/version.mjs bump <major|minor|patch>`).

### Added

- Terminal workspace **session recovery**:
  - Tabs re-attach automatically after network drops, with backoff and offline awareness.
  - When a session is really gone (Shellius restarted, access expired or revoked, admin
    terminated, detach timeout, remote `exit`), the tab shows a recovery card. It explains
    what happened and offers what will work with your *current* access: Reconnect, View
    request, Request access again, or Quick Connect again (prefilled; one-off passwords are
    never stored).
  - Recovery happens in the same tab, so its place and split are kept.
  - A banner offers **Reconnect all** when several tabs are affected.
  - New `GET /api/terminal/sessions/:id/recovery` and `POST /api/terminal/sessions/:id/reconnect`.
- Terminal workspace **Workspaces**: tabs merged into a split become one tab in the tab bar
  ("Workspace", renameable), with a member count and combined status. You can reorder it,
  cycle to it with the keyboard, ungroup it, close it (sessions keep running) or end all its
  sessions.
- Redesigned **Sessions panel**: "Running in background" (with Attach all) and "Open in tabs"
  sections. Rows show auth method, age and time left before a detached session closes or access
  ends; click a row to open or attach it; Duplicate/End on hover; filter; proper empty state.
- On startup, SSH sessions left `ACTIVE` by a crashed or killed backend are closed with reason
  `server_restart`.
- Running sessions that aren't open in a tab can be re-attached from the **"+" New connection
  dialog** as well as the empty workspace, with **Attach all**. The Sessions button shows how many
  are waiting.

### Changed

- Terminal workspace: **splits now belong to their tabs** instead of being one layout for the
  whole page. Opening or selecting a tab outside a split shows it full size, with no empty half
  pane. Choosing Single on one tab no longer collapses another split, and several splits can
  exist side by side. Clicking any tab of a split brings the split back. New "Remove from
  split" tab action and split icons on grouped tabs. See `docs/terminal-workspace.md`.

### Fixed

- Terminal workspace: switching tabs or layouts no longer reconnects every terminal it moves.
  That produced "Too many requests" errors after a few quick switches or a reload with several
  tabs, and stray prompt lines from resizes while a tab was hidden. Terminals also stop sending
  no-op or zero-size resizes to the remote shell.
- Terminal workspace: saved tabs are now per user, so another person signing in on the same
  browser no longer inherits them.
- Access request status tabs retry by themselves when Shellius is briefly unreachable, and
  "Request again" reuses the tab.
- Access requests: the sidebar badge showed the unread-notification count. It now shows
  requests waiting for your review, the same number as the "Pending reviews" tab, and updates
  after you approve or deny.
- Access requests: the status filter (`?status=`) was accepted by the API but ignored, so
  "All statuses / Approved / Expired…" didn't filter.

## [1.1.0] - 2026-09-18

This is a large release: a full secrets/credentials manager (Keystore), a new
in-app terminal workspace, multi-provider SSO, and a broad authentication
hardening pass. Everyone will need to sign in again after upgrading (see
Breaking changes).

### Security

- **Fixed:** per-host agent tokens replace the single, org-wide
  `AGENT_SHARED_SECRET` used by `check-principals` and `/api/hosts/heartbeat`
  on every target host. Previously, a certificate minted for an *approved*
  access request on one server (e.g. a dev box) could also authenticate on
  any other server in the org — including production — because verification
  never checked which host was asking, and every host shared one fleet-wide
  secret. Certificates are now bound to the exact server they were issued
  for (`Certificate.issuedForId`), and each host authenticates with its own
  token (hash-only, stored in `Server.agentTokenHash`), minted fresh every
  time its bootstrap script is generated. **Hosts already bootstrapped must
  re-run the install one-liner with `--upgrade`** (from the server's
  "Bootstrap" panel: `curl -fsSL "<install-url>" | sudo bash -s -- --upgrade`)
  to pick up their per-host token. Until then, `AGENT_LEGACY_SHARED_SECRET`
  (default `warn`) keeps un-upgraded hosts working against the old
  `AGENT_SHARED_SECRET`, logging a rate-limited deprecation warning and
  setting `x-shellius-agent-deprecated: 1` on responses; set it to `deny` to
  cut legacy hosts off immediately. **`AGENT_LEGACY_SHARED_SECRET` will
  default to `deny` in the next release** — re-bootstrap all hosts before
  upgrading again. See `docs/deployment.md` → "Upgrade notes: per-host agent
  tokens".
- **Fixed:** the backend now **refuses to start in production** without a
  strong `SERVER_ENCRYPTION_KEY` (64 hex chars, or at least 32 characters).
  Previously it only warned and fell back to a key derived from a constant in
  the source tree. Encrypted values now use a versioned envelope
  (`v2:<keyId>:…`); legacy values are still read. Rotate keys by setting the
  new key in `SERVER_ENCRYPTION_KEY`, the old one(s) in
  `SERVER_ENCRYPTION_KEY_PREVIOUS`, and running `npm run crypto:reencrypt`
  (supports `--dry-run`).
- **Fixed:** terminal WebSockets no longer carry the access token in the URL.
  The browser first calls `POST /api/terminal/ws-ticket` and connects with a
  single-use, 30-second ticket bound to the user, org and connection target;
  the upgrade is also rejected (403) when the `Origin` header doesn't match
  the configured public origin. nginx access logs no longer record query
  strings.
- **Fixed:** suspending, deactivating or deleting a user, changing their role,
  revoking their sessions, or changing/resetting their password now **ends
  their live terminal sessions immediately**; new terminal connections apply
  the same account-status and session-revocation checks as the REST API.
- **Fixed:** session recordings are now **encrypted at rest** (AES-256-GCM
  with a per-recording data key wrapped by `SERVER_ENCRYPTION_KEY`) before
  upload to object storage, independent of bucket settings; replay decrypts
  on the fly and existing unencrypted recordings still play.
- **Fixed:** admins could terminate another organization's session by id;
  terminate is now scoped to the caller's organization.
- **Fixed:** secrets are masked in application logs and audit-log metadata;
  key-export output is scrubbed of the credentials used for that export;
  CLI device-login codes are stored hashed and the device flow is rate
  limited; Quick Connect tickets, WebSocket tickets, key inspect/import and
  identity tests are rate limited per user; avatar images only load from
  `https:` or raster `data:` URLs.
- **Fixed:** host install and uninstall links (`/api/bootstrap/install.sh`,
  `install.ps1`, `uninstall.sh`) are now **single-use**. A second download of
  the same link returns `410 LINK_ALREADY_USED`, so a link that ends up in
  shell history, a chat message or a proxy log can't be replayed to mint
  another agent token. Generate a new link from the server's Bootstrap panel
  to re-run an install.
- **Fixed:** `react-router-dom` upgraded to 7.x (moderate advisories in 6.x);
  `deepmerge-ts` in Prisma's CLI config loader pinned to 8.x via an npm
  override (high-severity advisory; Prisma 7 still ships the vulnerable 7.x,
  so an override is the fix). `npm audit` is clean for backend and frontend.
- **Docs:** `docs/DEPLOYMENT.md` §4.2.1 covers keeping query strings out of
  access logs on a proxy you run yourself (Traefik/Coolify, Caddy, nginx /
  Nginx Proxy Manager, cloud load balancers).

### Added

- **Keystore, Key Deployment & Quick Connect** — a deliberate, admin-sanctioned
  exception to the "zero static keys" principle for hosts that can't be
  CA-bootstrapped (appliances, customer-owned boxes, legacy systems):
  - **Keystore**: store reusable SSH key pairs (generated or imported) and
    "Identities" (`username` + password / key / both), all encrypted at rest
    (AES-256-GCM) and never returned by list/get endpoints — only fingerprints
    and `hasPassword`/`hasPassphrase` flags. Private key export is
    admin-only and audited.
  - **Key import** in every common format — OpenSSH (incl. bcrypt-encrypted),
    PEM PKCS#1 RSA (incl. legacy `Proc-Type: 4,ENCRYPTED`), SEC1 EC, PKCS#8
    (plain and encrypted), and PuTTY `.ppk` v2/v3 (Argon2). ed25519, RSA and
    ECDSA (nistp256/384/521); DSA is rejected as deprecated. An optional
    OpenSSH user certificate can be attached to an imported key and is
    validated against it.
  - **Key Deployment**: push, remove, or rotate a key across many servers in
    one batch (BullMQ-backed, async), with sudo support and automatic
    Identity repointing on rotation.
  - **Quick Connect**: ad-hoc SSH sessions (password, key, or a saved
    Identity) without saving a server, via short-lived, single-use, encrypted
    Redis tickets (60s TTL). Refuses any host matching a saved production
    server — Quick Connect can never be used to route around the approval
    flow. A target can be saved as a real server afterwards.
  - **Quick Connect history**: per-user, last 7 days, no secrets — a
    dashboard "Recent Quick Connects" widget with one-click reconnect.
  - Servers gained `authMode: certificate | credential` — a `credential` mode
    server uses a stored Identity instead of the CA and needs no bootstrap
    agent. Host keys are pinned (TOFU) per server; a mismatch blocks the
    connection until an admin resets the pin.
  - See `docs/keystore-and-quick-connect.md` for the full API contract.

- **Unified SSH engine** — every outbound SSH connection (web terminal,
  key deployment, credential tests, provisioning) now goes through one `ssh2`
  based client (`backend/src/services/sshConnect.js`); the backend no longer
  shells out to the OpenSSH `ssh` binary. Adds RSA (`rsa-sha2-256/512`) and
  ECDSA certificate authentication alongside ed25519, with the legacy SHA-1
  `ssh-rsa-cert-v01` intentionally never offered. Covered by a self-contained
  end-to-end test (`npm run test:e2e:ssh`) that spins up disposable sshd
  containers. Outbound SSH targets are guarded against loopback / link-local
  (incl. the cloud metadata address `169.254.169.254`) / unspecified /
  multicast addresses, resolved once to prevent DNS-rebinding
  (`SSH_TARGET_ALLOW_LOOPBACK` opts a lab deployment back in — never enable
  in production).

- **Terminals workspace** — a persistent, Termius-style in-app terminal:
  - SSH sessions are **detachable**: closing a tab or the browser no longer
    kills the session. A `terminalHub` keeps it alive server-side, buffers
    recent output for replay, and fans output out to every attached socket.
    A detached session auto-ends after `TERMINAL_DETACH_TTL_SECONDS`
    (default 15 min) unless reattached first.
  - Tabs, split panes (2-up, 2-down, 2x2 grid), duplicate, rename, and a side
    panel listing every live session (including ones not open in any tab)
    with Attach / Duplicate / End.
  - Workspace layout persists in `localStorage` (session IDs + labels only,
    no secrets) and reconnects/replays on reload.
  - Session recording is continuous across detach/attach (one recording per
    SSH session, not per WebSocket).
  - Known limitation: reattach requires hitting the same backend instance
    that owns the session — multi-replica deployments need sticky routing on
    `/api/terminal/*` (see Deployment docs).

- **Multi-provider SSO, including GitHub** — an org can now enable several
  SSO providers simultaneously (Google, Microsoft Entra ID, Okta, Auth0, any
  generic OIDC IdP, and GitHub via OAuth 2.0, including GitHub Enterprise
  Server), each with its own login button, allowed domains / allowed GitHub
  orgs, default role, and auto-provisioning setting. Linked identities live
  per-provider per-user (`UserIdentity`), so a user can sign in with more
  than one method. `GET /api/auth/me` lists linked identities;
  unlinking is blocked if it would leave the user with no way to sign in.

- **Auth & session hardening** (parity pass, see `docs/auth-hardening.md`):
  - Access tokens are now explicitly **typed** (`typ: 'access'`) — MFA
    challenge, bootstrap, and gateway tokens can never be replayed as bearer
    tokens.
  - Refresh tokens are single-use and grouped into rotation **families**;
    reuse of an already-rotated token outside a 10s grace window revokes the
    whole family and is audited (`auth.refresh_reuse`). Families carry an
    absolute lifetime (`SESSION_ABSOLUTE_TTL`, default 30 days) independent
    of activity.
  - Every request re-checks the user's live status and `sessionsValidFrom` —
    role demotions, suspensions, and forced-logouts (`POST
    /api/users/:id/revoke-sessions`) take effect immediately, not at next
    token refresh.
  - Account lockout after repeated failed local logins
    (`AUTH_LOCKOUT_THRESHOLD` / `AUTH_LOCKOUT_MINUTES`, default 5 / 15 min),
    admin unlock endpoint, constant-time handling of unknown emails.
  - TOTP and email-OTP MFA, backup codes, per-org enforcement
    (`MfaConfig.enforced`), and a `GET /api/auth/sessions` /
    `DELETE /api/auth/sessions/:id` device/session manager in the UI.
  - SSO (OIDC) callback now verifies the ID token signature via JWKS and
    checks `iss`/`aud`/`exp`/`nonce`; PKCE (S256) on every provider.
  - New "hardened sign-in" frontend flow covering MFA challenge, session
    list, and lockout messaging.

- **Production approval bypass role** — `server.environment === 'prod'` still
  requires manager approval by default (unchanged invariant), but an org can
  now configure `Organization.settings.access.prodApprovalBypassMinRole`
  (`admin` (default) | `super_admin` | `none`) so sufficiently privileged
  roles get immediate, audited access (`access_request.prod_bypass`) instead
  of waiting on a reviewer. Policy `autoApprove` can no longer silently grant
  unreviewed prod access to roles below the bypass threshold — the prod
  invariant is enforced centrally, not per-policy.

- **Global search & command palette** — `GET /api/search` searches servers,
  customers, users, identities, keys, and policies in one call (role-gated
  per type, org-scoped); a command palette (`Ctrl/Cmd+K`) and a Quick Actions
  menu surface it in the UI, alongside deep-linkable create/import modals
  (`?action=new`, `?action=invite`, etc.) and expanded keyboard shortcuts.

- **Avatars** — user profile pictures (uploaded, ≤150KB WebP) or inherited
  from the SSO provider; every API that embeds a user now returns a
  consistent `{ id, name, email, avatarUrl }` shape.

- Dashboard redesign: compact metric cards, a "Recent activity" feed, "Recent
  Quick Connects", and a Quick Actions widget.

- `cd backend && npm run db:seed:demo` — an idempotent, clearly-tagged demo
  dataset for screenshots/demos (never runs automatically; `-- --reset` to
  remove it).

### Changed

- UI consistency pass: uniform badges and "user cell" rendering (avatar +
  name + email) across every table, centred/borderless topbar controls,
  consistent dialog widths and dropdown clipping fixes, a lighter dark theme
  palette with raised cards/popovers, and a reworked topbar (search-by-action,
  avatar-only user menu, theme menu).
- `GET /api/search` `counts` now report **total** matches per type, not just
  the truncated page returned, so the UI can show "12 more…".
- Server detail header actions condensed into a "More" menu.

### Fixed

- Audit log: expandable rows no longer trigger React's missing-`key` warning.
- Fresh installs: gap-fill migrations for the CA/certificate tables so a
  brand-new database created via `prisma migrate deploy` ends up byte-for-byte
  identical to one that evolved through every historical migration. Verified
  by `backend/scripts/verify-migrations.sh` (`npm run db:verify-migrations`)
  against three scenarios: fresh DB, an existing `main`-schema DB, and an
  existing DB with every current migration already marked applied.
- Redis client now honours `REDIS_URL` everywhere (a code path was falling
  back to individual `REDIS_HOST`/`REDIS_PORT` vars even when `REDIS_URL` was
  set).
- A cancelled Quick Connect attempt no longer burns the connection ticket it
  never used.
- Web terminal no longer hangs silently on "Connecting" in dev — connect
  failures now surface a timeout/error instead.
- Terminal resize/close control frames were, in some races, typed into the
  shell instead of being intercepted as control messages.
- Terminal tabs now resume their own session correctly on reload (no
  duplicate render loop; detached sessions are reachable again from the
  workspace).

### New environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SSH_TARGET_ALLOW_LOOPBACK` | `false` | Allow outbound SSH to loopback targets (dev only — never enable in production) |
| `TERMINAL_DETACH_TTL_SECONDS` | `900` | How long a detached terminal session stays alive before it's ended |
| `SESSION_ABSOLUTE_TTL` | `2592000` (30d) | Absolute refresh-token-family lifetime |
| `AUTH_LOCKOUT_THRESHOLD` | `5` | Failed local logins before account lockout |
| `AUTH_LOCKOUT_MINUTES` | `15` | Lockout duration |
| `SSO_ALLOWED_DOMAINS` | *(any)* | Comma-separated allow-list for env-preset SSO providers |
| `SSO_GOOGLE_CLIENT_ID` / `_SECRET` | — | Google OIDC env preset |
| `SSO_ENTRA_TENANT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET` | — | Microsoft Entra ID env preset |
| `SSO_OKTA_DOMAIN` / `_CLIENT_ID` / `_CLIENT_SECRET` | — | Okta env preset |
| `SSO_AUTH0_DOMAIN` / `_CLIENT_ID` / `_CLIENT_SECRET` | — | Auth0 env preset |
| `SSO_CLIENT_ID` / `_CLIENT_SECRET` (+`SSO_ISSUER_URL`) | — | Generic OIDC / GitHub (incl. GHES) env preset |
| `KEY_DEPLOYMENT_CONCURRENCY` | `5` | BullMQ concurrency for key deployment jobs |
| `ONBOARDING_CONCURRENCY` | `5` | BullMQ concurrency for server onboarding jobs |
| `TRUST_PROXY` | — | Trusted reverse-proxy hop count for client-IP resolution |
| `RECORDINGS_DIR` | `./data/recordings` | Local fallback recording path when no object storage is configured |

See `docs/DEPLOYMENT.md` for the complete reference (every variable, not just
new ones this release).

### Breaking changes

- **Everyone must sign in again.** Access tokens are now typed and existing
  untyped tokens are rejected; refresh tokens are re-scoped into rotation
  families. There is no in-place token migration.
- The terminal workspace requires WebSocket upgrade support all the way
  through your reverse proxy for `/api/terminal/*` (this was already true for
  the plain web terminal; the new detach/reattach and Quick Connect flows
  make it load-bearing for more of the app). Confirm `Upgrade`/`Connection`
  headers are forwarded — see `docs/DEPLOYMENT.md`.
- `ssh2` is now pinned to an exact version because of the custom certificate
  signing override — do not bump it without re-running
  `npm run test:e2e:ssh`.
- Reattaching a detached terminal session only works against the backend
  instance that owns it. If you run multiple backend replicas, you now need
  sticky sessions on `/api/terminal/*` (see Deployment docs) — this is new
  with the Terminals workspace; the old one-shot `/terminal` page tolerated
  any replica.

### Migration notes

- Run `docker compose ... exec backend npx prisma migrate deploy` as usual
  (or let the container entrypoint do it automatically — see
  `docker/entrypoint-backend.sh`). If `prisma migrate status` reports drift on
  an older installation, see "Upgrading an existing deployment" in
  `docs/DEPLOYMENT.md` for the gap-fill/baseline procedure.
- Existing single-provider SSO configuration migrates automatically to the
  new multi-provider `SsoConfig` model on first read — no manual action
  needed; the legacy `GET/PUT /api/auth/sso/config` endpoints keep working
  against the first provider.
- All users are signed out on upgrade (see Breaking changes) — this is
  expected, not a bug.

## [1.0.2] - 2026-04-09

### Changed

- Seed script now upserts baseline groups and access policies on every
  container boot (previously first-boot only), so deployments that started
  before those defaults existed pick them up on upgrade without a manual seed
  run.

## [1.0.1] - 2026-04-09

### Changed

- Frontend: topbar and sidebar now share one `UserMenu` dropdown component
  instead of two divergent implementations.

## [1.0.0] - 2026-04-09

### Added

- Production `docker-compose.prod.yml` mirroring the VaultHive Traefik labels (single host, HTTP entrypoint, Cloudflare-fronted)
- Bundled Nginx (`docker/nginx-proxy.conf`) that fronts the backend and frontend over a single port and is the only Traefik-attached service
- `super_admin` bypass in `policyService.evaluate` -- super admins get direct access to every server, including production, with no approval flow (superseded by the configurable `prodApprovalBypassMinRole` in 1.1.0)
- TUI `/device` browser approval page (`frontend/src/pages/Device.jsx`) so users can confirm device codes from the web UI
- README, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, and CHANGELOG documentation

### Changed

- TUI `apiEnvelope.error` field now tolerates both string and object shapes returned by the backend
- TUI `serverListData` now decodes the backend's `items[]` response shape (was `servers[]`)
- TUI status bar now reads `RefreshToken` instead of `AccessToken` for the "session active" indicator -- expired access tokens no longer scare the user when a refresh token is still on disk
- TUI initial-view check now treats the presence of a refresh token as "logged in"; access tokens refresh transparently on the first API call
- TUI `app.go` global key handler now only quits on `Ctrl+C` (the previous `||`/`&&` precedence bug bound plain `q` as a global quit, breaking the host-list filter)

### Fixed

- DNS collision in the production stack: `shellius-nginx` was sometimes resolving the bare name `frontend` to JobTracker's container on the shared `homelab` network. Both backend and frontend now have unique container names (`shellius-api`, `shellius-web`) and explicit network aliases.
- TUI hostlist textinput now receives its `Focus()` command, so the filter actually captures keystrokes
- TUI `auth.SaveTokens` now persists the user's role into `~/.shellius/config.yaml` so super-admin status survives restarts
- Certificates page: removed a duplicate text label in the "Valid Until" column.

## [0.3.0] - 2026-04-07

Connect button fix, dashboard stat card redesign, and a private-repo-friendly
CLI/TUI install flow.

## [0.2.0] - 2026-04-07

### Added

- **Phase 17F — Profile, GDPR, self-service registration**
  - New `/profile` page: edit display name, change password (LOCAL accounts only), download a GDPR JSON export of every record about you, and delete your account with a type-to-confirm danger zone (soft-delete + 30-day grace before hard purge)
  - `/register` page gated by per-org `selfServiceRegistrationEnabled` flag: email-verified signup pinned to the `viewer` role, enumeration-safe responses, rate-limited
  - Email verification flow with new `verifyEmail` template and `EMAIL_VERIFY` token type in `inviteService`
  - `accountDeleted` and `smtpTest` email templates added to the registry
  - `passwordChangedAt`, `deletedAt` columns on `User`; `pending_verification` and `deleted` states added to `UserStatus` enum; `selfServiceRegistrationEnabled` added to `Organization`
  - `authService.login` now blocks accounts in `deleted` state
  - Login page `?deleted=1` confirmation banner; AcceptInvite page rebranded as "Set up your account" with name + Terms checkbox
- **Phase 18 — UX polish & defensive guards**
  - DataTable v2 rows-per-page selector (10/25/50/100) wired through every consuming page
  - Sidebar collapse mode tightens icon-only nav, adds tooltips, and surfaces a Profile shortcut alongside Settings
  - QuickConnect button polls active access every 60s and defensively re-validates `{status, expiresAt}` so an expired AR cannot show "Connect"
  - Policy evaluator API derives a canonical `outcome` field (`allow` / `deny` / `requires_approval`) so the UI has a single source of truth
  - New `PrivateIPWarning` component (banner / pill / note variants) wired into QuickConnectModal, RequestForm, ServerForm, and ServerDetail to flag RFC1918 / CGNAT / link-local hosts that need a VPN
- App-wide footer with version badge and Privacy / Terms / EULA / GitHub links, plus in-app legal pages at `/legal/:doc`
- 84 new Jest tests across registration, profile, access-request audit, policy outcome, and email templates (full suite: 174/174 passing)

### Changed

- Templated SMTP test email (`smtpTest`) replaces the plaintext one-liner — admins now see the shared HTML layout and full host/port/TLS context

## [0.1.0] -- 2026-04-06

Initial public release. Phases 1-3 and 5-12 of the project blueprint are
shipped; Phase 4 (multi-cloud connectors) is parked behind a flag.

### Phase 1 -- Foundation

- Project scaffolding (backend, frontend, TUI, docker compose, .env.example)
- PostgreSQL 16 + Prisma ORM
- Redis 7 + BullMQ scaffolding
- Express backend with authentication, RBAC, audit, tenant scoping middleware
- React 18 + Vite + Tailwind + shadcn/ui frontend shell

### Phase 2 -- Identity & Auth

- Email/password login with bcrypt
- JWT access + refresh tokens
- SSO via Passport (OIDC, SAML)
- RFC 8628 device authorization flow
- User and group management

### Phase 3 -- Customers & Servers

- Customer CRUD
- Server CRUD with environment tags (`demo`/`dev`/`staging`/`prod`)
- Health check service with TCP probe
- Frontend pages for customer and server management

### Phase 5 -- SSH Certificate Authority

- `CaKeyPair` and `Certificate` Prisma models
- `caService` with Ed25519 generation, AES-256-GCM encrypted-at-rest private key, `ssh-keygen`-based signing, rotation, and revocation
- `certificateService` with policy-driven issue, list, revoke, and verify
- `/api/certificates` and `/api/ca` routes
- Cert-expiry BullMQ job
- Certificates page and CA management section in Settings

### Phase 6 -- Access Policies

- `AccessPolicy` and `PolicySubject` models
- `policyService.evaluate` with prod hard-rule, deny-before-allow precedence, group resolution
- CRUD routes
- Policies page with multi-step PolicyForm
- "My Access" dashboard widget

### Phase 7 -- Access Requests & Approval Flow

- `AccessRequest` and `Notification` models
- `accessRequestService` with policy-driven submit, manager review, ephemeral SSH key generation, and (placeholder) RDP file generation
- `/api/access-requests` and `/api/notifications` routes
- BullMQ jobs: expire approved requests, expire pending requests, notify-expiring (deduplicated)
- AccessRequests page (My Requests / Pending Reviews / All tabs), RequestForm, ApprovalCard, CredentialDownload
- NotificationContext + NotificationBell with 30s polling

### Phase 8 -- Web Terminal

- `Session` Prisma model
- `terminalService` WebSocket SSH proxy via `ws` + `ssh2`, JWT upgrade auth, per-connection ephemeral cert, in-memory session map for force-terminate
- `/api/sessions` routes
- xterm.js `WebTerminal` component, Terminal page (full viewport), Sessions page

### Phase 9 -- TUI Client

- Go 1.22 + Bubble Tea TUI
- Device authorization flow with auto-open browser
- Token persistence in `~/.shellius/config.yaml` with auto-refresh
- Host list grouped by customer with environment badges and fuzzy filter
- Access request form with polling
- SSH handoff via `tea.ExecProcess`
- Cross-compile via `make build-all` (linux/darwin/windows × amd64/arm64)

### Phase 10 -- Audit & Session Recording

- `auditService` with action taxonomy (auth, user, group, customer, server, policy, access_request, cert, session, ca, connector, org)
- `/api/audit` and `/api/audit/export` routes (CSV + JSON)
- asciinema v2 `.cast` recording teed from the SSH stream
- `GET /api/sessions/:id/recording`
- `sessionCleanup` BullMQ job (1h) -- ends stale sessions and prunes recordings past retention
- AuditLog page with filters and export
- SessionPlayer component (asciinema-player)

### Phase 11 -- RDP Support

- `guacd` (Apache Guacamole daemon) added to docker-compose
- Server model gains `rdpUsername` and AES-256-GCM-encrypted RDP password fields
- `rdpService` implements the Guacamole protocol handshake by hand
- WebSocket RDP proxy at `/api/terminal/rdp` with short-lived gateway JWT
- `accessRequestService.generateRdpFile` returns a real `.rdp` file (RD Gateway support deferred)
- `RdpTerminal` frontend component using `guacamole-common-js`
- `Terminal` page now branches on `request.protocol`
- Servers page shows distinct icons for SSH vs RDP

### Phase 12 -- Polish & Deployment

- Dashboard with stat cards, quick actions, MyAccessWidget, recent activity feed
- Settings page tabbed: Organization, CA Management, SSO, Cloud Connectors (parked notice), Notifications
- Loading skeletons, empty states, ErrorBoundary, NotFound 404
- Keyboard shortcuts (`/` focus, `g+d`/`g+s`/`g+a`/`g+c` navigation)
- Production `docker-compose.prod.yml` with healthchecks, resource limits, named volumes, Traefik labels
- `/api/metrics` Prometheus endpoint protected by `METRICS_TOKEN`
- Backup scripts (`backup-db.sh`, `backup-recordings.sh`)
- `docs/deployment.md`
