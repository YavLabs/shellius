# Phase 5: SSH Certificate Authority

## Goal
Implement the SSH CA -- key pair generation, certificate signing via ssh-keygen, revocation, and the verify endpoint used by check-principals on target hosts.

## Duration Estimate
1-2 weeks

## Dependencies
Phase 3 complete (Server model exists)

## Tasks

### Task 5A: CA Models [Agent: db]
**Status:** [ ] Pending

- Add CaKeyPair model: org_id, public_key, encrypted_private_key, key_type (ed25519/rsa), fingerprint, is_active, created_at, expires_at, rotated_at
- Add Certificate model: org_id, user_id, server_id, ca_key_id, serial (unique bigint), public_key, signed_cert, principal, principals[], extensions (Json), valid_after, valid_before, is_revoked, revoked_at, revoked_by, issued_via (web/tui/api), created_at
- Run migration

### Task 5B: CA Service [Agent: backend]
**Status:** [ ] Pending
**Blocked By:** 5A

- Implement caService.js:
  - generateCaKeyPair(): generate Ed25519 key pair, encrypt private key with SERVER_ENCRYPTION_KEY (AES-256-GCM), store in DB
  - signCertificate(userPubKey, principals, ttl, extensions): decrypt CA key -> write to temp file -> ssh-keygen -s -> read signed cert -> cleanup temp files -> return cert
  - revokeCertificate(serial): mark as revoked in DB
  - rotateCaKey(): generate new pair, mark old as inactive
  - getPublicKey(orgId): return active CA public key
- SECURITY: CA private key decrypted in memory ONLY during signing. Temp files cleaned up immediately.

### Task 5C: Certificate Service & Routes [Agent: backend]
**Status:** [ ] Pending
**Blocked By:** 5B

- Implement certificateService.js:
  - issueCertificate(userId, serverId, principal, ttl): validate -> sign -> store record
  - listCertificates(orgId, filters): query with status/user/expiry filters
  - revoke(certId, revokedBy): mark revoked, add audit entry
  - verify(fingerprint, requestedUsername, agentId): validate cert + access request still active (for check-principals)
- Implement routes/certificates.js:
  - GET /api/certificates (admin+)
  - GET /api/certificates/:id (admin+ or owner)
  - POST /api/certificates/issue (all -- policy check)
  - POST /api/certificates/:id/revoke (admin+)
  - GET /api/certificates/my-certs (all)
  - POST /api/certificates/verify (agent auth -- called by check-principals on hosts)
- Implement routes/ca.js:
  - GET /api/ca/public-key (admin+)
  - POST /api/ca/rotate (super_admin)
  - GET /api/ca/status (admin+)
- Implement jobs/certExpiry.js: check for expiring certs, send notifications

### Task 5D: CA Frontend [Agent: frontend]
**Status:** [ ] Pending
**Blocked By:** 5C

- Build Certificates page: data table with status badge, user, server, principal, expiry countdown, revoke button
- Build CA section in Settings page: current CA fingerprint, public key display (copyable), rotate button with confirmation dialog
- Certificate detail modal: full cert info, revocation history

## Acceptance Criteria
- /generate-ca creates CA key pair, stored encrypted in DB
- POST /api/certificates/issue signs a cert, returns it, stores record
- ssh-keygen -L -f cert shows correct principals, TTL, CA fingerprint
- POST /api/certificates/:id/revoke marks cert as revoked
- POST /api/certificates/verify returns valid=true for active cert, valid=false for revoked/expired
- Certificates page shows all certs with correct status badges
