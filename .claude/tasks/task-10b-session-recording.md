# Task 10B: Session Recording

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 10C
**Blocked By:** 10A

## Objective
Implement terminal session recording in asciinema .cast format within the SSH proxy, with a streaming playback endpoint and cleanup/archive jobs.

## Deliverables
- Recording integration in `src/ws/sshProxy.js`:
  - On session start (if recording enabled): initialize .cast file with header (version 2, width, height, timestamp)
  - On terminal output: append timestamped output events to .cast buffer
  - On terminal resize: append resize events
  - On session end: finalize recording, write to disk, update session record with recordingPath
  - Recording storage path: `data/recordings/{sessionId}.cast`
- `src/routes/recordingRoutes.js`:
  - GET /recordings/:sessionId — stream .cast file for playback
  - GET /recordings/:sessionId/download — download .cast file
  - DELETE /recordings/:sessionId — admin-only delete recording
- `src/jobs/recordingCleanup.js`:
  - BullMQ job running daily
  - Delete recordings older than configurable retention period (default 90 days)
  - Archive option: compress old recordings to gzip before deletion threshold
  - Update session records to reflect archived/deleted recordings
- Recording configuration in app settings:
  - Enable/disable recording globally or per-environment
  - Retention period (days)
  - Max recording size limit

## Acceptance Criteria
- Recordings are created in valid asciinema v2 .cast format
- Recordings can be played back using asciinema-player in the browser
- Streaming endpoint supports range requests for large recordings
- Recording does not noticeably impact terminal latency
- Cleanup job correctly removes recordings past retention period
- Recordings are not created when recording is disabled
- Recording files are stored outside the application directory in a configurable path
