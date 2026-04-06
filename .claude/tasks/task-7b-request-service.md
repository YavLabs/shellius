# Task 7B: Access Request Service

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 7C, 7D, 7E
**Blocked By:** 7A

## Objective
Implement accessRequestService.js handling the full access request lifecycle: submission with environment-based routing, manager review, credential generation (SSH ephemeral certs or RDP/Guacamole tokens), and revocation.

## Deliverables
- `src/services/accessRequestService.js` with functions:
  - `submit({ requesterId, serverId, principals, duration, justification })` — evaluate policy, auto-approve if no approval required, else set PENDING and notify managers; environment-based routing determines approval path
  - `review({ requestId, reviewerId, decision, note })` — manager approves/denies, update status, notify requester, set expiresAt based on approved duration
  - `generateSshCredentials(requestId)` — generate ephemeral Ed25519 key pair, sign public key with CA (via caService), return { privateKey, certificate, username, hostname }; private key is never stored, only returned once
  - `generateRdpFile(requestId)` — create Guacamole connection, generate auth token, return .rdp file content with gateway settings
  - `revoke(requestId, revokedBy)` — revoke access request, revoke associated certificate if SSH, delete Guacamole connection if RDP
  - `getById(id)`, `listForUser(userId, filters)`, `listPendingReviews(reviewerId)`
- Unit tests covering submit auto-approve, submit with approval, review flow, credential generation

## Acceptance Criteria
- Non-production requests with no approval policy are auto-approved
- Production requests always require approval regardless of policy
- `generateSshCredentials()` returns a valid signed certificate and private key; private key is never persisted to DB or disk
- `generateRdpFile()` returns a valid .rdp file with Guacamole gateway token
- `revoke()` cleans up all associated credentials and connections
- Notifications are created for all state transitions
- All operations include audit logging
