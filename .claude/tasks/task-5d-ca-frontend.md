# Task 5D: CA & Certificates Frontend

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** 5C

## Objective
Build the Certificates page with a data table for viewing and revoking certificates, and a CA management section in Settings showing the CA fingerprint, public key, and rotate action.

## Deliverables
- `client/src/pages/Certificates.jsx` — data table with columns: serial, issued to, server, principals, valid until, status; row actions: revoke; filters by status; pagination
- `client/src/hooks/useCertificates.js` — React Query hooks for certificate CRUD and CA endpoints
- CA section in Settings page:
  - Display active CA fingerprint and public key (copyable)
  - "Rotate CA" button with confirmation dialog warning about invalidation of existing certificates
  - Last rotation timestamp
- Certificate revoke confirmation modal

## Acceptance Criteria
- Certificates page loads and displays certificates in a sortable, filterable data table
- Revoking a certificate updates its status in the table without full page reload
- CA fingerprint and public key are displayed correctly in Settings
- CA rotation triggers confirmation dialog before executing
- All API errors are shown as toast notifications
- Page is responsive and follows the existing design system
