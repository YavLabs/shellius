# Deployment Guide

Operator-facing guide for running Shellius in production: architecture,
environment variables, first deployment, upgrading an existing deployment
without losing data, a Coolify-specific walkthrough, troubleshooting, and a
security hardening checklist.

See also: [`docs/sso-configuration.md`](./sso-configuration.md),
[`docs/smtp-configuration.md`](./smtp-configuration.md),
[`docs/auth-hardening.md`](./auth-hardening.md),
[`docs/keystore-and-quick-connect.md`](./keystore-and-quick-connect.md),
[`docs/terminal-workspace.md`](./terminal-workspace.md).

---

## 1. Architecture overview

```
                       ┌───────────────────────────┐
   users/browsers ───► │  nginx (or Traefik/Coolify) │ ── TLS termination
   TUI / bootstrap ───►│  reverse proxy              │
                       └────────────┬────────────────┘
                                    │
                  ┌─────────────────┼─────────────────┐
                  ▼                 ▼                 ▼
           ┌────────────┐   ┌──────────────┐   ┌─────────────┐
           │  frontend  │   │   backend    │   │   guacd     │
           │ (nginx +   │   │ (Node/Express│◄─►│ (Guacamole  │
           │  static    │   │  + WebSocket)│   │  daemon,    │
           │  React)    │   │              │   │  RDP only)  │
           └────────────┘   └──────┬───────┘   └─────────────┘
                                    │
                  ┌─────────────────┼─────────────────┐
                  ▼                 ▼                 ▼
           ┌────────────┐   ┌──────────────┐   ┌─────────────────┐
           │ PostgreSQL │   │    Redis     │   │ Object storage   │
           │ (primary   │   │ (BullMQ jobs,│   │ MinIO / S3 /     │
           │  data)     │   │  tickets,    │   │ Azure Blob       │
           │            │   │  SSO state)  │   │ (recordings)     │
           └────────────┘   └──────────────┘   └─────────────────┘
```

**Components**

| Component | What it is | Required? |
|---|---|---|
| `backend` | Node 20 / Express API + WebSocket terminal/RDP proxy | Yes |
| `frontend` | Vite-built React SPA, served by its own nginx | Yes |
| `postgres` | PostgreSQL 16, primary datastore | Yes (bundled or external — `DATABASE_URL`) |
| `redis` | Redis 7, BullMQ job queues, Quick Connect tickets, SSO state, MFA rate limiting | Yes (bundled or external — `REDIS_URL`) |
| `guacd` | Apache Guacamole daemon | Only if you have RDP servers |
| `minio` / S3 / Azure Blob | Session recording storage | Recommended (falls back to local disk `RECORDINGS_DIR` otherwise, which does **not** survive container recreation) |
| `nginx` (bundled) or Traefik / Coolify proxy | TLS termination + reverse proxy | Yes, one of these |

**Ports** (container-internal unless noted): backend `3001`, frontend/nginx
`80`, postgres `5432`, redis `6379`, guacd `4822`, minio `9000`/`9001`. In
`docker-compose.prod.yml` and `docker-compose.coolify.yml` none of these are
published to the host — only the `nginx` service (or, on Coolify, whichever
service you attach a domain to) is reachable from outside the Docker network.

**What must be reachable / configured correctly**

- **WebSocket upgrade for `/api/terminal/*`** (`/api/terminal/ssh`,
  `/api/terminal/rdp`) — the web terminal, RDP viewer, and the new Terminals
  workspace (detach/reattach, Quick Connect redemption) all depend on this.
  If your proxy doesn't forward the `Upgrade`/`Connection` headers, the UI
  gets stuck on "Connecting…". Every bundled nginx config
  (`docker/nginx.conf`, `docker/nginx-proxy.conf`, `docker/nginx-deploy.conf`)
  already sets this up correctly; if you front Shellius with your own proxy,
  copy the `location` blocks for `/api/terminal/` from one of those files.
- **Sticky sessions for `/api/terminal/*` if you run more than one backend
  replica.** The terminal hub that powers detachable sessions
  (`terminalHub.js`) keeps live SSH connections **in-process, in memory**.
  Reattaching to a session only works if the WebSocket lands back on the
  same backend container that owns it. Single-replica deployments (the
  default, and what every compose file here runs) don't need to think about
  this at all. If you scale `backend` horizontally, add IP-hash or
  cookie-based sticky routing for `/api/terminal/*` at your load balancer —
  there's no cross-instance session handoff yet.
- Outbound network access from `backend` to every target SSH/RDP host, and
  from target hosts back to `backend` on `/api/certificates/verify`
  (check-principals) if you use certificate-based (bootstrapped) servers.

---

## 2. Prerequisites

- Docker Engine 24+ and Docker Compose v2 (`docker compose version`)
- A domain name with DNS pointing at your host (HTTPS strongly recommended)
- Outbound internet access from the host that pulls images from Docker Hub
  (`yavadmin/shellius-backend`, `yavadmin/shellius-frontend`) unless you build
  from source (`docker-compose.yml` / `docker-compose.deploy.yml`)

---

## 3. Environment variables reference

Generate every secret with `openssl rand -hex 32` (or `-hex 16` for
`METRICS_TOKEN`) — never reuse example/default values in production; the
backend refuses to start in `NODE_ENV=production` with default JWT secrets.

