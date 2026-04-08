# Task 19q — QA gates for Phase 19 (MinIO recordings)

**Phase:** 19
**Plan:** `.claude/plans/phase-19-minio-recordings.md`
**Agent:** qa

## Acceptance criteria
- [ ] MinIO service healthy in both dev and prod compose stacks.
- [ ] `https://<host>/minio/` loads the console, login works with `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`.
- [ ] New session recordings land in the `shellius-recordings` bucket under `sessions/<orgId>/<sessionId>.cast`.
- [ ] `Session.recordingKey` is populated on new rows; `recordingPath` remains null.
- [ ] Legacy sessions (with only `recordingPath`) still download successfully.
- [ ] Download from Sessions page works and replays correctly with asciinema.
- [ ] Backend boot does not crash if MinIO is down — logs WARN and continues.
- [ ] No `/data/recordings` volume mount on the backend container.
- [ ] Unit tests for `storageService` pass.
- [ ] Integration test: start session → commands → disconnect → download → byte-identical to what's in MinIO.

## Risks to verify
- Upload failures don't leave zombie sessions.
- Large recordings (>50MB) stream without OOMing the backend.
- Concurrent sessions upload to distinct keys (no collisions).
