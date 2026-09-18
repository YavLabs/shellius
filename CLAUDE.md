# Shellius — Centralized SSH/RDP Access Management Platform

## Overview

Shellius is a centralized SSH and RDP access management platform with short-lived certificate-based authentication, multi-cloud host discovery, manager approval workflows for production servers, and a companion TUI client. It replaces static SSH keys with a Certificate Authority model where access is policy-driven, time-limited, and fully audited.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20, Express, ES modules |
| Database | PostgreSQL 16, Prisma ORM |
| Cache/Queue | Redis 7, BullMQ |
| Frontend | React 18 (JavaScript only — NO TypeScript), Vite, Tailwind CSS, shadcn/ui, Lucide icons |
| TUI Client | Go 1.22+, Bubble Tea, Lipgloss, Bubbles |
| SSH CA | ssh-keygen (via child process), Ed25519 keys |
| RDP Gateway | Apache Guacamole (guacd) |
| Web Terminal | xterm.js + WebSocket + ssh2 |
| Auth | Passport.js (OIDC/SAML), JWT (access + refresh), Device Auth Flow (RFC 8628) |
| Cloud SDKs | @aws-sdk/client-ec2, @azure/arm-compute, @google-cloud/compute |
| Host Agent | Bash bootstrap script + systemd heartbeat timer |
| Infra | Docker, docker-compose, nginx, Traefik |

## Architecture Principles

1. **Zero static keys (default)** — SSH access to bootstrapped hosts uses short-lived certificates signed by the Shellius CA. The **Keystore** (stored identities/keys for non-bootstrapped hosts, key deployment, Quick Connect) is the one sanctioned exception — see `docs/keystore-and-quick-connect.md`. Keystore secrets are encrypted at rest, never returned by list/get APIs, and only decrypted at connect/deploy time or on an audited admin export.
2. **Prod requires approval below the org's bypass role** — `server.environment === 'prod'` requires manager approval for every requester UNLESS their role is at or above `Organization.settings.access.prodApprovalBypassMinRole` (`'admin'` default, or `'super_admin'` / `'none'`). A policy's `autoApprove` flag can never grant an unreviewed prod session to a requester below that role. Bypassed requests are still created (as `APPROVED`, reason required), audited (`access_request.prod_bypass`), and the server's approvers are notified after the fact — see `policyService.evaluate()` / `accessRequestService.submit()`.
3. **Real-time access validation** — Target hosts run `check-principals` which calls the Shellius API on every SSH connection to verify the cert is still valid and access hasn't been revoked.
4. **Multi-tenant via org_id scoping** — Every tenant-scoped table has `org_id`. All queries are scoped. Prisma middleware enforces this.
5. **Audit everything** — All read/write/access/revoke actions logged with actor, target, timestamp, IP. AuditLog is immutable (no UPDATE/DELETE).
6. **Cloud-native discovery** — Servers are auto-discovered from AWS/Azure/GCP via cloud connectors. On-prem servers self-register via bootstrap agent.
7. **Ephemeral credentials** — SSH private keys for download are generated per-request, never stored server-side. RDP credentials are injected via Guacamole, never exposed to users.

## Data Hierarchy

```
Organization (tenant)
  └── Customer (client/project — e.g., "Acme Corp", "Beta Inc")
       └── Server (SSH/RDP target, tagged with environment)
            └── Environment: demo | dev | staging | prod
```

## Directory Structure

```
shellius/
├── backend/
│   ├── prisma/             # Schema, migrations, seed
│   └── src/
│       ├── app.js          # Express entry point
│       ├── config/         # db, redis, auth, ca, guacamole
│       ├── middleware/     # auth, rbac, audit, tenant, rateLimiter, errorHandler
│       ├── routes/         # Express route handlers (thin — delegate to services)
│       ├── services/       # Business logic layer
│       ├── providers/      # Cloud sync adapters (aws, azure, gcp)
│       ├── utils/          # SSH key utils, cert utils, validators, crypto
│       └── jobs/           # BullMQ job processors
├── frontend/
│   └── src/
│       ├── components/     # ui/ (shadcn), domain components
│       ├── pages/          # Route-level page components
│       ├── hooks/          # Custom React hooks
│       ├── context/        # AuthContext, OrgContext, ThemeContext, NotificationContext
│       ├── services/       # Axios API client modules
│       └── utils/
├── tui/
│   ├── cmd/shellius/       # Go entry point
│   └── internal/           # auth, api, ssh, tui, config packages
├── scripts/
│   └── bootstrap.sh        # Host bootstrap (CA key, sshd config, agent setup)
├── docker/                 # Dockerfiles, nginx.conf
└── docs/                   # Architecture, deployment, API reference
```

