# Task 3C: Server Health Check Service

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** none
**Blocked By:** 3B

## Objective
Implement a TCP-based health check system that periodically probes each active server's connectivity and updates its health status. Use BullMQ for scheduling repeatable jobs that run every 5 minutes.

## Deliverables

### Health Check Service
- `/backend/src/services/healthCheckService.js`:
  - `checkServer(server)` — open a TCP connection to server.ip_address:server.port with a 10-second timeout. On success: return { status: "healthy", latency_ms, message: "TCP connection successful" }. On failure: return { status: "unhealthy", message: error description (ECONNREFUSED, ETIMEDOUT, EHOSTUNREACH, etc.) }
  - `checkAllServers(orgId)` — fetch all active servers for an org (or all orgs if no orgId), run health checks with concurrency limit (10 concurrent), batch-update health_status, last_health_check, health_message in the database
  - `checkCustomerServers(customerId)` — check all active servers under a specific customer
  - `getHealthSummary(orgId)` — aggregate counts: healthy, unhealthy, unknown, maintenance, total

### BullMQ Job
- `/backend/src/jobs/healthCheck.js`:
  - Register a repeatable job "server-health-check" that runs every 5 minutes
  - Job processor: calls checkAllServers() for all active organizations
  - Handles job failures gracefully (log error, don't crash worker)
  - Stale job cleanup: remove completed jobs older than 24 hours

### Queue Setup
- `/backend/src/config/queue.js` — BullMQ queue and worker factory using shared Redis connection, default job options (attempts: 3, backoff: exponential)

### Health Status Transitions
- Servers in `maintenance` status are skipped by health checks (manual override)
- New servers start as `unknown` until their first health check
- Transition from `healthy` to `unhealthy` is logged to AuditLog as a system event
- Transition from `unhealthy` to `healthy` (recovery) is also logged

### API Endpoint
- Add to server routes:
  - `POST /api/servers/:id/health-check` — trigger an on-demand health check for a single server (admin+)
  - `GET /api/health/summary` — org-wide health summary (operator+)

## Acceptance Criteria
- Health checks run automatically every 5 minutes via BullMQ repeatable job
- TCP check correctly detects open ports (healthy) and closed/unreachable ports (unhealthy)
- Health check timeout is 10 seconds per server, total job completes within reasonable time using concurrency
- Servers marked as `maintenance` are excluded from automated checks
- Health status transitions (healthy->unhealthy, unhealthy->healthy) create AuditLog entries
- On-demand health check via API returns the updated status immediately
- Health summary endpoint returns aggregate counts grouped by status
- BullMQ worker recovers from Redis disconnections without crashing
- Completed job records are cleaned up to prevent Redis memory growth
- Health check does not leak TCP sockets (proper cleanup on timeout/error)
