<h1 align="center">Shellius</h1>

<h3 align="center">Self-hosted, certificate-based SSH and RDP access management for fleets</h3>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/version-0.2.0-green.svg" alt="Version" />
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
git clone https://github.com/yavlabs/shellius.git
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

This starts: PostgreSQL, Redis, `guacd` (RDP gateway), the backend API, the React frontend, and an Nginx reverse proxy.

### 4. Run database migrations

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec backend npx prisma migrate deploy
```

### 5. Create the initial super admin

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend node -e '
import("@prisma/client").then(async ({PrismaClient}) => {
  const bcrypt = (await import("bcryptjs")).default;
  const p = new PrismaClient();
  const org = await p.organization.upsert({
    where: { slug: "yavlabs" },
    update: {},
    create: { name: "Yavlabs", slug: "yavlabs", domain: "yavlabs.com" },
  });
  const hash = await bcrypt.hash("CHANGE_ME", 12);
  await p.user.upsert({
    where: { orgId_email: { orgId: org.id, email: "admin@yavlabs.com" } },
    update: { passwordHash: hash, role: "super_admin", status: "active" },
    create: { orgId: org.id, email: "admin@yavlabs.com", name: "Super Admin",
              passwordHash: hash, role: "super_admin", status: "active" },
  });
  await p.$disconnect();
});'
```

### 6. Access Shellius

Open `https://<your-host>` in your browser. Log in with the credentials you just created.

## TUI Client

Shellius ships with a Bubble Tea TUI for fast, terminal-native access.

### Install

```bash
cd tui
make build              # produces bin/shellius
sudo install -m 0755 bin/shellius /usr/local/bin/shellius

# Cross-compile for other platforms
make build-all          # bin/shellius-{linux,darwin,windows}-{amd64,arm64}
```

### First run

```bash
shellius --server https://shellius.example.com
```

The TUI will:

1. Hit `/api/auth/device/authorize` for a user code and verification URL
2. Open the URL in your default browser; you confirm the code while authenticated
3. Poll until approved, persist tokens to `~/.shellius/config.yaml`
4. Drop you into a fuzzy-searchable host list grouped by customer

After the first run, just type `shellius` -- tokens are refreshed automatically. Use `shellius --logout` to clear credentials.

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

All environment variables are documented in [`.env.prod.example`](.env.prod.example). The file is organized into sections:

- **Node.js** -- runtime mode and listen port
- **PostgreSQL** -- credentials and connection URL
- **Redis** -- cache and BullMQ
- **Auth / JWT** -- access and refresh token signing secrets
- **Encryption** -- `SERVER_ENCRYPTION_KEY` (CA + RDP) and `AGENT_SHARED_SECRET` (host agents)
- **Public URLs** -- `TRAEFIK_HOST`, `FRONTEND_URL`, `CORS_ORIGIN`, `PUBLIC_GATEWAY_HOST`
- **Recordings** -- on-disk path and retention window
- **Metrics** -- `METRICS_TOKEN` (Prometheus scrape protection)

SSO provider credentials are configured per-organization through the Settings page and stored encrypted in the database.

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
│       ├── pages/          # Dashboard, Servers, Customers, Users, Groups, Policies,
│       │                   # Certificates, AccessRequests, Sessions, AuditLog, Settings,
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
├── docs/                   # deployment.md (more under construction)
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
