# Phase 8: Web Terminal

## Goal
Implement browser-based SSH terminal using xterm.js + WebSocket + ssh2, integrated with the access request system. Include optional session recording.

## Duration Estimate
1-2 weeks

## Dependencies
Phase 7 complete (Access Request system exists)

## Tasks

### Task 8A: WebSocket SSH Proxy [Agent: backend]
- Install: ws, ssh2, @xterm/xterm (for reference)
- Implement terminalService.js:
  - Accept WebSocket upgrade with JWT auth
  - Validate access request (approved, not expired)
  - Generate ephemeral cert if not already issued
  - Establish SSH connection to target server using ssh2 + cert
  - Pipe stdin/stdout between WebSocket and SSH stream
  - Handle resize events (SIGWINCH)
  - Track session (create Session record on connect, update on disconnect)
  - Optional: tee output to recording file (asciinema .cast format)
- Implement routes/terminal.js:
  - WS /api/terminal/ssh -- WebSocket upgrade handler
- Session model updates: link to access_request_id

### Task 8B: Session Tracking [Agent: backend]
Blocked by: 8A
- Implement sessionService.js: create on connect, update on disconnect (duration, ended_at)
- Implement routes/sessions.js:
  - GET /api/sessions (operator+)
  - GET /api/sessions/active (operator+)
  - GET /api/sessions/:id (operator+)
  - POST /api/sessions/:id/terminate (admin+ -- force disconnect)
- Add Session model if not exists: org_id, user_id, server_id, certificate_id, access_request_id, session_type, status, client_ip, user_agent, started_at, ended_at, duration_seconds, recording_path, metadata

### Task 8C: Web Terminal Frontend [Agent: frontend]
Blocked by: 8A
- Install: @xterm/xterm, @xterm/addon-fit, @xterm/addon-web-links
- Build WebTerminal component: xterm.js instance, WebSocket connection, resize handling, connection status indicator
- Build Terminal page: accessible from approved access request "Open Web Terminal" button
- Add "Connect" button on server list (only for servers with approved access)
- Handle connection errors, reconnection, session ended states

## Acceptance Criteria
- Click "Open Web Terminal" on approved request -> WebSocket connects -> SSH session opens in browser
- Terminal resizes correctly
- Session appears in sessions list with start time
- Closing terminal updates session with end time and duration
- Force-terminate from admin UI disconnects the session
- Terminal shows connection status (connecting, connected, disconnected)
