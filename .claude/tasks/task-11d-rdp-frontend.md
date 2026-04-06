# Task 11D: RDP Frontend

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** 11B

## Objective
Build a browser-based RDP terminal component using the Guacamole JavaScript client, extend the Terminal page to support RDP sessions, and add an RDP file download button to approved access requests.

## Deliverables
- `client/src/components/RdpTerminal.jsx`:
  - Guacamole JavaScript client (guacamole-common-js) integration
  - WebSocket connection to /ws/rdp with JWT auth
  - Canvas-based RDP display with mouse and keyboard input
  - Clipboard sync (copy/paste between local and remote)
  - Connection status indicator (connecting, connected, disconnected, error)
  - Fullscreen toggle
  - Scale-to-fit option
- Terminal page (`client/src/pages/Terminal.jsx`) updates:
  - Detect connection type (SSH vs RDP) from access request
  - Render WebTerminal for SSH, RdpTerminal for RDP
  - Shared header with server name, session timer, disconnect button
- RDP file download integration:
  - "Download .rdp File" button on approved RDP access requests
  - Shown alongside "Connect in Browser" button
- `client/src/hooks/useRdpTerminal.js` — Guacamole client connection hook

## Acceptance Criteria
- RDP sessions render in the browser with full mouse and keyboard support
- Clipboard sync works between local machine and remote desktop
- Fullscreen mode fills the browser viewport
- Scale-to-fit adjusts the remote desktop to the browser window
- Terminal page correctly switches between SSH and RDP rendering
- .rdp file download button triggers file download
- Connection errors display user-friendly messages
- RDP sessions appear in the active sessions list
