# Task 5A: CA Key Pair & Certificate Prisma Models

**Agent:** db
**Status:** [ ] Pending
**Blocks:** 5B
**Blocked By:** None

## Objective
Define the Prisma models for SSH Certificate Authority key pairs and issued certificates, enabling persistent storage of CA metadata and certificate lifecycle tracking.

## Deliverables
- `CaKeyPair` model in `prisma/schema.prisma` with fields: id, name, algorithm (Ed25519), publicKey, encryptedPrivateKey, encryptionIv, encryptionTag, fingerprint, isActive, createdAt, rotatedAt, expiresAt
- `Certificate` model in `prisma/schema.prisma` with fields: id, caKeyPairId (FK), serial, type (USER/HOST), keyId, principals (String[]), validAfter, validBefore, extensions, criticalOptions, status (ACTIVE/REVOKED/EXPIRED), issuedTo (FK to User), issuedFor (FK to Server), revokedAt, revokedBy, createdAt
- Prisma migration for both models
- Appropriate indexes on status, serial, issuedTo, caKeyPairId

## Acceptance Criteria
- `npx prisma validate` passes with no errors
- `npx prisma migrate dev` applies cleanly
- CaKeyPair has a unique constraint on fingerprint
- Certificate has a unique constraint on serial
- Foreign keys reference User, Server, and CaKeyPair correctly
