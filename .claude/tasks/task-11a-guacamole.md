# Task 11A: Guacamole Setup & RDP Service

**Agent:** devops + backend
**Status:** [ ] Pending
**Blocks:** 11B, 11C, 11D
**Blocked By:** None

## Objective
Add Apache Guacamole to the docker-compose stack and implement rdpService.js for managing Guacamole RDP connections, authentication tokens, and credential injection.

## Deliverables
- Docker Compose additions in `docker-compose.yml`:
  - `guacd` service (guacamole/guacd) — Guacamole proxy daemon
  - `guacamole` service (guacamole/guacamole) — Guacamole web app with PostgreSQL backend
  - `guacamole-db` service (PostgreSQL for Guacamole, or reuse existing with separate schema)
  - Network configuration for guacd <-> guacamole <-> backend communication
  - Init script for Guacamole database schema
- `src/services/rdpService.js`:
  - `createConnection({ hostname, port, username, password, domain, security })` — create Guacamole connection via REST API
  - `generateAuthToken(userId, connectionId)` — generate single-use Guacamole auth token for the user
  - `injectCredentials(connectionId, { username, password, domain })` — set RDP credentials on the connection
  - `deleteConnection(connectionId)` — remove connection on access revocation
  - `getConnectionStatus(connectionId)` — check if connection is active
- `src/config/guacamole.js` — Guacamole API client configuration (base URL, admin credentials)

## Acceptance Criteria
- `docker compose up` starts Guacamole services alongside existing stack
- guacd connects successfully to Guacamole web app
- `createConnection()` creates a valid RDP connection in Guacamole
- `generateAuthToken()` produces a token that allows one-time access to the specified connection
- Credentials are injected securely (not logged, not stored in Shellius DB)
- `deleteConnection()` removes the connection and any active sessions
- Guacamole admin credentials are configured via environment variables
