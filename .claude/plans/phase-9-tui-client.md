# Phase 9: TUI Client

## Goal
Build the Shellius Go TUI client using Bubble Tea -- device auth login, host list grouped by customer with environment tags, access request submission for prod, and SSH connection.

## Duration Estimate
2-3 weeks

## Dependencies
Phase 2 (Auth -- device flow), Phase 7 (Access Requests)

## Tasks

### Task 9A: Go Project Setup [Agent: tui]
- Initialize: go mod init github.com/shellius/shellius-tui
- Install: bubbletea, lipgloss, bubbles, glamour
- Create Makefile with targets: build, build-all (cross-compile), install, clean
- Create internal/config/config.go: read/write ~/.shellius/config.yaml

### Task 9B: Auth & API Client [Agent: tui]
Blocked by: 9A
- Implement internal/auth/device.go: device authorization flow
  - POST /api/auth/device/authorize -> display user_code + verification URL
  - Open browser automatically
  - Poll /api/auth/device/poll until approved
- Implement internal/auth/token.go: store tokens, auto-refresh before expiry
- Implement internal/api/client.go: HTTP client with auth headers
  - GET /api/tui/hosts -> host list with access status
  - POST /api/access-requests -> submit request
  - POST /api/access-requests/:id/ssh-credentials -> download cert
  - GET /api/access-requests -> check request status

### Task 9C: TUI Views [Agent: tui]
Blocked by: 9B
- Implement internal/tui/app.go: main Bubble Tea model, view routing (login -> hostlist -> connect)
- Implement internal/tui/login.go: device auth UI
  - Spinner while waiting
  - Display user code prominently
  - "Press Enter to open browser" prompt
  - Success/failure states
- Implement internal/tui/hostlist.go: filterable host list
  - Grouped by customer name
  - Columns: server name, environment badge, status, access status/expiry
  - Environment badges: [PROD] red, [DEV] green, [STAGING] yellow, [DEMO] blue
  - Fuzzy search by typing
  - Enter to connect (or request access for prod)
- Implement internal/tui/accessrequest.go: request form for prod servers
  - Input fields: reason, duration
  - Submit -> show "Waiting for approval" with spinner
  - Poll for approval status
- Implement internal/tui/statusbar.go: user name, org, connection status, token expiry
- Implement internal/tui/styles.go: Lipgloss styles (consistent color scheme)

### Task 9D: SSH Connection [Agent: tui]
Blocked by: 9C
- Implement internal/ssh/config.go: write cert to ~/.ssh/shellius_cert, manage temp files
- Implement internal/ssh/connect.go: exec ssh subprocess
  - Build ssh command: ssh -i key -o CertificateFile=cert -p port user@host
  - Hand off terminal to ssh process (exec.Command with Stdin/Stdout/Stderr attached)
  - Clean up cert files after disconnect
- Implement cmd/shellius/main.go: parse flags (--server, --config), run app

## Acceptance Criteria
- `shellius-tui` starts, shows login prompt
- Device auth flow: shows user code, opens browser, polls until approved
- After login, host list shows servers grouped by customer with environment badges
- Selecting a dev server -> connects immediately via SSH
- Selecting a prod server -> shows access request form -> submits -> waits for approval -> connects after approved
- Fuzzy search filters host list
- Cross-compilation produces binaries for linux/darwin/windows x amd64/arm64
