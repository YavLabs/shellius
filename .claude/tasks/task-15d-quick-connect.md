# Task 15D: Quick Connect on Servers Row

**Agent:** frontend (+ backend touchpoint)
**Status:** [x] Done
**Blocks:** 15Q-D, 15R-D
**Blocked By:** None
**Model:** sonnet (default)

## Objective
Replace the current 5-click flow (row menu → Request Access → fill form
→ wait for approval → click row → Open Web Terminal) with a 2-click
"Connect" button per server row.

## Backend (15D2 — sub-task)

New endpoint:

```
GET /api/access-requests/by-server/:serverId/active
```

Returns the calling user's most recent access request for that server
that is `APPROVED` and `expiresAt > now`. If multiple, return the one
with the latest `approvedAt`. If none, return `{ data: { accessRequest: null } }`.

Implementation in `backend/src/routes/accessRequests.js` + a thin
service method `accessRequestService.getActiveByServerForUser(userId, serverId)`.
RBAC: any authenticated user, scoped to their own requests.

## Frontend

### New service method
`frontend/src/services/accessRequestService.js`:
```js
export const getActiveAccessForServer = (serverId) =>
  api.get(`/access-requests/by-server/${serverId}/active`)
     .then((r) => r.data?.data?.accessRequest ?? r.data?.data ?? null);
```

### New component
`frontend/src/components/servers/QuickConnectButton.jsx`:
- Props: `{ server, currentUser }`
- On mount, calls `getActiveAccessForServer(server.id)`. While loading,
  shows a disabled spinner button.
- If a non-expired approved request exists → button label is **Connect**
  (Terminal icon). Click opens `QuickConnectModal` pre-filled with the
  active request's principal.
- Else → button label is **Request Access** (KeyRound icon). Click
  opens `QuickConnectModal` in "request" mode.

### New modal
`frontend/src/components/servers/QuickConnectModal.jsx`:
- Header: hostname + env badge + protocol
- Body:
  - Read-only "Host" + "Port" + "Protocol" fields
  - "Connect as" — `<Input>` pre-filled with the principal (from the
    active request, or the user's `defaultPrincipal(user)` helper).
    Inline POSIX validation (re-use the regex from RequestForm).
  - If in "request" mode: a "Reason" textarea (required, ≥ 10 chars)
    and a "Duration" select (15m / 1h / 4h / 8h).
- Footer:
  - "Cancel"
  - **Connect** primary CTA. On click:
    - **Connect mode**: `window.open('/terminal?requestId=' + active.id, '_blank')`
    - **Request mode**: POST `/access-requests` → if the response is
      auto-approved (`status === 'APPROVED'`), open the new tab
      immediately. If still PENDING (prod with manager approval), show
      a banner "Request submitted — awaiting manager approval" and
      close the modal.

### Servers row
In `frontend/src/pages/Servers.jsx`, add `QuickConnectButton` as the
first action in the row's actions array (Task 15C). Keep the existing
row menu items (Edit, Bootstrap, Health Check, Delete) accessible via
the kebab.

### Default principal helper
Move `defaultPrincipal(user)` and `LINUX_USER_RE` from
`RequestForm.jsx` into `frontend/src/utils/principal.js` and import
from both forms.

## Acceptance
- Servers list shows a per-row Connect button. Two clicks to a live
  shell on a bootstrapped non-prod host.
- For prod servers requiring approval: clicking Connect opens the
  Quick Connect modal in request mode and the existing approval flow
  takes over.
- Cert issuance is still server-side; the user only sees the modal
  + new tab.
