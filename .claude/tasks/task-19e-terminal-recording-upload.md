# Task 19e — Stream recording to MinIO from terminalService

**Phase:** 19
**Plan:** `.claude/plans/phase-19-minio-recordings.md`
**Agent:** backend
**Depends on:** task-19d

## Scope
Replace the local-disk writer at `backend/src/services/terminalService.js:40-103` with a streaming upload to MinIO.

## Steps
1. Add Prisma migration `add_session_recording_key`:
   ```
   Session.recordingKey String?
   ```
   Keep `recordingPath` nullable for legacy rows.
2. `npx prisma migrate dev --name add_session_recording_key`.
3. Refactor `openRecordingWriter()`:
   - Replace `fs.createWriteStream(filePath)` with a `stream.PassThrough`.
   - Key format: `sessions/${orgId}/${sessionId}.cast`.
   - Call `storageService.putObjectStream(key, passThrough, { contentType: 'application/x-asciicast', metadata: { sessionId, orgId } })` — this returns a promise; track it on the writer.
   - Header + append calls write to the PassThrough instead of the fs stream.
4. On session close, `passThrough.end()`, `await` the upload promise, then `prisma.session.update({ data: { recordingKey: key } })`.
5. On upload failure: log at ERROR, do NOT mark `recordingKey` — recording is effectively lost but session still completes. Alert path TBD (audit log entry type `RECORDING_UPLOAD_FAILED`).
6. Remove the `RECORDINGS_DIR` local-disk path and any `mkdir` calls.

## Verification
- Start a web terminal session → type commands → disconnect.
- `docker exec shellius-api ls /data/recordings` empty.
- MinIO console `shellius-recordings` bucket contains `sessions/<orgId>/<sessionId>.cast`.
- `prisma.session` row has `recordingKey` set.
