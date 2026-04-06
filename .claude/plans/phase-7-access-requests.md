# Phase 7: Access Request & Approval Flow

## Goal
Implement the full production server approval workflow: request submission, manager review, credential delivery (web terminal, SSH key download, RDP file download), expiry management, and notification system.

## Duration Estimate
2-3 weeks

## Dependencies
Phase 5 (CA) and Phase 6 (Policies) complete

## Tasks

### Task 7A: Access Request Models [Agent: db]
- AccessRequest: requester_id, server_id, reviewer_id (manager), status (pending/approved/denied/expired/revoked), reason, requested_principal, requested_duration, protocol, approved_duration, approved_at, denied_at, denied_reason, expires_at, revoked_at, revoked_reason, certificate_id, created_at, updated_at
- Notification: user_id, type (access_request_submitted/approved/denied/expiring/expired/revoked), title, body, metadata (Json), is_read, read_at, created_at
- Indexes: (requester_id), (reviewer_id, status), (server_id), (status, expires_at), (user_id, is_read)

### Task 7B: Access Request Service [Agent: backend]
Blocked by: 7A
- accessRequestService.js:
  - submit(requesterId, serverId, reason, duration, principal, protocol):
    1. Load server, check environment
    2. If prod -> create pending request, set reviewer_id = user.manager_id (error if no manager)
    3. If dev/demo -> evaluate policy, if autoApprove -> immediately approve
    4. If staging -> check policy requireApproval
    5. Create notification for reviewer
  - review(requestId, reviewerId, decision, duration?, reason?):
    - Verify caller is reviewer_id
    - If approve: set status=approved, approved_duration, expiresAt = now + duration
    - If deny: set status=denied, denied_reason
    - Create notification for requester
  - generateSshCredentials(requestId):
    - Verify approved + not expired
    - Generate ephemeral Ed25519 key pair
    - Sign with CA (ttl = time remaining until expiresAt)
    - Return: { privateKey, certificate, hostname, port, username, expiresAt, connectCommand }
    - NEVER store private key server-side
  - generateRdpFile(requestId):
    - Verify approved + not expired
    - Generate Guacamole gateway token
    - Build .rdp file content
    - Return downloadable .rdp file
  - revoke(requestId, reason): set status=revoked, revoke associated certificate

### Task 7C: Access Request Routes [Agent: backend]
Blocked by: 7B
- Routes:
  - POST /api/access-requests (all roles)
  - GET /api/access-requests (all -- my requests + requests to review if manager)
  - GET /api/access-requests/:id (requester or reviewer)
  - PATCH /api/access-requests/:id/review (reviewer only)
  - POST /api/access-requests/:id/revoke (admin+ or reviewer)
  - POST /api/access-requests/:id/ssh-credentials (requester, approved only)
  - POST /api/access-requests/:id/rdp-credentials (requester, approved only)
  - POST /api/access-requests/:id/connect (requester, approved only -- start web terminal)
- Notification routes:
  - GET /api/notifications (all -- my notifications)
  - PATCH /api/notifications/:id/read (all)
  - PATCH /api/notifications/read-all (all)

### Task 7D: Expiry Jobs [Agent: backend]
Blocked by: 7B
- jobs/expireAccessRequests.js: every 1 min, approved requests past expiresAt -> status=expired, revoke cert
- jobs/expirePendingRequests.js: every 5 min, pending requests older than 24h -> status=expired
- jobs/notifyExpiringAccess.js: every 1 min, approved requests expiring in 10 min -> send warning notification (deduplicated)

### Task 7E: Access Request Frontend [Agent: frontend]
Blocked by: 7C
- Build AccessRequests page with two tabs: "My Requests" and "Pending Reviews" (for managers)
- Build RequestForm dialog: select server, enter reason, set duration, select principal
- Build ApprovalCard: shows request details, approve button (with duration picker), deny button (with reason input)
- Build CredentialDownload panel: "Open Web Terminal" button, "Download SSH Key" button, "Download RDP File" button (shown based on server protocol)
- Build notification bell in Topbar with unread count badge
- Build NotificationDropdown: list of notifications with mark-as-read
- Build NotificationContext for real-time notification polling

## Acceptance Criteria
- User requests prod access -> manager gets notification -> approves with 2h -> user can download SSH key+cert -> SSH works
- After 2h, access automatically expires and cert is invalidated
- Denied requests show reason
- RDP file download works for RDP servers
- Pending requests auto-expire after 24h
- Users get 10-min expiry warning notification
- Only assigned manager can approve (others get 403)
