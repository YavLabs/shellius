# Task 10C: Audit & Session Recording Frontend

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** 10A, 10B

## Objective
Build the Audit Log page with advanced filtering and export, the Sessions page with active and historical views, and a session player component using asciinema-player for recording playback.

## Deliverables
- `client/src/pages/AuditLog.jsx`:
  - Data table with columns: timestamp, action (color-coded by category), actor, target, IP address
  - Filter sidebar: action category (multi-select), actor (search), target type, date range picker
  - Full-text search bar
  - Export buttons (CSV, JSON) that trigger download
  - Click row to expand metadata details
- `client/src/pages/Sessions.jsx`:
  - "Active" tab: live list of active sessions with user, server, duration timer, terminate button (admin)
  - "History" tab: paginated table of past sessions with filters (user, server, date range, type)
  - Click session to view detail panel with recording playback (if available)
- `client/src/components/SessionPlayer.jsx`:
  - Embedded asciinema-player component
  - Playback controls: play/pause, speed (1x, 2x, 4x), seek, fullscreen
  - Loading state while recording streams
  - "No recording available" state for unrecorded sessions
- `client/src/hooks/useAudit.js` — React Query hooks for audit endpoints
- `client/src/hooks/useSessions.js` — React Query hooks for session and recording endpoints

## Acceptance Criteria
- Audit log displays entries with correct color-coding by action category
- Filters combine correctly (AND logic) and update the table in real-time
- CSV/JSON export downloads a file matching the current filter state
- Active sessions show live duration that updates every second
- Terminate button closes the session and removes it from the active list
- Session player plays recordings with correct timing and terminal rendering
- Playback speed control works correctly at all speeds
- All pages are responsive and follow the existing design system
