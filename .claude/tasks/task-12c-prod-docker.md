# Task 12C: Production Docker Compose

**Agent:** devops
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** None

## Objective
Create a production-ready docker-compose configuration with resource limits, restart policies, named volumes, Traefik labels, Prometheus metrics, and backup scripts.

## Deliverables
- `docker-compose.prod.yml`:
  - All services with resource limits (CPU, memory) appropriate for production
  - Restart policies: `unless-stopped` for all services
  - Named volumes for all persistent data (postgres, redis, recordings, CA keys)
  - Traefik labels for automatic HTTPS routing (frontend, API, WebSocket)
  - Health checks for all services
  - Environment variable references to `.env.prod` file
  - Read-only root filesystem where possible
  - Non-root user for all services
  - Log driver configuration (json-file with max-size and max-file)
- `prometheus.yml` — Prometheus scrape config for:
  - Node.js app metrics (prom-client)
  - PostgreSQL exporter
  - Redis exporter
  - Guacamole metrics
- `scripts/backup.sh`:
  - PostgreSQL pg_dump with timestamp
  - Redis RDB snapshot copy
  - CA key backup (encrypted)
  - Recording archive
  - Retention policy (keep last N backups)
  - Backup verification (restore test)
- `scripts/restore.sh` — restore from backup
- `.env.prod.example` — documented production environment variables

## Acceptance Criteria
- `docker compose -f docker-compose.prod.yml up -d` starts all services successfully
- All services restart automatically after failure
- Named volumes persist data across container recreations
- Traefik routes HTTPS traffic correctly to all services including WebSocket
- Prometheus scrapes metrics from all configured targets
- `backup.sh` creates a complete backup that can be restored with `restore.sh`
- Backup script handles errors gracefully and reports status
- `.env.prod.example` documents all required environment variables with descriptions
