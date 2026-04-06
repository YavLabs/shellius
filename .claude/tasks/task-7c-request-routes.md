# Task 7C: Access Request & Notification Routes

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 7E
**Blocked By:** 7B

## Objective
Implement all API routes for access request management and user notifications.

## Deliverables
- `src/routes/accessRequestRoutes.js`:
  - POST /access-requests — submit new request
  - GET /access-requests — list requests (filterable by status, requester)
  - GET /access-requests/pending-reviews — list requests pending current user's review
  - GET /access-requests/:id — get request details
  - POST /access-requests/:id/review — approve or deny
  - POST /access-requests/:id/credentials — generate and download SSH credentials (one-time)
  - GET /access-requests/:id/rdp-file — generate and download .rdp file
  - POST /access-requests/:id/revoke — revoke an approved request
- `src/routes/notificationRoutes.js`:
  - GET /notifications — list current user's notifications (paginated)
  - GET /notifications/unread-count — get count of unread notifications
  - PATCH /notifications/:id/read — mark notification as read
  - POST /notifications/mark-all-read — mark all as read
- Route-level validation with express-validator
- Integration tests for critical flows (submit -> review -> credentials)

## Acceptance Criteria
- All routes require JWT authentication
- Credential download endpoint enforces one-time download (tracks download status)
- Review endpoint validates reviewer is authorized (manager role or designated approver)
- Notification routes scoped to current user only (cannot read others' notifications)
- Proper HTTP status codes: 201 for create, 404 for not found, 403 for unauthorized
- Request validation rejects invalid/missing fields with descriptive errors
