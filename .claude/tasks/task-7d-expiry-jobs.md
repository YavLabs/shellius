# Task 7D: Access Request Expiry Jobs

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** 7B

## Objective
Implement three BullMQ repeatable jobs to handle access request lifecycle transitions: expiring approved requests, expiring stale pending requests, and notifying users before expiry.

## Deliverables
- `src/jobs/expireApproved.js` — runs every 1 minute, finds APPROVED requests where expiresAt < now, transitions to EXPIRED, revokes associated certificates, creates EXPIRED notification
- `src/jobs/expirePending.js` — runs every 5 minutes, finds PENDING requests older than configurable threshold (default 48 hours), transitions to EXPIRED, notifies requester
- `src/jobs/notifyExpiring.js` — runs every 1 minute, finds APPROVED requests expiring within 15 minutes that haven't been notified, creates REQUEST_EXPIRING notification, marks as notified (add expiryNotifiedAt field)
- Register all three jobs in the existing job runner/worker setup
- Unit tests for each job's core logic

## Acceptance Criteria
- Approved requests are expired within 2 minutes of their expiresAt time
- Pending requests older than 48 hours are automatically expired
- Users receive a notification 15 minutes before their approved access expires
- Expiry notification is sent exactly once per request (no duplicates)
- Certificate revocation is called for expired SSH requests
- Jobs are idempotent and handle concurrent execution safely
- Job failures are logged and retried with exponential backoff
