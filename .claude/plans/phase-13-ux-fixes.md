# Phase 13: UX & Data-Plumbing Fixes

This phase patches the broken access-request → web-terminal flow and a class
of API-envelope unwrap bugs that were causing pages to render blanks even
when the backend was returning the right data.

## Background

After the shadcn/Radix UI refactor in Phase 12, several pages started showing
blank fields or empty lists despite the backend returning data correctly.
Root cause is consistent: backend wraps responses as
`{ success, data: { entityName }, meta }`, while frontend services were
returning the wrapper instead of unwrapping `data.entityName`. The
`AccessRequests` detail modal was the most visible failure — every field
rendered as `-` because `request.requester`, `request.status`, etc. were
all `undefined` on the wrapper object. As a side effect the
`CredentialDownload` block (which gates on `request.status === 'APPROVED'`)
never rendered, so the **Open Web Terminal** button was effectively
unreachable from the UI.

## Goals

1. Fix the access-request detail modal so every field from the API renders.
2. Make the **Open Web Terminal** button reachable from the access-requests
   list and detail views as soon as a request is approved.
3. Audit every frontend service for the same envelope-unwrap bug and
   normalize them so pages no longer need to defensively guess shapes.
4. Add a planning trail (this doc + sub-tasks) describing what was changed
   and which agent owns each change.

## Out of scope

- New backend routes
- Schema changes
- Bootstrap install flow (already shipped in Phase 12 follow-up)

## Sub-tasks

| ID  | Agent      | Description                                                          |
|-----|------------|----------------------------------------------------------------------|
| 13A | frontend   | Unwrap accessRequestService responses and fix AR detail modal        |
| 13B | frontend   | Make Web Terminal entry point reachable end-to-end                   |
| 13C | frontend   | Audit & unwrap remaining service modules with the same bug class     |
| 13D | qa         | Smoke-test the AR → Approve → Open Web Terminal → SSH session flow   |

## Acceptance criteria

- Opening any access-request detail modal shows hostname, environment,
  requester, reviewer (if any), reason, principal, durations, expiry,
  created, denied reason — never `-` when the backend returned a value.
- For an APPROVED request owned by the current user, the credential block
  renders with **Open Web Terminal** (SSH) or **Open in Browser (RDP)**.
- Clicking **Open Web Terminal** opens `/terminal?requestId=…` and the
  WebTerminal connects to the live SSH session.
- No frontend service returns `r.data` raw — all return either the
  unwrapped row or `{ data, meta }` with documented shape.