Legend: **Secret** = treat like a password (mark "is secret" in your
platform's env var UI, never commit it). Full precedent copies live in
[`.env.example`](../.env.example) (dev) and
[`.env.prod.example`](../.env.prod.example) (production).

### Core

| Variable | Required | Default | Secret? | Description |
|---|---|---|---|---|
| `NODE_ENV` | Yes | `development` | No | Set `production` for deployments — enables the default-secret refusal check and disables verbose stack traces |
| `PORT` | No | `3001` | No | Backend HTTP/WebSocket port |
| `TRAEFIK_HOST` | Recommended | — | No | Public hostname; derives CORS origin, frontend URL, and SSO callback base when set |
| `PUBLIC_BASE_URL` | No | derived from `TRAEFIK_HOST` | No | Explicit public base URL override (links in emails, CORS, terminal WebSocket origin check) |
| `APP_URL` | No | derived from `TRAEFIK_HOST` | No | Public URL of the web app. Used for every link that opens an app page (invite, password-reset, email-verify and approval links, the SSO redirect URI) and as the default CORS origin. Takes precedence over `PUBLIC_BASE_URL` / `FRONTEND_URL`. Links are never built from request headers |
| `PUBLIC_API_URL` | No | derived | No | Explicit absolute API URL (bootstrap script, invite links) when not using `TRAEFIK_HOST` |
| `PUBLIC_GATEWAY_HOST` | No | `localhost` | No | Hostname RDP clients use to reach the WebSocket gateway |
| `CORS_ORIGIN` | No | derived from `TRAEFIK_HOST` | No | Explicit CORS origin override |
| `FRONTEND_URL` | No | derived | No | Explicit frontend URL override |
| `TRUST_PROXY` | Recommended in prod | — | No | Trusted proxy hop count for correct client IP (rate limiting, audit logs); `1` for the bundled proxy |
| `COMPOSE_PROFILES` | No | `postgres,redis,minio` | No | Which bundled containers to start (compose-only, not read by the app) |

### Database & cache

| Variable | Required | Default | Secret? | Description |
|---|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | Yes (contains password) | Postgres connection string. Env-only — not configurable from the UI (bootstrap-critical) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Yes, if using the bundled `postgres` container | — | `POSTGRES_PASSWORD` yes | Used only by the bundled Postgres container |
| `REDIS_URL` | **Yes** | `redis://redis:6379` | Only if it embeds a password | Redis connection string — BullMQ jobs, Quick Connect tickets, SSO state, MFA attempt limiting, terminal hub bookkeeping |

### Secrets (rotate/generate these, never leave the example values)

| Variable | Required | Default | Secret? | Description |
|---|---|---|---|---|
| `JWT_SECRET` | **Yes** | — | **Yes** | Signs access tokens + MFA challenge tokens (HKDF-derived). `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | **Yes** | — | **Yes** | Signs refresh tokens. `openssl rand -hex 32` |
| `JWT_EXPIRY` | No | `15m` | No | Access token lifetime. `8h` recommended for self-hosted single-team use |
| `JWT_REFRESH_EXPIRY` | No | `7d` | No | Refresh token lifetime. `30d` recommended for self-hosted single-team use |
| `SESSION_ABSOLUTE_TTL` | No | `2592000` (30d) | No | Absolute refresh-token-family lifetime in seconds, independent of rotation |
| `SERVER_ENCRYPTION_KEY` | **Yes** | — | **Yes, critical** | AES-256-GCM key protecting the CA private key, stored Keystore credentials, RDP passwords, cloud connector secrets, and SMTP passwords at rest. `openssl rand -hex 32`. **See the warning below — never change this without a re-encryption migration.** |
| `AGENT_SHARED_SECRET` | No (legacy fallback only) | — | **Yes** | Legacy fleet-wide secret from before per-host agent tokens. Every bootstrapped host now gets its own token, minted at `install.sh`/`install.ps1` generation and stored hashed on `Server.agentTokenHash` — `AGENT_SHARED_SECRET` is no longer required for new installs. Only set this if you still have hosts that haven't been re-bootstrapped with `--upgrade`; see §5 "Upgrade notes: per-host agent tokens". `openssl rand -hex 32` |
| `AGENT_LEGACY_SHARED_SECRET` | No | `warn` | No | Governs whether `AGENT_SHARED_SECRET` is still accepted from hosts that haven't been re-bootstrapped: `warn` (default this release) accepts it and logs a rate-limited deprecation warning + `x-shellius-agent-deprecated: 1` response header; `deny` rejects it outright (401). **Will default to `deny` in the next release** — re-bootstrap all hosts (`--upgrade`) before then. |
| `METRICS_TOKEN` | No | — (endpoint disabled if unset) | **Yes** | Bearer token for `GET /api/metrics`. `openssl rand -hex 16` |

> **`SERVER_ENCRYPTION_KEY` must never change once you have real data.**
> Every secret it protects (CA private key, Keystore identities/keys, RDP
> passwords, cloud connector credentials, SMTP password) becomes permanently
> unreadable if the key changes without a decrypt-then-re-encrypt migration.
> **Back it up somewhere separate from your database backup** — if you lose
> both together, you lose the ability to decrypt anything, even with a valid
> `pg_dump` restore.

### Security / hardening

| Variable | Required | Default | Secret? | Description |
|---|---|---|---|---|
| `SSH_TARGET_ALLOW_LOOPBACK` | No | `false` | No | Allow outbound SSH (web terminal, Quick Connect, key deployment) to loopback targets. **Never `true` in production** — dev-only, for SSHing into throwaway containers on the same host |
| `AUTH_LOCKOUT_THRESHOLD` | No | `5` | No | Consecutive failed local logins before a temporary lock |
| `AUTH_LOCKOUT_MINUTES` | No | `15` | No | Lockout duration |
| `MFA_ENABLED` / `MFA_ENFORCED` | No | `false` / `false` | No | Org-wide MFA defaults (a super_admin can override per-org from Administration → Two-factor) |
| `MFA_ALLOW_TOTP` / `MFA_ALLOW_EMAIL_OTP` | No | `true` / `true` | No | Which MFA methods are offered |
| `MFA_ISSUER` | No | `Shellius` | No | TOTP issuer label shown in authenticator apps |

### SSO (optional — prefer Administration → Single sign-on for multi-provider setups)

| Variable | Required | Default | Secret? | Description |
|---|---|---|---|---|
| `SSO_ALLOWED_DOMAINS` | No | any | No | Comma-separated allow-list for env-preset providers |
| `SSO_DEFAULT_ROLE` | No | `viewer` | No | Role assigned on JIT provisioning (never `super_admin`) |
| `SSO_AUTO_PROVISION` | No | `true` | No | Auto-create users on first SSO login |
| `SSO_GOOGLE_CLIENT_ID` / `SSO_GOOGLE_CLIENT_SECRET` | No | — | Secret | Google OIDC preset |
| `SSO_ENTRA_TENANT_ID` / `SSO_ENTRA_CLIENT_ID` / `SSO_ENTRA_CLIENT_SECRET` | No | — | Secret | Microsoft Entra ID preset |
| `SSO_OKTA_DOMAIN` / `SSO_OKTA_CLIENT_ID` / `SSO_OKTA_CLIENT_SECRET` | No | — | Secret | Okta preset |
| `SSO_AUTH0_DOMAIN` / `SSO_AUTH0_CLIENT_ID` / `SSO_AUTH0_CLIENT_SECRET` | No | — | Secret | Auth0 preset |
| `SSO_CLIENT_ID` / `SSO_CLIENT_SECRET` / `SSO_ISSUER_URL` | No | — | Secret | Generic OIDC or GitHub (incl. GitHub Enterprise Server via `SSO_ISSUER_URL`) preset |

Full details: [`docs/sso-configuration.md`](./sso-configuration.md) and the
"Revision 2" section of [`docs/auth-hardening.md`](./auth-hardening.md).

### Email

Email providers (SMTP, Google / Gmail API, Microsoft 365 via Graph, SendGrid,
Mailgun, Postmark, Resend) are configured per org in **Administration → Email** — no
environment variables needed, no restart. The `SMTP_*` variables below are
only the fallback used when an org has no active provider; without them (and
without a provider) Shellius runs in log-only mode. See
[`docs/email-delivery.md`](./email-delivery.md).

| Variable | Required | Default | Secret? | Description |
|---|---|---|---|---|
| `SMTP_HOST` | No (log-only mode without it or a provider) | — | No | SMTP server hostname |
| `SMTP_PORT` | No | `587` | No | SMTP port |
| `SMTP_USER` | No | — | No | SMTP username |
| `SMTP_PASS` | No | — | **Yes** | SMTP password |
| `SMTP_FROM` | No | `SMTP_USER` if an address | No | From address |
| `SMTP_FROM_NAME` | No | — | No | From display name |
| `SMTP_SECURITY` | No | TLS on 465, else STARTTLS if offered | No | `none` \| `starttls` \| `tls` |
| `SMTP_SECURE` | No | `true` | No | Legacy; only used when `SMTP_SECURITY` is unset |
| `SSO_GOOGLE_CLIENT_ID` / `SSO_GOOGLE_CLIENT_SECRET` | No | — | Secret | Also the default OAuth client for a Google email provider |

The Google email provider's OAuth redirect URI is
`https://<host>/api/settings/email/google/callback` (derived from `APP_URL` /
`TRAEFIK_HOST`). Email headers load the logo from
`<app URL>/brand/png/shellius-lockup-dark-bg-640x128.png`, so set `APP_URL` or
`TRAEFIK_HOST` to the public URL.

