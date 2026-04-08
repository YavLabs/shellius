# Task 19f — Recording download from MinIO with legacy fallback

**Phase:** 19
**Plan:** `.claude/plans/phase-19-minio-recordings.md`
**Agent:** backend
**Depends on:** task-19e

## Scope
Update `GET /api/sessions/:id/recording` at `backend/src/routes/sessions.js:95-126` to stream from MinIO when `recordingKey` is set, falling back to filesystem for legacy rows.

## Steps
1. If `session.recordingKey` is non-null:
   - `const stream = await storageService.getObjectStream(session.recordingKey)`
   - Set headers: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="session-${id}.cast"`.
   - `stream.pipe(res)`.
2. Else if `session.recordingPath` is non-null (legacy):
   - Keep the existing `fs.createReadStream` path exactly as it is.
3. Else: 404 "No recording available".
4. Handle MinIO `NoSuchKey` as 404 with code `RECORDING_NOT_FOUND`.

## Verification
- Play a new (MinIO) recording from the Sessions page → downloads correctly, replays with `asciinema play file.cast`.
- A legacy session row with only `recordingPath` still downloads successfully.
- Deleting the object from MinIO console → download returns 404.
