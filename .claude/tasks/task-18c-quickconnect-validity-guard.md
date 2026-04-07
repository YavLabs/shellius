# Task 18C: QuickConnect AR validity guard

**Agent:** debugger → frontend + backend
**Status:** [ ] Pending
**Blocks:** 18Q-C, 18R-C
**Blocked By:** None
**Model:** sonnet

## Symptom
The QuickConnectButton on Servers row shows "Connect" even when:
- The user has no access request for the server, OR
- The user's access request has expired

It should show "Request Access" in those cases.

## Diagnosis steps
1. Hit `GET /api/access-requests/by-server/<serverId>/active` for a
   server where the latest AR is expired. Verify the response is
   `{accessRequest: null}` — if not, the backend filter is broken.
2. Check `backend/src/services/accessRequestService.js`
   `getActiveByServerForUser` — the WHERE clause should have
   `expiresAt: { gt: now }, status: 'APPROVED'`.
3. Check `frontend/src/components/servers/QuickConnectButton.jsx` —
   does `hasAccess` rely on truthiness alone, or does it also verify
   `status === 'APPROVED'` and `expiresAt > now()`?

## Fix
- Backend: ensure `getActiveByServerForUser` filters on both
  `status: 'APPROVED'` AND `expiresAt: { gt: now }`. Add a Jest test
  case that asserts an expired or DENIED row is excluded.
- Frontend: defensive double-check in QuickConnectButton:
  ```js
  const hasAccess =
    !!activeRequest &&
    activeRequest.status === 'APPROVED' &&
    activeRequest.expiresAt &&
    new Date(activeRequest.expiresAt) > new Date();
  ```
- Frontend: poll `getActiveAccessForServer` every 60s while the
  Servers page is open so a request that expires mid-session flips
  the button without a manual reload.

## Acceptance
- A user with no AR for a server sees "Request Access"
- A user with an expired AR sees "Request Access"
- A user with a DENIED AR sees "Request Access"
- A user with an APPROVED, non-expired AR sees "Connect"
- A user whose AR expires while the Servers page is open sees the
  button flip to "Request Access" within 60 seconds
