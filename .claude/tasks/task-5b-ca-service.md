# Task 5B: CA Service

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 5C
**Blocked By:** 5A

## Objective
Implement caService.js to manage SSH Certificate Authority operations including key pair generation, certificate signing, revocation, and key rotation. CA private keys must be encrypted at rest and only decrypted in memory during signing.

## Deliverables
- `src/services/caService.js` with functions:
  - `generateCaKeyPair()` — generate Ed25519 key pair, encrypt private key with AES-256-GCM using app secret, store in DB
  - `signCertificate({ publicKey, principals, validitySeconds, certType, extensions })` — decrypt CA private key in memory, invoke `ssh-keygen -s` to sign, return signed certificate, zero out private key buffer after use
  - `revokeCertificate(certId)` — mark certificate as revoked in DB
  - `rotateCaKeyPair()` — generate new key pair, mark old as inactive, return new public key
  - `getPublicKey()` — return the active CA public key
  - `getFingerprint()` — return the active CA key fingerprint
- Unit tests in `src/services/__tests__/caService.test.js`

## Acceptance Criteria
- `generateCaKeyPair()` creates a valid Ed25519 key pair and stores encrypted private key in DB
- `signCertificate()` produces a valid SSH certificate verifiable with `ssh-keygen -L`
- CA private key is never written to disk unencrypted; decrypted only in a temporary buffer that is zeroed after use
- `rotateCaKeyPair()` deactivates the old key and activates the new one atomically
- `getPublicKey()` returns the currently active CA public key
- All functions include audit logging calls
