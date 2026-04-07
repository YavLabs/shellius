# Task 14H: Session Recording Playback + Search

**Agent:** frontend
**Status:** [x] Done
**Blocks:** 14L
**Blocked By:** None

## Objective
Sessions.jsx lists sessions and lets admins terminate active ones, but
recording playback (asciinema) is wired ambiguously and there is no way
to filter by user/host/time.

## Deliverables

### Playback
- Verify `frontend/src/components/sessions/SessionPlayer.jsx` exists; if
  not, build it:
  - Loads `GET /api/sessions/:id/recording` (already exists, returns
    asciinema v2 cast file)
  - Renders via `asciinema-player` or a hand-rolled xterm.js replay
  - Controls: play / pause / scrub / speed
- `Sessions.jsx` detail modal: show the player when `recordingPath` is
  non-null, otherwise an empty state

### Search / filters
- Add filters above the table: user picker, server picker, date range,
  status (active / ended / terminated)
- Wire to `listSessions(params)` — verify the backend already accepts
  these query params; extend it if not

## Acceptance
- Any session with a recording file plays back smoothly in the modal.
- Admins can find a session by user + day without scrolling pages.
