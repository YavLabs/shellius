# Task 19a — MinIO service in docker-compose

**Phase:** 19 — MinIO for session recordings
**Plan:** `.claude/plans/phase-19-minio-recordings.md`
**Agent:** devops

## Scope
Add a `minio` service to both `docker-compose.yml` and `docker-compose.prod.yml`, mirroring VaultHive's deployment at `/home/yavadmin/vaulthive/docker-compose.yml:122-142`.

## Steps
1. Add `minio` service:
   - image: `minio/minio:latest`
   - command: `server /data --console-address ":9001"`
   - env: `MINIO_ROOT_USER=${MINIO_ACCESS_KEY}`, `MINIO_ROOT_PASSWORD=${MINIO_SECRET_KEY}`, `MINIO_BROWSER_REDIRECT_URL=https://${TRAEFIK_HOST}/minio`
   - volume: `minio_data:/data`
   - healthcheck: `curl -f http://localhost:9000/minio/health/live` (30s interval)
   - networks: same as backend (internal + homelab for prod)
2. Dev-only: expose `9002:9001` for direct console access in `docker-compose.yml`.
3. `backend.depends_on.minio: { condition: service_healthy }`.
4. Remove the existing `recordings` / `recordings_data` volume from the backend service.
5. Add `minio_data` to the top-level `volumes:` block in both files.

## Verification
- `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d minio` → MinIO reports healthy within 30s.
- `docker volume ls | grep minio_data` exists.
- Backend still starts and reaches the healthy state.