### Object storage (session recordings)

| Variable | Required | Default | Secret? | Description |
|---|---|---|---|---|
| `STORAGE_PROVIDER` | No | `minio` if `MINIO_ENDPOINT` set | No | `minio` \| `s3` \| `azure` |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_RECORDINGS_BUCKET` | If using MinIO | — | Keys: **Yes** | Bundled/self-hosted S3-compatible storage |
| `STORAGE_REGION` / `STORAGE_BUCKET` / `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` / `STORAGE_ENDPOINT` | If using S3 | falls back to `AWS_*` | Keys: **Yes** | AWS S3 or S3-compatible |
| `AZURE_STORAGE_ACCOUNT` / `AZURE_STORAGE_KEY` / `AZURE_STORAGE_CONTAINER` / `AZURE_BLOB_ENDPOINT` | If using Azure | — | Key: **Yes** | Azure Blob Storage |
| `RECORDINGS_DIR` | No | `./data/recordings` | No | Local-disk fallback when no provider is configured — **not durable across container recreation**, recommended for dev only |
| `RECORDING_RETENTION_DAYS` | No | `90` | No | Session recordings older than this are pruned by the hourly cleanup job |

Can be overridden at runtime from Administration → Storage by a super_admin (DB
wins over env, no restart).

### Background jobs / terminal workspace

| Variable | Required | Default | Description |
|---|---|---|---|
| `KEY_DEPLOYMENT_CONCURRENCY` | No | `5` | BullMQ concurrency for key deployment/rotation jobs |
| `ONBOARDING_CONCURRENCY` | No | `5` | BullMQ concurrency for server onboarding jobs |
| `TERMINAL_DETACH_TTL_SECONDS` | No | `900` (15 min) | How long a detached terminal session survives before it's force-ended |

### First-boot seed (idempotent — safe to leave set permanently)

| Variable | Required | Description |
|---|---|---|
| `SEED_ORG_NAME` / `SEED_ORG_SLUG` / `SEED_ORG_DOMAIN` | For first boot | Bootstrap organization |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_NAME` / `SEED_ADMIN_PASSWORD` | For first boot | Bootstrap super_admin. **Change the password after first login.** |

