<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/shellius-lockup-dark.png" />
    <img src="docs/assets/shellius-lockup-light.png" alt="Shellius" width="300" />
  </picture>
</p>

<h3 align="center">Self-hosted, certificate-based SSH and RDP access management for fleets</h3>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/version-1.7.1-green.svg" alt="Version" />
  <img src="https://img.shields.io/badge/docker-compose-blue.svg" alt="Docker" />
  <img src="https://img.shields.io/badge/go-1.22+-00ADD8.svg" alt="Go" />
  <img src="https://img.shields.io/badge/node-20+-339933.svg" alt="Node" />
</p>

---

Shellius replaces static SSH keys and shared RDP passwords with **short-lived, signed certificates**, a **policy-driven approval workflow**, and a **central audit trail**. Users get access through a web portal or a fast Bubble Tea TUI; servers trust a single Shellius CA and validate every connection in real time.

## Features

- **SSH Certificate Authority** -- Ed25519 CA per organization, certificates signed on demand with bounded TTLs, no static `authorized_keys` to manage
- **Real-time access validation** -- target hosts run `check-principals` against the Shellius API on every SSH connection so revocation is instant
- **Policy engine** -- allow/deny rules scoped by customer, environment, label, server, user, and group, with deny-before-allow precedence
- **Manager approval workflow** -- production servers always require approval; non-prod environments can auto-approve via policy
- **Multi-protocol** -- SSH via OpenSSH certificates and RDP via Apache Guacamole (browser RDP, server-injected credentials)
- **Browser web terminal** -- xterm.js + WebSocket for SSH, full Guacamole client for RDP
- **Companion TUI** -- Go/Bubble Tea client with device-auth login, fuzzy host search, and direct SSH handoff
- **Session recording** -- asciinema `.cast` files for SSH sessions, replayable in the web UI
- **Audit log** -- immutable, taxonomy-based events with CSV/JSON export
- **Multi-tenant** -- every record scoped by `org_id`, enforced at the query layer
- **Multi-cloud discovery** -- AWS, Azure, GCP connector framework (parked behind a flag — see roadmap)
- **Cloudflare/Linear/Vercel-style UI** -- React 18 + shadcn/ui + Tailwind, dark mode out of the box
- **User profile + GDPR** -- self-service profile editing, password change, JSON data export, soft-delete with 30-day grace window
- **Self-service registration** -- per-org toggle for email-verified signup, viewer role pinning, enumeration-safe responses
- **Templated transactional email** -- HTML layout shared across invite, password reset, password changed, access request, certificate expiry, account deleted, email verification, and SMTP test messages
- **Private-network awareness** -- UI flags hosts with RFC1918 / CGNAT / link-local addresses so users connect to VPN before requesting access
- **Docker Compose deployment** -- Traefik labels included, optional bundled Nginx

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20 (Express, ES modules) |
| Frontend | React 18 (JavaScript, no TypeScript) + shadcn/ui + Tailwind CSS |
| TUI Client | Go 1.22 (Bubble Tea, Lipgloss, Bubbles) |
| Database | PostgreSQL 16 |
| ORM | Prisma |
| Cache & Queue | Redis 7 + BullMQ |
| SSH CA | OpenSSH `ssh-keygen` (Ed25519) |
| RDP Gateway | Apache Guacamole (`guacd`) |
| Web Terminal | xterm.js + WebSocket + `ssh2` |
| Auth | JWT (access + refresh), OIDC/SAML via Passport, RFC 8628 device flow |
| Encryption | AES-256-GCM (CA private key, RDP passwords) |
| Reverse Proxy | Nginx (internal) + Traefik (optional, external) |
| Metrics | Prometheus (`prom-client`) |

## Quick Start

### Prerequisites

- Docker and Docker Compose v2+
- Git
- A domain pointing at the host (HTTPS strongly recommended for production)

### 1. Clone the repository

