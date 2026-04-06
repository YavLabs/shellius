# Task 7A: Access Request & Notification Prisma Models

**Agent:** db
**Status:** [ ] Pending
**Blocks:** 7B
**Blocked By:** None

## Objective
Define Prisma models for access requests (the core workflow entity) and notifications (for approval alerts and expiry warnings).

## Deliverables
- `AccessRequest` model in `prisma/schema.prisma` with fields: id, requesterId (FK to User), serverId (FK to Server), status (PENDING/APPROVED/DENIED/EXPIRED/REVOKED), justification (text), requestedPrincipals (String[]), requestedDuration (Int, seconds), environment (String), reviewerId (FK to User, nullable), reviewedAt (DateTime, nullable), reviewNote (String, nullable), credentialType (SSH/RDP), approvedAt, expiresAt, createdAt, updatedAt
- `Notification` model in `prisma/schema.prisma` with fields: id, userId (FK to User), type (REQUEST_SUBMITTED/REQUEST_APPROVED/REQUEST_DENIED/REQUEST_EXPIRING/REQUEST_EXPIRED), title, message, relatedRequestId (FK to AccessRequest, nullable), isRead (Boolean, default false), createdAt
- Prisma migration for both models
- Indexes on AccessRequest.status, AccessRequest.requesterId, AccessRequest.serverId, AccessRequest.expiresAt, Notification.userId+isRead

## Acceptance Criteria
- `npx prisma validate` passes with no errors
- `npx prisma migrate dev` applies cleanly
- AccessRequest foreign keys reference User and Server correctly
- Notification foreign keys reference User and AccessRequest correctly
- Appropriate cascade behavior on delete
