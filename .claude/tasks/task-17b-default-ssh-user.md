# Task 17B: Default to server.sshUser + Override Toggle

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** 17Q-B, 17R-B
**Blocked By:** None
**Model:** sonnet

## Objective
The operator already specified a `sshUser` when creating the server.
Connect/Request flows should default the principal field to that
saved value, not to the email local-part of the current user.

## Fix
- `frontend/src/components/servers/QuickConnectModal.jsx`:
  - Principal default order:
    1. `activeRequest?.requestedPrincipal`
    2. `server.sshUser`
    3. `defaultPrincipal(currentUser)`
    4. `'ubuntu'`
  - Add an "Override username" toggle (shadcn `Switch` or simple
    checkbox). Default: OFF. When OFF, the input is read-only and
    shows the saved value. When ON, the input is editable and the
    POSIX regex validation kicks in.
- `frontend/src/components/access-requests/RequestForm.jsx`:
  - Same default order. The Form already has the principal input;
    just change the default + add the override toggle.
- `frontend/src/utils/principal.js`:
  - Add a `principalForServer(activeRequest, server, user)` helper
    that implements the precedence order so both forms can call it.

## Acceptance
- Connect/Request modals open with `server.sshUser` pre-filled and
  the override toggle off.
- Toggling override on lets the user change the username.
- Existing approved requests still respect their original
  `requestedPrincipal`.
