# Task 4D: On-Premise Agent Registration and Heartbeat

**Agent:** backend + devops
**Status:** [ ] Pending
**Blocks:** none
**Blocked By:** 4A

## Objective
Implement the server-side endpoints and scripts for on-premise agent lifecycle management: registration, approval, heartbeat, and bootstrap. This enables managing servers that aren't in a cloud provider by installing a lightweight agent that phones home.

## Deliverables

### Agent Service
- `/backend/src/services/agentService.js`:
  - `register(orgId, agentData)` — create AgentRegistration with status "registered", generate unique agent_id (uuid-v4), generate agent_token (random 64-byte hex), store token_hash (SHA-256). Return agent_id + agent_token (plaintext, only returned once).
  - `approve(orgId, agentRegistrationId, userId)` — set status to "active", set approved_by and approved_at. Optionally link to an existing server or create a new Server record from agent metadata.
  - `reject(orgId, agentRegistrationId)` — set status to "decommissioned"
  - `heartbeat(agentId, agentToken, payload)` — validate agent_token against stored hash, update last_heartbeat, agent_version, metadata (CPU/RAM/disk usage). If linked server exists, update server's agent_last_seen and health_status to "healthy".
  - `listRegistrations(orgId, filters)` — list agent registrations with filters: status, hostname search
  - `decommission(orgId, agentRegistrationId)` — set status to "decommissioned", unlink from server

### Routes
- `/backend/src/routes/agents.js`:
  - `POST /api/agents/register` — register new agent (requires org-level API key or bootstrap token, not user JWT)
  - `POST /api/agents/:agentId/heartbeat` — agent heartbeat (authenticated via agent_token header)
  - `GET /api/agents` — list registrations (admin+)
  - `GET /api/agents/:id` — registration detail (admin+)
  - `POST /api/agents/:id/approve` — approve registration (admin+)
  - `POST /api/agents/:id/reject` — reject registration (admin+)
  - `DELETE /api/agents/:id` — decommission agent (super_admin)

### Agent Authentication Middleware
- `/backend/src/middleware/agentAuth.js` — authenticate agent requests via X-Agent-ID and X-Agent-Token headers, validate against AgentRegistration table

### Bootstrap Script
- `/backend/scripts/bootstrap.sh`:
  - Bash script intended to run on target servers via curl | bash
  - Accepts SHELLIUS_URL and BOOTSTRAP_TOKEN as environment variables
  - Collects system info: hostname, IP (primary interface), OS type/version, CPU count, total RAM, disk usage
  - Calls POST /api/agents/register with collected data
  - Stores returned agent_id and agent_token in /etc/shellius/agent.conf (chmod 600)
  - Sets up a systemd service or cron job that sends heartbeat every 60 seconds
  - Prints registration summary and next steps (await approval in Shellius UI)

### Check Principals Script
- `/backend/scripts/check-principals.sh`:
  - Reads /etc/ssh/authorized_principals or AuthorizedKeysFile
  - Reports which SSH keys/principals are configured for which users
  - Sends results as part of heartbeat metadata

### Heartbeat Check Job
- `/backend/src/jobs/agentHeartbeat.js`:
  - BullMQ repeatable job running every 2 minutes
  - Finds active agents where last_heartbeat is older than 3x heartbeat_interval
  - Marks stale agents as status "stale"
  - Updates linked server health_status to "unhealthy" with message "Agent heartbeat timeout"
  - Logs stale transitions to AuditLog

## Acceptance Criteria
- Bootstrap script successfully registers an agent and stores credentials securely on the target host
- Agent token is returned only once during registration and stored as a hash in the database
- Heartbeat endpoint validates agent token and updates last_heartbeat timestamp
- Heartbeat updates linked server's agent_last_seen and health_status
- Stale agent detection job marks agents as stale after missing 3 heartbeat intervals
- Stale agents cause their linked server's health_status to change to "unhealthy"
- Approval flow links agent to a new or existing Server record
- Agent auth middleware rejects requests with invalid or missing agent credentials
- Bootstrap script works on Ubuntu 20.04+, Debian 11+, RHEL 8+, and Amazon Linux 2
- Check-principals script correctly parses SSH authorized_principals configuration
- Decommissioned agents can no longer send heartbeats (rejected with 401)
