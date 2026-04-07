# Task 14I: Certificate Download + Expiry Surfacing

**Agent:** frontend
**Status:** [x] Done
**Blocks:** 14L
**Blocked By:** None

## Objective
Two small but visible gaps in Certificates.jsx:
1. There's no way to download a cert file from the certs list — users
   can only get one through the access-request credential download.
2. There's no expiry warning anywhere in the UI; certs silently expire.

## Deliverables

### Download
- Cert detail modal: add a **Download .pub** button that downloads the
  `signedCert` field as `cert-<serial>.pub`. The data is already on the
  cert row from `getCertificate(id)`.
- Row menu: same action

### Expiry surfacing
- Reuse the existing `useCountdown` helper from `CredentialDownload.jsx`
- Cert row: render an amber pill if `validBefore` is within 24 h, red
  if expired
- Top-of-page banner if any of the user's own certs are expiring within
  24 h (use `getMyCerts({ expiringWithin: 24 })` — extend the backend
  service if needed)

## Acceptance
- Admin can download any cert as a `.pub` file.
- Users see clear visual cues for certs that are about to expire.
