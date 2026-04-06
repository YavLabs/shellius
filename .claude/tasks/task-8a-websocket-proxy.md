# Task 8A: WebSocket SSH Proxy

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 8B, 8C
**Blocked By:** None

## Objective
Implement a WebSocket-based SSH proxy using the ws and ssh2 libraries, enabling browser-based terminal access. Connections authenticate via JWT, use CA-signed certificates for SSH auth, track active sessions, and optionally record terminal output.

## Deliverables
- `src/ws/sshProxy.js`:
  - WebSocket upgrade handler with JWT verification from query param or header
  - On connection: validate access request is APPROVED and not expired, extract SSH credentials
  - SSH connection using ssh2 with certificate-based authentication (signed cert from access request)
  - Bidirectional data relay: WebSocket <-> SSH channel
  - Terminal resize handling (client sends resize events)
  - Session lifecycle: create session record on connect, update on disconnect with duration
  - Optional recording: if enabled, write terminal output to asciinema .cast format buffer
  - Graceful cleanup on disconnect (close SSH channel, update session, finalize recording)
- `src/ws/index.js` — WebSocket server setup, attach to Express HTTP server
- Integration with existing Express app (attach WS server on /ws/ssh path)

## Acceptance Criteria
- WebSocket connection with valid JWT and approved access request establishes SSH session
- Invalid/expired JWT returns WebSocket close with appropriate error code
- Terminal input/output flows bidirectionally with minimal latency
- Terminal resize events are forwarded to the SSH session
- Session record is created on connect and updated with duration/bytes on disconnect
- Connection is terminated if access request expires during session
- Concurrent connections to different servers are supported
- Memory is properly cleaned up on disconnect (no leaks)
