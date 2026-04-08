# Task 19d — Backend storageService for MinIO

**Phase:** 19
**Plan:** `.claude/plans/phase-19-minio-recordings.md`
**Agent:** backend
**Reference:** `/home/yavadmin/vaulthive/backend/src/services/storageService.js`

## Scope
Create `backend/src/services/storageService.js` — a lazy MinIO client with bucket provisioning and streaming put/get.

## Steps
1. `cd backend && npm i minio`.
2. Implement `storageService.js` with:
   - `isConfigured()` — checks MINIO_ENDPOINT/ACCESS_KEY/SECRET_KEY.
   - `getClient()` — lazy singleton throwing 503 `STORAGE_NOT_CONFIGURED` if not configured.
   - `ensureBucket(bucket)` — checks existence, creates if missing, sets deny-public bucket policy (copy VaultHive's policy shape).
   - `putObjectStream(key, stream, { contentType, metadata })`.
   - `getObjectStream(key)`.
   - `deleteObject(key)`, `statObject(key)`.
   - Bucket naming helper: defaults to `process.env.MINIO_RECORDINGS_BUCKET`.
3. In `backend/src/app.js` boot sequence, call `storageService.ensureBucket()` after DB connection is healthy. Log at INFO level. Do NOT block boot on failure — log WARN and continue so the backend still serves other endpoints if MinIO is down.

## Verification
- Unit test: mock minio client, verify ensureBucket calls `bucketExists` + `makeBucket` + `setBucketPolicy`.
- On backend boot, log shows "MinIO client initialized" and "Provisioned recordings bucket shellius-recordings" on first run, "bucket exists" on subsequent boots.
