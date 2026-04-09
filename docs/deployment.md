# Shellius — Production Deployment

## Prerequisites

- Docker 24+ and Docker Compose v2
- A domain name with DNS pointing to your server
- A TLS certificate (or let nginx use a self-signed cert for internal use)

## Quick Start

```bash
# 1. Clone and enter the repo
git clone https://github.com/your-org/shellius.git && cd shellius

# 2. Create your production env file
cp .env.prod.example .env.prod
# Edit .env.prod — fill in all CHANGE_ME values

# 3. Place TLS certificates
mkdir -p docker/nginx-certs
# Put fullchain.pem and privkey.pem in docker/nginx-certs/
# For self-signed (testing only):
# openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
#   -keyout docker/nginx-certs/privkey.pem \
#   -out docker/nginx-certs/fullchain.pem -subj "/CN=shellius.example.com"

# 4. Start all services
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# 5. Run database migrations
docker compose -f docker-compose.prod.yml exec backend npx prisma migrate deploy
```

## Traefik Alternative

If you prefer Traefik for TLS termination, add `traefik.enable=true` to your
Traefik network and comment out or remove the `nginx` service from
`docker-compose.prod.yml`. The backend and frontend services already carry
Traefik labels for `websecure` + `letsencrypt` cert resolver. Set
`SHELLIUS_DOMAIN` in `.env.prod` to your real domain.

## Environment Variables

See `.env.prod.example` for a fully documented list. Required secrets:

| Variable | How to generate |
|---|---|
| `JWT_SECRET` | `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | `openssl rand -base64 48` |
| `SERVER_ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `AGENT_SHARED_SECRET` | `openssl rand -base64 32` |
| `METRICS_TOKEN` | `openssl rand -base64 32` |

### Session lifetimes

`JWT_EXPIRY` and `JWT_REFRESH_EXPIRY` control how long an access token
and a refresh token are valid for. Defaults if unset are `15m` / `7d`.
For self-hosted single-team deployments the recommended values are:

```
JWT_EXPIRY=8h
JWT_REFRESH_EXPIRY=30d
```

Rationale: 8h matches a workday, so users only re-login once per day
and the TUI doesn't fire a token refresh during normal use. 30d for
the refresh token means the CLI stays signed in across a typical
sprint without nagging. Tighten back to `15m` / `7d` if you're running
a hosted multi-tenant instance where reducing the blast radius of a
stolen token matters more than UX.

After changing these, recreate the backend container so the new env
vars are picked up:

```
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  up -d --force-recreate --no-deps backend
```

Existing tokens keep their original expiry — users need to re-login
once for the new TTL to apply to their session.

## Named Volumes

| Volume | Contents |
|---|---|
| `shellius_pg_data` | PostgreSQL data directory |
| `shellius_redis_data` | Redis AOF persistence |
| `shellius_recordings` | SSH/RDP session recordings |

## Backups

```bash
# Database — creates ./backups/db-<timestamp>.sql.gz, keeps 14 days
./scripts/backup-db.sh

# Recordings — creates ./backups/recordings-<timestamp>.tar.gz, keeps 14 days
./scripts/backup-recordings.sh
```

Both scripts use `set -euo pipefail` and exit non-zero on failure; wire them
into cron or a systemd timer as needed.

## Prometheus Metrics

Set `METRICS_TOKEN` in `.env.prod`. Scrape `https://<domain>/api/metrics` with
`Authorization: Bearer <token>`. The endpoint returns Prometheus text format
with default Node.js runtime metrics plus an `shellius_http_requests_total`
counter labelled by `method`, `route`, and `status`.

## Health Checks

All services declare Docker health checks. Wait for healthy status before
accepting traffic:

```bash
docker compose -f docker-compose.prod.yml ps
```

## Upgrading

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml exec backend npx prisma migrate deploy
```
