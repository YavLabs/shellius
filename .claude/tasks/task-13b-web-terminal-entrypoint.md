# Task 13B: Reachable Web Terminal Entry Point

**Agent:** frontend
**Status:** [x] Done
**Blocks:** 13D
**Blocked By:** 13A

## Objective
After Task 13A the access request detail modal shows real data, which means
the `CredentialDownload` block (gated on `request.status === 'APPROVED'`)
will now render. That block already contains the **Open Web Terminal**
button — but verify the full path is reachable end-to-end:

1. Servers row → **Request Access** (DropdownMenuItem) → opens
   `/access-requests?new=1&serverId=…`.
2. AR list opens the create modal pre-selected with the server.
3. After submit, the new AR appears in the list (auto-approved for
   non-prod policies).
4. Click the row → detail modal opens → `CredentialDownload` renders →
   **Open Web Terminal** is present.
5. Click → navigates to `/terminal?requestId=…`.
6. `WebTerminal.jsx` opens the WebSocket and starts the session.

## Files (verify, no changes needed beyond 13A)
- `frontend/src/pages/Servers.jsx` — row menu already has "Request Access"
- `frontend/src/pages/AccessRequests.jsx` — `?new=1&serverId=…` handling
  already wired in Phase 12
- `frontend/src/components/access-requests/CredentialDownload.jsx` —
  contains the **Open Web Terminal** button; only needed `request.status`
  to be defined, which 13A fixes
- `frontend/src/components/terminal/WebTerminal.jsx` — already fixed in
  Phase 12 follow-up (ssh2 cert auth + portal-friendly status bar)

## Acceptance
- A non-admin user with an approved request can click through:
  Servers → Request Access → submit → click new row → Open Web Terminal →
  reach a working SSH shell, no manual URL editing.