### Frontend (build-time, `VITE_*`)

| Variable | Required | Description |
|---|---|---|
| `VITE_API_URL` | No | Overrides the API base URL baked into the frontend build (default `/api`, works behind the bundled proxy) |
| `VITE_GIT_SHA` | No | Short git SHA baked into the build for the footer's version tooltip (set automatically by CI/Docker build args) |
| `VITE_BRAND_NAME` / `VITE_BRAND_LOGO_URL` / `VITE_BRAND_LOGO_SHORT_URL` | No | White-label branding |

`VITE_*` variables are compiled into the static JS bundle at `docker build`
time — changing them requires rebuilding the frontend image, not just
restarting the container.

---

## 4. Fresh deployment

Pick the compose file that matches your setup:

| File | When to use it |
|---|---|
| `docker-compose.yml` | Local dev / single-host from-source build, host ports published (`localhost:3001`, `:80`, `:5432`, ...) |
| `docker-compose.prod.yml` | Production, **pre-built images from Docker Hub**, Traefik labels for an external Traefik on a shared network, no host ports published |
| `docker-compose.deploy.yml` | Production, **builds from source**, single host behind your own external reverse proxy (e.g. Nginx Proxy Manager), tailored example for an external/managed Postgres |
| `docker-compose.coolify.yml` | Coolify "Docker Compose" resource — see §6 |
| `docker-compose.allinone.yml` | Production with the **single all-in-one image** (web UI + API + nginx in one container) — see §4.0 |
| `docker-compose.dev.yml` | Infra-only (Postgres + Redis + guacd) for running `backend`/`frontend` with `npm run dev` outside Docker |

### 4.0 All-in-one image (`yavadmin/shellius`)

One container holds the web UI, the API and nginx. It's the simplest way to run Shellius
anywhere you can run a single container: a VM, Coolify, Render, ECS, Kubernetes.

| Image | Compressed | On disk | Contains |
|---|---|---|---|
| `yavadmin/shellius` (all-in-one) | ~93 MB | ~405 MB | UI + API + nginx |
| `yavadmin/shellius-backend` | ~156 MB | ~720 MB | API |
| `yavadmin/shellius-frontend` | ~29 MB | ~105 MB | UI (nginx) |

The all-in-one image is smaller than the backend image alone. It installs production
dependencies only (plus the Prisma CLI for migrations) and ships only the native Postgres query
engine. It also drops npm/yarn from the runtime and strips source maps and type declarations.

**What runs inside:**
- `tini` (PID 1) → `shellius-start`, which runs `prisma migrate deploy` (required) and the
  idempotent seed (soft-fail), then starts the API on `127.0.0.1:3001` and nginx on **`:8080`**.
- nginx serves the SPA from disk and proxies `/api` (REST and the terminal WebSockets) to the
  API. Hashed assets are cached for a year, `index.html` is never cached, responses are gzipped,
  and access logs go to stdout without query strings.
- If either process exits, the other is stopped and the container exits non-zero, so your
  restart policy brings the whole unit back. `docker stop` forwards SIGTERM, and the API ends
  live terminal sessions cleanly.
- Everything runs as the unprivileged `app` user (uid 1001).
- The built-in healthcheck calls `GET /api/health` through nginx, so it covers both processes.

**Still separate:** PostgreSQL, Redis, and optionally MinIO/S3 (recordings) and guacd (RDP),
exactly as with the two-image setup. The env vars are the same `.env.prod` (§3).

```bash
cp .env.prod.example .env.prod          # fill every <CHANGE_ME>
docker compose -f docker-compose.allinone.yml --env-file .env.prod up -d
# → http://<host>:8080
```

Or without compose, against managed Postgres/Redis:

```bash
docker run -d --name shellius -p 8080:8080 --env-file .env.prod \
  -e GUACD_HOST=guacd.internal \
  --restart unless-stopped yavadmin/shellius:latest
```

> `docker run --env-file` does **not** strip quotes: `SEED_ADMIN_NAME="Jane Doe"` arrives with
> the quotes included. Write values unquoted in that file. (Compose's `env_file` and dotenv do
> strip them. The seed strips one pair of outer quotes from `SEED_*` values either way, but other
> settings such as SMTP names would keep them.)