## Coding Standards

### Backend (Node.js)
- ES modules everywhere (`import`/`export`, not `require`)
- Thin route handlers — all logic in service layer
- RBAC middleware on every route
- Audit middleware on every mutation
- org_id scoping on every query (enforced by tenant middleware)
- Response envelope: `{ success: true, data: {...}, meta: {...} }` or `{ success: false, error: { code, message } }`
- async/await only (no raw promises, no callbacks)
- Joi for request validation
- Winston for structured logging
- NEVER log sensitive data: private keys, passwords, cert contents, tokens

### Frontend (React)
- **JavaScript only** — `.js` and `.jsx` files. Never `.ts` or `.tsx`. No TypeScript.
- Functional components with hooks
- Tailwind CSS utilities only (no inline styles, no CSS modules)
- shadcn/ui for all UI primitives
- Lucide React for icons
- Axios in `services/` for API calls
- RBAC via `useAuth()` hook
- React.lazy + Suspense for code splitting
- UI aesthetic: Cloudflare / Linear / Vercel — clean, minimal, monochrome with accent colors

### TUI (Go)
- Go 1.22+
- Bubble Tea for TUI framework, Lipgloss for styling, Bubbles for common components
- Clean architecture: `cmd/` for entry, `internal/` for packages
- Config via `~/.shellius/config.yaml`
- Cross-compile: linux/darwin/windows, amd64/arm64

## Domain Concepts

- **Organization** — Top-level tenant boundary
- **Customer** — A client or project within the org. Servers belong to customers.
- **Server** — An SSH or RDP target machine with an environment tag (demo/dev/staging/prod)
- **CloudConnector** — Integration with AWS/Azure/GCP for auto-discovering servers
- **CaKeyPair** — The org's SSH Certificate Authority key pair (private key encrypted at rest)
- **AccessPolicy** — Rules defining who can access which servers, with what principals, for how long
- **AccessRequest** — Approval workflow record (pending → approved/denied → expired). Required for prod servers.
- **Certificate** — Short-lived SSH cert signed by the CA, bound to a user and server with expiry
- **Session** — An active or historical SSH/RDP connection with optional recording (`serverId` is null for Quick Connect sessions)
- **Credential ("Identity")** — Keystore entry: username + password and/or stored SshKey, reusable across servers with `authMode: credential`
- **SshKey** — Keystore key pair (generated or imported); can be deployed/rotated across hosts via **KeyDeployment**
- **AuditLog** — Immutable record of every action in the system

## Roles

`super_admin` > `admin` > `operator` > `viewer`

## Security Rules

- CA private key MUST be encrypted at rest (AES-256-GCM) and decrypted in memory only during signing
- SSH private keys for download are ephemeral — generated per request, returned to user, NEVER stored
- Cloud connector credentials MUST be encrypted at rest
- RDP passwords MUST never be exposed to the frontend — injected via Guacamole only
- check-principals on hosts validates every connection in real-time against the Shellius API
- Certificates auto-expire. Access requests auto-expire. No permanent access.
- Production servers require manager approval for every requester below the org's approval-bypass role (default: `admin`); the bypass role is admin-configurable (`GET`/`PUT /api/org/access-settings`, super_admin only) but never lets a policy silently grant unreviewed prod access to a lower role
- All audit log entries are immutable — no UPDATE or DELETE operations

## Important Warnings

- NEVER write TypeScript files (.ts, .tsx) — this project is JavaScript only
- NEVER log plaintext secrets, private keys, passwords, or certificate contents
- NEVER store SSH private keys server-side after returning them to the user (Keystore keys are the documented exception: encrypted, admin-managed, never in list/get responses)
- NEVER skip org_id scoping on database queries
- NEVER allow direct production server access without approval flow for a requester below the org's `prodApprovalBypassMinRole` (applies to certificate AND credential servers; Quick Connect refuses hosts matching a saved prod server). Requesters at/above the bypass role still get an audited, notified `APPROVED` request — never a silent, unaudited connection.
- NEVER hard-delete cloud-terminated servers — mark as terminated to preserve audit trail
