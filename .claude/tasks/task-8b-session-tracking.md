# Task 8B: Session Tracking Service

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** 8A

## Objective
Implement sessionService.js for tracking active and historical SSH/RDP sessions, with routes for listing, viewing details, and administrative termination.

## Deliverables
- `Session` model in `prisma/schema.prisma` with fields: id, accessRequestId (FK), userId (FK), serverId (FK), type (SSH/RDP), status (ACTIVE/COMPLETED/TERMINATED), startedAt, endedAt, duration (Int, seconds), bytesIn (BigInt), bytesOut (BigInt), clientIp, recordingPath (nullable), createdAt
- Prisma migration for the Session model
- `src/services/sessionService.js` with functions:
  - `create({ accessRequestId, userId, serverId, type, clientIp })` — create ACTIVE session
  - `complete(sessionId, { bytesIn, bytesOut })` — mark session COMPLETED, calculate duration
  - `terminate(sessionId, terminatedBy)` — forcefully end session (closes WebSocket), mark TERMINATED
  - `listActive({ page, limit })` — list all currently active sessions
  - `listHistory({ userId, serverId, dateRange, page, limit })` — paginated historical sessions
  - `getById(sessionId)` — full session details including user and server info
- `src/routes/sessionRoutes.js`:
  - GET /sessions — list sessions (active and history, with filters)
  - GET /sessions/active — list currently active sessions
  - GET /sessions/:id — session detail
  - POST /sessions/:id/terminate — admin-only force terminate

## Acceptance Criteria
- Active sessions accurately reflect currently connected WebSocket sessions
- Terminated sessions close the associated WebSocket connection
- Session duration is calculated correctly on completion
- Historical sessions are filterable by user, server, date range, and type
- Terminate endpoint restricted to admin role
- Session list includes related user and server details
