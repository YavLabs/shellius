# Task 14j: Notifications Page + Mark-All-Read

**Agent:** frontend
**Status:** [x] Done
**Blocks:** 14L
**Blocked By:** None

## Objective
The backend has full notifications endpoints and the topbar bell already
shows unread count, but there is no dedicated `/notifications` page and
no mark-all-read action. Users have nowhere to review or dismiss past
notifications.

## Deliverables
- New `frontend/src/pages/Notifications.jsx`:
  - PageHeader (Bell icon)
  - DataTable with columns: created, type, body, related entity, isRead
  - Row click → navigates to the linked AR / cert / session
  - Bulk action: "Mark all read" → `markAllNotificationsRead()`
  - Filter: All / Unread
- Route added in `App.jsx`: `/notifications` → `Notifications`
- `Sidebar.jsx`: add Notifications under Audit section
- `NotificationBell.jsx` dropdown: "View all" link → `/notifications`,
  "Mark all read" button calls the API and refreshes the bell count

## Acceptance
- Bell badge clears on mark-all-read.
- Users can see and dismiss every notification their account has received.
