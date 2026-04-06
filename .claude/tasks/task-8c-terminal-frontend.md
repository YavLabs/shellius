# Task 8C: Web Terminal Frontend

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** 8A

## Objective
Build a browser-based terminal using xterm.js connected via WebSocket to the SSH proxy, a Terminal page, and a connect button on approved access requests.

## Deliverables
- `client/src/components/WebTerminal.jsx`:
  - xterm.js terminal instance with fit addon, web links addon, search addon
  - WebSocket connection to /ws/ssh with JWT auth
  - Terminal resize handling (send resize events on window/container resize)
  - Connection status indicator (connecting, connected, disconnected, error)
  - Reconnect button on disconnect
  - Copy/paste support
  - Configurable font size and theme (dark)
- `client/src/pages/Terminal.jsx`:
  - Full-screen terminal layout with minimal chrome
  - Header with server name, session duration timer, disconnect button
  - Connection info sidebar (collapsible): server details, session ID, connected since
- Connect button integration:
  - "Connect" button on approved access requests in AccessRequests page
  - Clicking navigates to Terminal page with access request ID
- `client/src/hooks/useTerminal.js` — WebSocket connection management hook

## Acceptance Criteria
- Terminal renders and connects to SSH session via WebSocket
- Text input and output work correctly with proper encoding
- Terminal resizes responsively when browser window changes
- Connection status is clearly visible to the user
- Disconnect button closes the session gracefully
- Session duration timer updates every second while connected
- Connect button only appears on APPROVED, non-expired access requests
- Terminal supports standard keyboard shortcuts (Ctrl+C, Ctrl+D, etc.)