```bash
git clone https://github.com/YavLabs/shellius.git
cd shellius
```

### 2. Configure environment

```bash
cp .env.prod.example .env.prod
```

Open `.env.prod` and fill in the required values. At minimum:

- `POSTGRES_PASSWORD` -- database password
- `JWT_SECRET` and `JWT_REFRESH_SECRET` -- generate with `openssl rand -hex 32`
- `SERVER_ENCRYPTION_KEY` -- generate with `openssl rand -hex 32` (encrypts the CA private key and RDP passwords)
- `AGENT_SHARED_SECRET` -- generate with `openssl rand -hex 32` (used by host agents calling `/api/certificates/verify`)
- `METRICS_TOKEN` -- generate with `openssl rand -hex 16`
- `TRAEFIK_HOST` -- the hostname Shellius will be served at (e.g. `shellius.example.com`)
- `FRONTEND_URL` and `CORS_ORIGIN` -- the public URL of the frontend

### 3. Start the stack

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

This starts: PostgreSQL, Redis, `guacd` (RDP gateway), the backend API, the React frontend, and an Nginx reverse proxy. Database migrations and an idempotent seed (bootstrap organization + your initial super admin, from the `SEED_*` variables in `.env.prod`) run automatically on the backend's first boot — no manual migration step needed.

```bash
docker compose -f docker-compose.prod.yml ps   # wait for every service to report "healthy"
```

### 4. Access Shellius

Open `https://<your-host>` in your browser. Log in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env.prod`, then change that password immediately from Profile → Change password.

For upgrading an existing deployment, Coolify, TLS/reverse proxy details, and the full environment variable reference, see **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)**.

## TUI Client (Shellius CLI)

Shellius ships with a Bubble Tea-based terminal client that runs on developer
workstations — **not** on target servers. Install it once, sign in once, and
`shellius` will land you directly on your approved access requests with one
keystroke to SSH. Tokens are persisted and refreshed automatically.

### Quick install (macOS and Linux)

The installer is served directly by your Shellius deployment at
`/api/cli/install.sh`, so you never need to visit GitHub:

```bash
# Replace <your-shellius-host> with the URL you reach the web UI at.
curl -fsSL https://<your-shellius-host>/api/cli/install.sh | sh
```

You'll also find a copy-paste-ready version with the correct host
already filled in on the **Install CLI** page (profile menu) in the web UI.

The script detects your OS (`darwin`/`linux`) and architecture
(`amd64`/`arm64`), pulls the matching binary from the latest GitHub release,
verifies its SHA256 checksum, and installs to `/usr/local/bin/shellius`
(or `~/.local/bin/shellius` if not root). Windows users should download the
`.exe` directly from [Releases](https://github.com/YavLabs/shellius/releases/latest).

### Manual download

Grab the binary matching your platform from the [latest release](https://github.com/YavLabs/shellius/releases/latest):

| Platform | Asset |
|---|---|
| Linux amd64 | `shellius-linux-amd64` |
| Linux arm64 | `shellius-linux-arm64` |
| macOS Intel | `shellius-darwin-amd64` |
| macOS Apple Silicon | `shellius-darwin-arm64` |
| Windows | `shellius-windows-amd64.exe` |

Each asset ships with a `.sha256` sidecar for verification.

### Build from source

```bash
cd tui
make build              # produces bin/shellius
sudo install -m 0755 bin/shellius /usr/local/bin/shellius

