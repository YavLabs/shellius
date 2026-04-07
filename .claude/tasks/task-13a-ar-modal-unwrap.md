# Task 13A: Unwrap accessRequestService + Fix AR Detail Modal

**Agent:** frontend
**Status:** [x] Done
**Blocks:** 13B
**Blocked By:** None

## Objective
Stop rendering blank/hyphen fields in the access-request detail modal. The
backend returns `{ success, data: { accessRequest }, meta }`; the service
was returning `r.data` (the envelope) and the modal was reading
`request.requester`, `request.status`, etc. on the wrapper, getting
`undefined` everywhere.

## Files
- `frontend/src/services/accessRequestService.js`
- `frontend/src/pages/AccessRequests.jsx`

## Changes
1. Add an `unwrapAr` helper that returns
   `r.data?.data?.accessRequest ?? r.data?.data ?? r.data`.
2. Apply it to: `getAccessRequest`, `createAccessRequest`,
   `reviewAccessRequest`, `revokeAccessRequest`.
3. `listAccessRequests` returns `{ data: r.data.data, meta: r.data.meta }`
   so the existing `resp.data.items` / `resp.meta.total` reads keep working.
4. `getSshCredentials` / `getRdpCredentials` / `startConnect` /
   `getRdpGatewayToken` unwrap their `data.{credentials|...}` payloads.
5. In `RequestDetailModal.fetchDetail`, replace
   `setRequest(resp.data || resp)` with `setRequest(ar)` where `ar` is the
   already-unwrapped object from the service.

## Acceptance
- The detail modal for the AR returned by `GET /api/access-requests/<id>`
  shows hostname, environment, protocol, status, requester, reason,
  principal, durations, expires-at, created-at — never `-` when the API
  returned a value.
