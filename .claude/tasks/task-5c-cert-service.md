# Task 5C: Certificate Service

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 5D
**Blocked By:** 5B

## Objective
Implement certificateService.js for certificate issuance with policy checks, listing, revocation, and verification. Add API routes for certificate and CA management. Create a BullMQ job for certificate expiry processing.

## Deliverables
- `src/services/certificateService.js` with functions:
  - `issue({ userId, serverId, principals, validitySeconds })` — check access policy before issuing, call caService.signCertificate, persist Certificate record
  - `list({ userId, serverId, status, page, limit })` — paginated certificate listing with filters
  - `revoke(certId, revokedBy)` — revoke certificate via caService, update record
  - `verify(certSerial)` — verify certificate validity and check principals (for AuthorizedPrincipalsCommand)
- `src/routes/certificateRoutes.js` — POST /certificates, GET /certificates, DELETE /certificates/:id, GET /certificates/:id/verify
- `src/routes/caRoutes.js` — GET /ca/public-key, POST /ca/rotate, GET /ca/fingerprint
- `src/jobs/certExpiry.js` — BullMQ repeatable job that marks expired certificates as EXPIRED
- Unit tests for certificateService

## Acceptance Criteria
- `issue()` refuses to create a certificate when the access policy denies it
- `issue()` creates a valid certificate and persists it with correct metadata
- `verify()` returns principal list for valid certificates and rejects revoked/expired ones
- certExpiry job correctly transitions ACTIVE certificates past validBefore to EXPIRED status
- All routes require authentication and appropriate role checks
- CA rotate endpoint restricted to admin role
