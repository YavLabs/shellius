# Phase 19 — MinIO for Session Recordings

## Goal
Move session recordings off the backend container's local disk into MinIO, using the exact same deployment pattern as VaultHive so the MinIO console is reachable at `/minio/` and recordings are browsable there with the configured root credentials.

## Reference
VaultHive files to mirror (read-only reference — copy shape, adapt names):
- `/home/yavadmin/vaulthive/docker-compose.yml` lines 122-142 (minio service)
- `/home/yavadmin/vaulthive/docker/nginx.conf` lines 65-82 (console proxy, prod)
- `/home/yavadmin/vaulthive/docker/nginx.dev.conf` lines 69-94 (S3 API + console, dev)
- `/home/yavadmin/vaulthive/.env.example` lines 126-135 (env vars)
- `/home/yavadmin/vaulthive/backend/src/services/storageService.js` (MinIO client pattern)

## Current Shellius state (to replace)
- `backend/src/services/terminalService.js:40-103` writes asciinema `.cast` files to `RECORDINGS_DIR` on local disk.
- `backend/src/routes/sessions.js:95-126` streams recordings straight off disk via `fs.createReadStream`.
- `docker-compose.yml` / `docker-compose.prod.yml` bind-mount a `recordings` / `recordings_data` volume into the backend container.
- No MinIO service, no `/minio/` proxy, no S3 env vars.

## Tasks

### T1 — docker-compose
- [ ] Add `minio` service to `docker-compose.yml` and `docker-compose.prod.yml`:
  - `image: minio/minio:latest`
  - `command: server /data --console-address ":9001"`
  - env: `MINIO_ROOT_USER=${MINIO_ACCESS_KEY}`, `MINIO_ROOT_PASSWORD=${MINIO_SECRET_KEY}`, `MINIO_BROWSER_REDIRECT_URL=https://${PUBLIC_HOST}/minio`
  - volume: `minio_data:/data`
  - healthcheck: `curl -f http://localhost:9000/minio/health/live`
  - networks: same as backend
  - dev: expose `9002:9001` for direct console access
- [ ] `backend.depends_on.minio: { condition: service_healthy }`
- [ ] Remove the `recordings` / `recordings_data` bind mount from the backend service.
- [ ] Add `minio_data` to the top-level `volumes:` block.

### T2 — nginx
- [ ] In `docker/nginx-proxy.conf`, add:
  - `location = /minio { return 301 $scheme://$http_host/minio/; }`
  - `location /minio/ { proxy_pass http://minio:9001/; ...WebSocket upgrade headers... }` (console UI)
  - `location /s3/ { rewrite ^/s3(/.*) $1 break; proxy_pass http://minio:9000; client_max_body_size 100m; }` (S3 API, for presigned playback URLs)
- [ ] Bump `client_max_body_size` on the main server block to 100m to allow large recording uploads.

### T3 — env
- [ ] `.env.example`: add `MINIO_ENDPOINT=minio`, `MINIO_PORT=9000`, `MINIO_USE_SSL=false`, `MINIO_ACCESS_KEY=`, `MINIO_SECRET_KEY=`, `MINIO_RECORDINGS_BUCKET=shellius-recordings`.
- [ ] Remove `RECORDING_PATH`. Keep `RECORDING_RETENTION_DAYS`.

### T4 — backend service layer
- [ ] `cd backend && npm i minio`
- [ ] New `backend/src/services/storageService.js` modeled on VaultHive's:
  - lazy `getClient()`, `isConfigured()`
  - `ensureBucket(bucket)` with deny-public bucket policy
  - `putObjectStream(key, stream, { contentType, meta })`
  - `getObjectStream(key)`
  - `deleteObject(key)`, `statObject(key)`
- [ ] On backend boot, call `ensureBucket(MINIO_RECORDINGS_BUCKET)`.

### T5 — terminalService recording writer
- [ ] Replace the `fs.createWriteStream` path with a `PassThrough` that is streamed directly into `storageService.putObjectStream`.
- [ ] Key format: `sessions/${orgId}/${sessionId}.cast`.
- [ ] On session close, flush and wait for upload `ETag` before marking the DB row.

### T6 — Prisma schema
- [ ] Migration `add_session_recording_key`: add `recordingKey String?` on `Session`. Keep `recordingPath` nullable for legacy rows.
- [ ] Update `sessionService` to write `recordingKey` instead of `recordingPath` for new sessions.

### T7 — recording download route
- [ ] `routes/sessions.js` GET `/:id/recording`:
  - If `session.recordingKey` → stream via `storageService.getObjectStream`.
  - Else if legacy `session.recordingPath` → existing fs path (backwards compat).
- [ ] Same headers (`Content-Disposition`, `application/octet-stream`).

### T8 — verification
- [ ] `docker compose up` — verify `minio` is healthy, backend boots, bucket exists.
- [ ] Log in to `https://<host>/minio/` with `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`, confirm empty bucket.
- [ ] Start a web terminal session, type commands, disconnect.
- [ ] Verify the `.cast` object appears in the MinIO console under `shellius-recordings/sessions/<org>/<id>.cast`.
- [ ] Download it from the Sessions page in the web UI and replay with `asciinema play`.

## Open questions
- Legacy recordings on disk: one-shot migration script or leave on disk until retention purges them? Default: leave.
- Do we want presigned GET URLs for in-browser playback (avoids streaming through the backend)? If yes, the `/s3/` nginx block is required; if no, we can drop it.

## Out of scope
- Encryption at rest of recording contents (MinIO server-side SSE). Can be a follow-up.
- Multi-region replication.