**Behind a TLS proxy** (Traefik, Caddy, Coolify, a cloud load balancer), point it at port 8080
and set:
- `TRAEFIK_HOST=shellius.example.com`. Despite the name, it works behind any proxy: the bare
  hostname derives the public URL, CORS, SSO callbacks, host install links and the terminal
  WebSocket origin check. Alternatively, set `PUBLIC_BASE_URL` and `PUBLIC_API_URL` explicitly.
- `TRUST_PROXY=2`, because there are two hops (your proxy, then the bundled nginx) before the
  API. This lets rate limiting and audit logs see real client IPs. Leave it unset if clients
  hit the container directly.

In **Coolify**, create an "Application" from the Docker image `yavadmin/shellius`, set the port
to `8080`, and add the §3 env vars. Postgres and Redis can be Coolify databases.

Build it yourself: `docker build -f docker/Dockerfile.allinone -t shellius:local .` (about
1 minute; BuildKit caches npm downloads between builds).

Single process only: live SSH sessions are held in the API's memory, so run **one** replica
(same as the backend image).

### 4.1 Using `docker-compose.prod.yml` (recommended for most self-hosters)

```bash
git clone https://github.com/YavLabs/shellius.git && cd shellius

cp .env.prod.example .env.prod
# Edit .env.prod: fill every <CHANGE_ME>, set TRAEFIK_HOST.
# Generate secrets:
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # JWT_REFRESH_SECRET
openssl rand -hex 32   # SERVER_ENCRYPTION_KEY  -- back this up!
openssl rand -hex 32   # AGENT_SHARED_SECRET
openssl rand -hex 16   # METRICS_TOKEN

docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
docker compose -f docker-compose.prod.yml ps   # wait for "healthy"
```

Migrations and the idempotent seed (bootstrap org + super_admin + baseline
groups/policies) run **automatically on container start** —
`docker/entrypoint-backend.sh` runs `npx prisma migrate deploy`, then
`node prisma/seed.js` (soft-fail: a seed error logs a warning but does not
block the API from starting), then execs the server. No manual migration
step is required for a fresh deployment.

Log in at `https://<TRAEFIK_HOST>` with `SEED_ADMIN_EMAIL` /
`SEED_ADMIN_PASSWORD`, then **change that password immediately** from
Profile → Change password.

If you don't run Traefik, either put the bundled `nginx` service (already in
`docker-compose.prod.yml`) behind your own TLS-terminating proxy, or adapt
`docker-compose.deploy.yml`, which is a self-contained example with its own
`nginx` doing TLS-adjacent reverse proxying on a host port.

### 4.2 TLS / reverse proxy

- **Traefik**: `docker-compose.prod.yml`'s `nginx` service already carries
  `traefik.*` labels for an HTTP entrypoint on a shared `homelab` network —
  adjust the network name and add your certresolver/entrypoint for HTTPS.
- **Your own nginx / Nginx Proxy Manager / Caddy**: proxy to the `nginx`
  container's port 80, and make sure WebSocket upgrade headers are forwarded
  for `/api/terminal/` (see §1). `docker-compose.deploy.yml` +
  `docker/nginx-deploy.conf` is a working example of this pattern (publishes
  port `8100` on the host for an external proxy to target).

### 4.2.1 Access logs on a proxy you run yourself

Two kinds of URL carry a credential in the query string:

| URL | Parameter | Lifetime |
|-----|-----------|----------|
| `/api/terminal/ws` (terminal WebSocket) | `t` | single use, 30 seconds |
| `/api/bootstrap/install.sh`, `install.ps1`, `uninstall.sh` | `token` | single use, expires after the link TTL |

Both are **single-use**. Once the browser has connected, or the host has
downloaded its install script, replaying the logged URL gets `4401` (terminal)
or `410 LINK_ALREADY_USED` (bootstrap). A leaked log line therefore can't open a
session or re-run an install. Still, credentials don't belong in logs, and an
unused install link can still be spent by whoever reads it first.

The bundled nginx configs (`docker/nginx*.conf`) already log `$uri` without
the query string (`log_format shellius_redacted`). **A proxy in front of them
has its own access log, and you need to configure that one too:**