# Cross-compile for other platforms
make build-all          # bin/shellius-{linux,darwin,windows}-{amd64,arm64}
```

### First-time login

```bash
shellius login https://shellius.example.com
```

The CLI will:

1. Hit `/api/auth/device/authorize` for a user code and verification URL
2. Open your browser so you can approve the device while already authenticated on the web UI
3. Poll until approved, persist tokens to `~/.shellius/credentials` (0600)
4. Drop you into the active-access picker

Every subsequent `shellius` invocation lands straight on the picker with
zero prompts — access tokens refresh automatically via the stored refresh
token until you explicitly run `shellius logout`.

### Daily usage

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate the active-access list |
| `↵` | SSH into the selected server |
| `/` | Open the slash-command palette (fuzzy search) |
| `?` | Open the help overlay |
| `Ctrl+C` | Quit |

### Slash commands

| Command | What it does |
|---|---|
| `/help` | Cheatsheet overlay |
| `/servers` | Browse the full host list (not just your active access) |
| `/request` | Submit a new access request |
| `/sessions` | Active and recent SSH sessions started from this machine |
| `/refresh` | Force-refresh the active-access list |
| `/profile` | Current identity and token expiry |
| `/logout` | Clear credentials and exit |
| `/quit` | Exit without logging out |

### Diagnose

If something isn't working, run `shellius doctor` — it prints the config
path, file permissions, server URL, token expiry (human-readable), and the
most recent refresh-token attempt from the log. Exits non-zero on any
detected issue.

```bash
shellius doctor
```

### Config and credentials layout

```
~/.shellius/
├── config.yaml       # non-secret prefs (0644): serverURL, orgSlug, theme
├── credentials       # tokens (0600, refuses to load if looser)
├── shellius.log      # rolling log, 1 MB cap
├── cache/            # host list cache for instant startup
└── sessions/         # per-session state files for multi-window awareness
    └── history/      # 7-day pruned history
```

The CLI install instructions are also available inside the web UI on the
**Install CLI** page (profile menu) with copy-to-clipboard buttons for every command.

## Development Setup

### Backend

```bash
cd backend
npm install
cp ../.env.prod.example ../.env.dev
npx prisma generate
docker compose -f docker-compose.dev.yml up -d postgres redis
npx prisma migrate dev
npm run dev          # runs on :3001
```

### Frontend

```bash
cd frontend
npm install
npm run dev          # runs on :5173 (Vite)
```

### TUI

```bash
cd tui
go mod tidy
go run ./cmd/shellius --server http://localhost:3001
```

### Running tests

```bash
# Backend
cd backend && npm test

# Frontend
cd frontend && npm test

