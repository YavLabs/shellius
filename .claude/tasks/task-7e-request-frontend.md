# Task 7E: Access Request Frontend

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** 7C

## Objective
Build the Access Requests page with tabs for the user's own requests and pending reviews, the request submission form, approval cards, credential download panel, and the notification bell with dropdown.

## Deliverables
- `client/src/pages/AccessRequests.jsx` — two tabs:
  - "My Requests" — data table of current user's requests with status badges, actions (download credentials, revoke)
  - "Pending Reviews" — list of requests awaiting current user's approval (visible to managers only)
- `client/src/components/RequestForm.jsx` — form with server selector (grouped by customer/env), principal selection, duration picker, justification textarea; shows policy evaluation result (auto-approve vs needs approval) before submit
- `client/src/components/ApprovalCard.jsx` — card displaying request details (requester, server, justification, requested duration) with approve/deny buttons and optional review note
- `client/src/components/CredentialDownload.jsx` — panel shown after approval with SSH private key download (one-time, with copy button), certificate display, and connection instructions; or RDP file download button
- `client/src/components/NotificationBell.jsx` — header icon with unread count badge, dropdown showing recent notifications with mark-as-read, "mark all read" action
- `client/src/hooks/useAccessRequests.js` — React Query hooks for all access request and notification endpoints

## Acceptance Criteria
- RequestForm shows policy evaluation preview before submission
- Approved requests show credential download panel (SSH key + cert or RDP file)
- Credential download warns that private key is shown only once
- ApprovalCard allows approve/deny with optional note
- NotificationBell shows unread count and updates in real-time (polling or WebSocket)
- Pending Reviews tab only visible to users with manager role
- All status transitions update the UI without full page reload
- Responsive layout works on tablet and desktop
