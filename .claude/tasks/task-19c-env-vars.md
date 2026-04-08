# Task 19c — MinIO env vars

**Phase:** 19
**Plan:** `.claude/plans/phase-19-minio-recordings.md`
**Agent:** devops

## Scope
Add MinIO env vars to `.env.example`, `.env.prod.example`, and populate `.env` / `.env.prod` with real values.

## Steps
1. In `.env.example` and `.env.prod.example`, add after existing storage section:
   ```env
   # ---------- MinIO (session recording storage) ----------
   MINIO_ENDPOINT=minio
   MINIO_PORT=9000
   MINIO_USE_SSL=false
   MINIO_ACCESS_KEY=
   MINIO_SECRET_KEY=
   MINIO_RECORDINGS_BUCKET=shellius-recordings
   ```
2. Remove `RECORDING_PATH` entries. Keep `RECORDING_RETENTION_DAYS`.
3. Populate `.env` and `.env.prod` with generated credentials (ACCESS_KEY 20 chars, SECRET_KEY 40+ chars, both `openssl rand -hex`).

## Verification
- `docker compose -f docker-compose.prod.yml --env-file .env.prod config | grep MINIO` shows all five vars interpolated.
