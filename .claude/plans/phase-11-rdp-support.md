# Phase 11: RDP Support

## Goal
Add RDP access support via Apache Guacamole integration, including browser-based RDP terminal and downloadable .rdp files.

## Duration Estimate
1-2 weeks

## Dependencies
Phase 8 (Web Terminal infrastructure), Phase 7 (Access Requests with RDP credential delivery)

## Tasks

### Task 11A: Guacamole Integration [Agent: devops + backend]
- Add guacd (Apache Guacamole daemon) to docker-compose
- Configure Guacamole connection settings
- Implement rdpService.js:
  - createConnection(serverId, credentials): create Guacamole connection config
  - generateAuthToken(userId, connectionId, ttl): time-limited Guacamole auth token
  - Credential injection: decrypt RDP credentials from Server model, pass to Guacamole (user never sees password)
  - revokeConnection(connectionId): terminate and remove

### Task 11B: RDP WebSocket Proxy [Agent: backend]
Blocked by: 11A
- Implement RDP WebSocket proxy in terminalService.js:
  - WS /api/terminal/rdp -- WebSocket upgrade
  - Bridge Guacamole protocol to frontend WebSocket
  - Track RDP session in Session model
- Extend policy evaluation for RDP servers

### Task 11C: RDP File Generation [Agent: backend]
Blocked by: 11A
- Enhance accessRequestService.generateRdpFile():
  - Build .rdp file content with Guacamole gateway
  - Time-limited gateway token embedded
  - Return as downloadable file
- Ensure RDP credentials are NEVER exposed to frontend

### Task 11D: RDP Frontend [Agent: frontend]
Blocked by: 11B
- Install guacamole-common-js (or custom WebSocket client)
- Build RDP terminal component using Guacamole client
- Extend Terminal page to support RDP server type
- Add RDP icon (Lucide Monitor) distinction from SSH (Lucide Terminal) on server lists
- "Download RDP File" button on approved access requests for RDP servers

## Acceptance Criteria
- RDP server accessible via browser through Guacamole
- RDP file download works, opens in local RDP client
- RDP credentials never exposed to user
- RDP sessions tracked in sessions list
- Terminate button works for RDP sessions
- Policy evaluation works correctly for RDP servers
