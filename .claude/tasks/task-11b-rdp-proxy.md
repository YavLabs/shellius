# Task 11B: RDP WebSocket Proxy

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 11D
**Blocked By:** 11A

## Objective
Implement a WebSocket proxy that bridges the Guacamole protocol between the browser client and guacd, with RDP session tracking integrated into the existing session system.

## Deliverables
- `src/ws/rdpProxy.js`:
  - WebSocket upgrade handler at /ws/rdp with JWT authentication
  - On connection: validate access request is APPROVED (type RDP) and not expired
  - Connect to guacd using Guacamole protocol (guacamole-lite or custom implementation)
  - Bridge Guacamole instructions between WebSocket client and guacd
  - Session lifecycle: create session record (type RDP) on connect, update on disconnect
  - Handle clipboard sync, file transfer instructions if supported
  - Graceful disconnect and cleanup
- Integration with `src/ws/index.js` — add /ws/rdp route alongside /ws/ssh
- RDP session tracking via existing sessionService (type: RDP)
- Connection termination on access request expiry

## Acceptance Criteria
- WebSocket connection at /ws/rdp establishes Guacamole protocol tunnel to guacd
- JWT authentication is required and validated before connection
- RDP sessions appear in session tracking alongside SSH sessions
- Session duration and status are tracked correctly
- Admin can terminate RDP sessions via session management
- Connection is dropped if the underlying access request expires
- Multiple concurrent RDP sessions are supported
- Memory and connection cleanup on disconnect
