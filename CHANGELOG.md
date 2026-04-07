# Changelog

All notable changes to Shellius will be documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [Unreleased]

### Added

- Production `docker-compose.prod.yml` mirroring the VaultHive Traefik labels (single host, HTTP entrypoint, Cloudflare-fronted)
- Bundled Nginx (`docker/nginx-proxy.conf`) that fronts the backend and frontend over a single port and is the only Traefik-attached service
- `super_admin` bypass in `policyService.evaluate` -- super admins get direct access to every server, including production, with no approval flow
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