- **Traefik (including Coolify's proxy)**: access logs are **off by default**.
  If you turn them on (`--accesslog=true`), also drop the request path,
  because Traefik's `RequestPath` field includes the query string and has no
  query-only filter:

  ```yaml
  # Traefik static config (CLI flags shown; same keys in traefik.yml)
  - --accesslog=true
  - --accesslog.format=json
  - --accesslog.fields.names.RequestPath=drop
  - --accesslog.fields.headers.defaultmode=drop   # default, keep it
  ```

  The nginx container behind Traefik still logs the path without the query,
  so you don't lose per-route visibility. In Coolify these flags go under
  **Servers → your server → Proxy → Configuration** (the proxy's own compose
  `command:` list), not on the Shellius resource.
- **Caddy (2.8+)**: filter the query parameters out of the logged URI:

  ```caddy
  shellius.example.com {
    reverse_proxy nginx:80
    log {
      format filter {
        request>uri query {
          delete t
          delete token
        }
      }
    }
  }
  ```
- **nginx / Nginx Proxy Manager**: use a `log_format` that logs `$uri`
  rather than `$request` or `$request_uri`, like the bundled configs:

  ```nginx
  log_format shellius_redacted '$remote_addr - $remote_user [$time_local] '
                               '"$request_method $uri $server_protocol" $status $body_bytes_sent '
                               '"$http_referer" "$http_user_agent" $request_time';
  access_log /var/log/nginx/access.log shellius_redacted;
  ```

  In Nginx Proxy Manager, put the `access_log` line in the proxy host's
  **Advanced** tab. The `log_format` has to be defined at `http` level
  (`/data/nginx/custom/http_top.conf`).
- **Cloud load balancers / CDNs** (AWS ALB, Cloudflare, etc.) log full
  request URLs when access logging is enabled. Limit who can read those
  logs, or exclude `/api/terminal/ws` and `/api/bootstrap/`.

### 4.3 Health checks

Every service in `docker-compose.prod.yml` / `docker-compose.coolify.yml`
declares a Docker healthcheck. Wait for `healthy` before routing traffic:

```bash
docker compose -f docker-compose.prod.yml ps
curl -sf https://<your-host>/api/health | jq
# { "success": true, "data": { "status": "ok", "version": "1.1.0", "db": "connected", "redis": "connected", ... } }
```

---

## 5. Upgrading an existing deployment without losing data

**Always back up first:**

```bash
# 1. Database
./scripts/backup-db.sh
# or directly:
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > backup-$(date +%Y%m%d-%H%M%S).sql.gz

# 2. Session recordings (MinIO bundled)
./scripts/backup-recordings.sh
# or, for S3/Azure, use your provider's own backup/versioning.

# 3. Your .env / .env.prod file — especially SERVER_ENCRYPTION_KEY.
#    Losing this key makes every encrypted secret in the DB permanently
#    unreadable, even with a perfect pg_dump restore.
cp .env.prod .env.prod.bak-$(date +%Y%m%d)
```

**Then upgrade:**

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
# migrate deploy + seed run automatically via docker/entrypoint-backend.sh
docker compose -f docker-compose.prod.yml ps          # wait for healthy
curl -sf https://<your-host>/api/health | jq .data.version
```

If you pin a version (`SHELLIUS_VERSION=1.1.0` in `.env.prod`), bump it
before `pull`.

### Gap-fill migrations for older installs

Some early deployments were created with `prisma db push` before this
project had a real migration chain — their schema matches an old version of
`schema.prisma` but has no row in Prisma's `_prisma_migrations` table.
`prisma migrate deploy` refuses to run against a database it doesn't
recognize as being on a known migration state ("drift detected").

**Safe procedure:**

1. Check for drift first, without applying anything:
   ```bash
   docker compose -f docker-compose.prod.yml exec backend \
     npx prisma migrate status
   ```
   If it reports "Database schema is up to date!" or lists only pending
   migrations, just run `migrate deploy` normally — you're not in the gap-fill
   case.

2. If it reports drift, diff the live DB against what the migration chain
   expects, to see exactly what's different, before touching anything:
   ```bash
   docker compose -f docker-compose.prod.yml exec backend \
     npx prisma migrate diff \
       --from-url "$DATABASE_URL" \
       --to-migrations prisma/migrations \
       --shadow-database-url "$DATABASE_URL" \
       --script
   ```

3. If the diff is empty or only shows objects the migration chain already
   contains (i.e. your DB really does match an earlier known-good schema,
   just without migration bookkeeping), baseline it by marking every
   migration up to that point as already applied, **without running their
   SQL**:
   ```bash
   docker compose -f docker-compose.prod.yml exec backend sh -c '
     for d in prisma/migrations/*/; do
       name=$(basename "$d")
       npx prisma migrate resolve --applied "$name"
     done'
   ```
   Then run `npx prisma migrate deploy` normally — anything genuinely new
   applies on top of the baseline.

4. Before doing this against a real production database, validate the
   procedure against a throwaway copy. `backend/scripts/verify-migrations.sh`
   (`npm --prefix backend run db:verify-migrations`) automates exactly this
   check in CI-style form: it spins up a disposable Postgres 16 container and
   proves `prisma migrate deploy` produces a byte-identical schema from (a) an
   empty database, (b) a database baselined from `main`'s schema with
   `main`'s migrations marked applied, and (c) a database with every current
   migration already marked applied. Run it locally against your own schema
   dump if you want extra confidence before touching production.

5. If in doubt, restore the backup from step 1 into a scratch database and
   rehearse the whole upgrade there first.

### Rollback procedure

```bash
# Stop the stack
docker compose -f docker-compose.prod.yml down

# Restore the database
gunzip -c backup-<timestamp>.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" "$POSTGRES_DB"

# Pin the previous image tag in .env.prod
echo "SHELLIUS_VERSION=1.0.2" >> .env.prod

docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

### Post-upgrade checks

- [ ] `GET /api/health` returns `data.version` matching the new release
- [ ] Log in works (including SSO if configured)
- [ ] Open a web terminal to an SSH server — the WebSocket connects (not
      stuck on "Connecting…")
- [ ] One real SSH connection to a target host succeeds end-to-end
- [ ] `docker compose ps` shows every service `healthy`

### Version-specific notes: 0.3.x/1.0.x → 1.1.0

- **Everyone must sign in again.** Access tokens are now typed and existing
  tokens are rejected post-upgrade; there is no in-place token migration.
  This is expected — it is not a sign of a broken upgrade.
- New tables: Keystore (`SshKey`, `Credential`, `KeyDeployment`), Quick
  Connect (`QuickConnectHistory`), multi-provider SSO
  (`SsoConfig`/`UserIdentity`). All created by `prisma migrate deploy`
  automatically.
- New required behavior: your reverse proxy must forward WebSocket upgrades
  for `/api/terminal/*` (see §1) — this was already needed for the plain web
  terminal, but the Terminals workspace and Quick Connect now depend on it
  more broadly.
- Existing single-provider SSO configuration migrates to the new
  multi-provider model automatically on first read; no manual action needed.
- See `CHANGELOG.md`'s `[1.1.0]` section for the full list of new environment
  variables and breaking changes.

### Upgrade notes: per-host agent tokens

Every target host used to share one org-wide `AGENT_SHARED_SECRET` for
`check-principals` cert verification and heartbeat. Each host now gets its
own token instead (hash-only, stored on `Server.agentTokenHash`), and
`POST /api/certificates/verify` now checks that a certificate was actually
issued **for the specific host asking** — closing a gap where a certificate
approved for one server (e.g. dev) could also authenticate on any other
server in the org, including production.

1. **No action is required immediately** — `AGENT_LEGACY_SHARED_SECRET`
   defaults to `warn` this release, so hosts still running the old shared
   secret keep working (with a logged deprecation warning) until you
   re-bootstrap them.
2. **Re-bootstrap every host** to mint its per-host token: open the server in
   Shellius → **Bootstrap** → copy the one-liner it gives you → append
   `-s -- --upgrade` before running it, e.g.:
   ```bash
   curl -fsSL "<install-url-from-the-Bootstrap-panel>" | sudo bash -s -- --upgrade
   ```
   `--upgrade` only rewrites the agent token + check-principals script; it
   does not touch CA trust or sshd config, so it's safe to run any time.
   ServerDetail shows a "Deprecated shared agent token" notice on any host
   still in legacy mode.
3. Once every host is re-bootstrapped, you may remove `AGENT_SHARED_SECRET`
   from `.env.prod` entirely, or set `AGENT_LEGACY_SHARED_SECRET=deny` to cut
   over immediately without waiting for the next release's default flip.
4. **The next release will default `AGENT_LEGACY_SHARED_SECRET` to `deny`.**
   Any host not yet re-bootstrapped by then will lose SSH access (cert
   verification and heartbeats will 401) until you run `--upgrade` on it.

---

## 6. Coolify

Deploy Shellius as a Coolify **"Docker Compose"** resource using
[`docker-compose.coolify.yml`](../docker-compose.coolify.yml) — a variant of
`docker-compose.prod.yml` with host port bindings and hand-written Traefik
labels removed (Coolify manages its own proxy and would conflict with both).

### 6.1 Create the resource

1. **New Resource → Docker Compose**, paste in / point at
   `docker-compose.coolify.yml`.
2. Coolify parses the services; it will offer to let you pick which service(s)
   get a public domain. Choose **`nginx`**, port `80`.

### 6.2 Environment variables

Add every variable from §3 as an **Environment Variable** on the resource
(Coolify's UI lets you mark each as a secret — do this for every row marked
**Secret** in the tables above). At minimum: `TRAEFIK_HOST` (set it to the
domain Coolify will assign, or your own), `DATABASE_URL` (or `POSTGRES_*` if
using the bundled Postgres), `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
`SERVER_ENCRYPTION_KEY`, `AGENT_SHARED_SECRET`, `METRICS_TOKEN`,
`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`, `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`
(if using bundled MinIO).

### 6.3 Domain + HTTPS

Open the `nginx` service in the resource → **Domains** → set your hostname
(e.g. `shellius.example.com`). Coolify's built-in Traefik instance issues and
renews the TLS certificate automatically. Alternatively, uncomment the
`SERVICE_FQDN_NGINX_80` environment line in
`docker-compose.coolify.yml` and set it as an env var on the resource —
Coolify will wire up the Traefik label for you from that magic variable
instead of the UI setting.

### 6.4 WebSocket support

Coolify's bundled Traefik proxies WebSockets transparently for HTTP(S)
services by default — no extra label is normally needed for
`/api/terminal/*` to work, since the upgrade happens over the same domain
Coolify already routes. If you find the terminal stuck on "Connecting…",
double check:

- The `nginx` service (not `backend` directly) is the one with the domain
  attached — `nginx` is what forwards `Upgrade`/`Connection` headers to
  `backend` (see `docker/nginx-proxy.conf`).
- You haven't added a custom Traefik middleware that strips the `Upgrade`
  header (e.g. some aggressive compression or buffering middlewares do this).

**Access logs:** Coolify's Traefik has access logging off by default. If you
turn it on, add `--accesslog.fields.names.RequestPath=drop` too, because
Traefik logs the query string, which includes single-use terminal tickets
and install tokens. See §4.2.1.

### 6.5 Persistent storage

The named volumes in `docker-compose.coolify.yml` (`postgres_data`,
`redis_data`, `minio_data`) are persisted by Coolify the same way as any
other Compose resource — no extra configuration needed. Confirm this in the
resource's **Storages** tab after first deploy.

### 6.6 Migrations & seeding

Automatic — `docker/entrypoint-backend.sh` runs `prisma migrate deploy` then
the idempotent seed on every container start, same as any other compose file.
Nothing Coolify-specific to do here.

### 6.7 Updating

Set `SHELLIUS_VERSION` as an env var on the resource (default `latest`), then
**Redeploy** from the Coolify UI (or update the var to a specific tag first
to pin it). This pulls the new image tags and restarts the stack; migrations
run automatically on the new `backend` container's start.

### 6.8 Backups

Coolify can run scheduled backups of named volumes/databases from its own
**Backups** tab (recommended: schedule Postgres and the MinIO volume
separately). You can also exec into the `postgres` service from the Coolify
UI's terminal and run the same `pg_dump` command from §5.

### 6.9 Coolify troubleshooting

| Symptom | Likely cause |
|---|---|
| Terminal stuck on "Connecting…" | WebSocket not reaching `backend` — confirm the domain is attached to `nginx`, not `backend` or `frontend` directly |
| 502 from the domain | `backend`/`frontend`/`nginx` not yet healthy — check the resource's health status and container logs |
| Migrations failing on deploy | Usually a stale `DATABASE_URL` (wrong internal hostname — should be `postgres`, Coolify's internal service DNS, not `localhost`) or drift on an existing external DB — see the gap-fill procedure in §5 |
| Login works but SSO redirect fails | `TRAEFIK_HOST` / SSO provider's redirect URI doesn't match the domain Coolify actually assigned — they must match exactly, protocol included |

---

## 7. General troubleshooting

| Symptom | Check |
|---|---|
| `502 Bad Gateway` | Backend/frontend container unhealthy — `docker compose logs backend` |
| Web terminal stuck on "Connecting…" | Reverse proxy not forwarding WebSocket `Upgrade` headers on `/api/terminal/*` (see §1) |
| "Server refuses to start" in logs | `NODE_ENV=production` with a default/placeholder `JWT_SECRET`/`JWT_REFRESH_SECRET` |
| Login works, then immediately logged out | Clock skew between backend and reverse proxy/client, or `SESSION_ABSOLUTE_TTL` misconfigured — check backend logs for `SESSION_REVOKED` |
| Session recordings not saving | No storage provider configured (falls back to non-durable local disk) — set `MINIO_*`/`STORAGE_*`/`AZURE_*` |
| `prisma migrate deploy` fails with drift | See the gap-fill baseline procedure in §5 |
| Bootstrap agent can't reach the API | `AGENT_SHARED_SECRET` mismatch, or the host can't resolve/reach `PUBLIC_API_URL` |
| SSO callback error `state_mismatch` | Redis not reachable from `backend`, or the callback URL registered at the IdP doesn't match exactly (protocol + host) |

---

## 8. Security hardening checklist for production

- [ ] Every secret in §3 generated with `openssl rand`, none left at example
      values (`NODE_ENV=production` enforces this for JWT secrets already)
- [ ] `SERVER_ENCRYPTION_KEY` backed up somewhere separate from the database
      backup, and never changed after go-live without a re-encryption
      migration
- [ ] `SSH_TARGET_ALLOW_LOOPBACK=false` (the default — confirm it wasn't left
      on from a lab/dev copy of `.env`)
- [ ] `TRAEFIK_HOST` / `CORS_ORIGIN` set to your real domain only — no
      wildcard, no `localhost`
- [ ] TLS terminated somewhere in the chain (Traefik/Coolify cert resolver,
      your own nginx, or a CDN in front) — Shellius itself does not terminate
      TLS
- [ ] MFA enforced for `admin`/`super_admin` accounts at minimum
      (`Administration → Two-factor`, or `MFA_ENFORCED=true`)
- [ ] `AUTH_LOCKOUT_THRESHOLD`/`AUTH_LOCKOUT_MINUTES` left at sane defaults
      (5/15) or tightened for internet-facing deployments
- [ ] `prodApprovalBypassMinRole` (Administration → Access rules, or
      `PUT /api/org/access-settings`) reviewed — decide deliberately whether
      admins should bypass production approval, rather than leaving the
      default unexamined
- [ ] Database backups scheduled (`scripts/backup-db.sh` on a cron/systemd
      timer, or your platform's managed backups)
- [ ] Recording retention (`RECORDING_RETENTION_DAYS`) set to match your
      compliance/audit requirements
- [ ] `METRICS_TOKEN` set and `/api/metrics` not exposed publicly without it
- [ ] Reverse proxy access logs retained per your log-retention policy —
      Shellius's own `AuditLog` is immutable and covers in-app actions, but
      proxy-level logs cover raw request volume/IPs
- [ ] Any proxy/load balancer in front of the bundled nginx does **not** log
      query strings (terminal `?t=` tickets, bootstrap `?token=` links). See
      §4.2.1 for Traefik/Coolify, Caddy and nginx settings
- [ ] All hosts re-bootstrapped with `--upgrade` to pick up a per-host agent
      token (see §5 "Upgrade notes: per-host agent tokens") — check
      ServerDetail for any host still flagged with the deprecated
      shared-agent-token notice
- [ ] `AGENT_LEGACY_SHARED_SECRET` set to `deny` once all hosts are upgraded
      (defaults to `warn` this release so un-upgraded hosts keep working —
      it will default to `deny` in the next release regardless)

---

## 9. Prometheus metrics

Set `METRICS_TOKEN`. Scrape `https://<domain>/api/metrics` with
`Authorization: Bearer <token>`. Returns Prometheus text format: default
Node.js runtime metrics plus `shellius_http_requests_total` (labelled
`method`, `route`, `status`).

## 10. Named volumes

| Volume | Contents |
|---|---|
| `postgres_data` | PostgreSQL data directory |
| `redis_data` | Redis AOF persistence |
| `minio_data` | Session recordings (if using bundled MinIO) |
