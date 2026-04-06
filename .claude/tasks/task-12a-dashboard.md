# Task 12A: Dashboard Page

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** None

## Objective
Build the main Dashboard page with overview cards, quick actions, the "My Access" panel, and a recent activity feed.

## Deliverables
- `client/src/pages/Dashboard.jsx`:
  - Overview cards row:
    - Servers by environment (dev/staging/prod counts with color-coded badges)
    - Active sessions count (with link to Sessions page)
    - Pending requests count (with link to Access Requests page)
    - Certificates expiring soon count
  - Quick actions section:
    - "Request Access" button -> opens RequestForm
    - "Connect to Server" button -> opens server selector
    - "View Audit Log" link (admin only)
  - "My Access" panel:
    - List of servers the current user has active access to
    - Grouped by customer/environment
    - Each entry shows: server name, environment badge, time remaining, "Connect" button
  - Recent activity feed:
    - Last 10 audit events relevant to current user
    - Each entry: icon by type, description, relative timestamp
    - "View All" link to Audit Log page
- `client/src/hooks/useDashboard.js` — React Query hooks for dashboard data (stats, my access, recent activity)

## Acceptance Criteria
- Dashboard loads with all panels populated from real API data
- Overview cards show correct counts from backend
- Quick actions navigate to correct pages/modals
- My Access panel shows only servers with active approved access for current user
- Connect button on My Access entries navigates to Terminal page
- Recent activity shows events with correct icons and relative timestamps
- Dashboard is responsive: cards stack on mobile, side-by-side on desktop
- Admin-only elements are hidden for non-admin users
