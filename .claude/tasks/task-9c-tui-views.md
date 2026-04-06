# Task 9C: TUI Bubble Tea Views

**Agent:** tui
**Status:** [ ] Pending
**Blocks:** 9D
**Blocked By:** 9B

## Objective
Build the Bubble Tea TUI views: application routing, device auth login screen, host list with grouping and fuzzy search, access request form for production servers, status bar, and shared styles.

## Deliverables
- `tui/internal/ui/app.go`:
  - Root Bubble Tea model with view routing (login -> hostlist -> accessrequest)
  - Global key bindings (q/ctrl+c to quit, ? for help)
  - Window resize handling
- `tui/internal/ui/login.go`:
  - Display device code and verification URL
  - Spinner while polling for authorization
  - Success/failure state transitions
  - Auto-transition to hostlist on success
- `tui/internal/ui/hostlist.go`:
  - Grouped server list by customer name
  - Environment badges (dev=blue, staging=yellow, prod=red) using lipgloss
  - Fuzzy search/filter input at top
  - Server details panel on highlight (IP, OS, environment, last seen)
  - Enter to select -> if prod, go to accessrequest; if non-prod with auto-approve, connect directly
- `tui/internal/ui/accessrequest.go`:
  - Production access request form: principal selector, duration picker, justification input
  - Submit and show status (pending approval, approved, denied)
  - On approval, auto-proceed to SSH connection
- `tui/internal/ui/statusbar.go`:
  - Bottom bar showing: connected user, server URL, notification count, help hint
- `tui/internal/ui/styles.go`:
  - Shared lipgloss styles: colors, borders, badges, headings
  - Consistent with Shellius web UI color palette

## Acceptance Criteria
- App launches and shows login screen if not authenticated, hostlist if token exists
- Host list displays servers grouped by customer with correct environment badges
- Fuzzy search filters the host list in real-time
- Selecting a production server opens the access request form
- Selecting a non-prod auto-approved server proceeds to connection
- Status bar updates with current context information
- All views handle terminal resize gracefully
- Keyboard navigation works intuitively (arrow keys, enter, escape, tab)