# TUI
cd tui && go test ./...
```

## Environment Variables

Example files: [`.env.example`](.env.example) (dev) and [`.env.prod.example`](.env.prod.example) (production). The full reference table — every variable, whether it's required, its default, and which ones must be secrets — lives in **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#3-environment-variables-reference)**.

SSO provider credentials can also be configured per-organization under Administration → Single sign-on and stored encrypted in the database, instead of (or alongside) env presets.

## Architecture

```
                   +-------------+
                   |   Traefik   |  (optional)
                   +------+------+
                          |
                   +------+------+
                   |    Nginx    |  proxy /api -> backend, / -> frontend
                   +--+------+---+
                      |      |
        +-------------+      +--------------+
        |                                   |
 +------+------+                    +-------+------+
 |  Frontend   |                    |   Backend    |
 |  React 18   |                    |  Express     |
 +-------------+                    +--+--+--+--+--+
                                       |  |  |  |
                          +------------+  |  |  +--------------+
                          |               |  |                 |
                  +-------+-----+   +-----+--+--+      +-------+------+
                  | PostgreSQL  |   |   Redis   |      |    guacd     |
                  | + Prisma    |   |  BullMQ   |      | RDP gateway  |
                  +-------------+   +-----------+      +--------------+
                                          |
                                  +-------+------+
                                  | Cert/Session |
                                  | expiry jobs  |
                                  +--------------+

  +-----------+         +-----------+         +-----------+
  |  Browser  |  HTTPS  |  Web UI   |  WSS    |  Web Term |
  +-----------+ <-----> | + xterm   | <-----> |  ssh2 ->  | -> target host
                        +-----------+         +-----------+

  +-----------+   /api/auth/device/*   +------------+  exec ssh + cert
  |    TUI    | <--------------------> |  Shellius  | -------------> target host
  +-----------+                        +------------+
```

**Key design principles:**

- **Zero static keys** -- all SSH access uses short-lived certificates signed by the org CA
- **Prod always requires approval** -- hard-coded invariant in `policyService.evaluate`, with a `super_admin` bypass
- **Real-time revocation** -- target hosts validate every connection through `check-principals`
- **Multi-tenant** -- every tenant-scoped table has `org_id`, enforced at the query layer
- **Audit everything** -- all read/write/access/revoke actions logged with actor, target, timestamp, IP. `AuditLog` is immutable
- **Ephemeral credentials** -- SSH private keys generated per request, returned once, never persisted server-side; RDP passwords are injected via Guacamole and never exposed to users

## Project Structure

```
shellius/
├── backend/
│   ├── prisma/             # Schema, migrations, seed
│   └── src/
│       ├── app.js          # Express entry point
│       ├── config/         # db, redis, auth, ca
│       ├── middleware/     # auth, rbac, audit, tenant, rate-limit
│       ├── routes/         # Thin route handlers
│       ├── services/       # Business logic (CA, certs, policies, requests, sessions, RDP, audit, terminal)
│       ├── jobs/           # BullMQ workers (cert/request/session expiry, recording cleanup)
│       └── utils/          # crypto, validators
├── frontend/
│   └── src/
│       ├── components/     # ui/ (shadcn), domain components, layout
│       ├── pages/          # Dashboard, Servers, Customers, Policies, Certificates,
│       │                   # AccessRequests, Sessions, AuditLog, Administration (Users, Roles, Groups, org settings),
│       │                   # Login, Device, Terminal, NotFound
│       ├── hooks/
│       ├── context/        # AuthContext, ThemeContext, NotificationContext
│       └── services/       # axios API modules
├── tui/
│   ├── cmd/shellius/       # Go entry point
│   └── internal/
│       ├── auth/           # Device flow, token refresh, browser open
│       ├── api/            # HTTP client
│       ├── config/         # ~/.shellius/config.yaml
│       ├── ssh/            # exec ssh, temp cert files
│       └── tui/            # Bubble Tea views
├── docker/                 # Dockerfiles, nginx-proxy.conf
├── scripts/                # backup-db.sh, backup-recordings.sh
├── docs/                   # DEPLOYMENT.md, auth/SSO/SMTP/keystore/terminal design docs
├── docker-compose.yml      # dev
├── docker-compose.prod.yml # prod (Traefik labels)
└── .env.prod.example
```

## Phase Status

Shellius was built in 12 phases. Current status:

| Phase | Area | Status |
|---|---|---|
| 1  | Foundation (scaffolding, DB, backend core, frontend shell) | shipped |
| 2  | Identity & Auth (login, SSO, device flow, users/groups) | shipped |
| 3  | Customers & Servers (CRUD, health checks) | shipped |
| 4  | Cloud Connectors (AWS/Azure/GCP discovery) | parked |
| 5  | SSH CA (key pair, signing, rotation) | shipped |
| 6  | Access Policies (deny-before-allow, group resolution) | shipped |
| 7  | Access Requests (manager approval, ephemeral creds) | shipped |
| 8  | Web Terminal (xterm.js + ssh2 over WebSocket) | shipped |
| 9  | TUI Client (Bubble Tea) | shipped |
| 10 | Audit & Session Recording (asciinema) | shipped |
| 11 | RDP Support (Guacamole bridge) | shipped |
| 12 | Polish & Deployment (Dashboard, Settings, prod compose, metrics) | shipped |

## Contributing

Contributions are welcome. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

If you discover a security vulnerability, **do not open a public issue**. Please refer to [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

Shellius is licensed under the [GNU Affero General Public License v3.0](LICENSE).

Copyright 2026 YavLabs.
