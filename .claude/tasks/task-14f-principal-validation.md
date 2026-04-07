# Task 14F: Principal Validation in RequestForm

**Agent:** frontend
**Status:** [x] Done (frontend + backend)
**Blocks:** 14L
**Blocked By:** None

## Objective
The Access Request form defaults the SSH principal to
`user.username || user.name || 'ubuntu'`. For users whose `name` is a
display string with spaces and capitals (e.g. "Super Admin"), this
produces an invalid Unix username. The certificate is signed correctly
but the target sshd refuses cert auth because no local user matches the
principal — and the new `terminalService` error message reports exactly
this. The form should never let an invalid principal through.

## Deliverables

### Validation
- `frontend/src/components/access-requests/RequestForm.jsx`:
  - Helper `toLinuxUser(s)` that strips non-`[a-z0-9_-]` chars,
    lowercases, truncates to 32, and returns `'' ` if the result is empty
  - Default principal to:
    1. `user.username` if present
    2. else `toLinuxUser(user.email.split('@')[0])` if email is present
    3. else `'ubuntu'`
    Never `user.name`.
  - Live validation on the principal `<Input>`:
    - regex `^[a-z_][a-z0-9_-]{0,31}$` (Unix POSIX-ish username pattern)
    - shows an inline error if invalid
  - Submit button disabled while invalid
  - Inline help: "The Linux username on the target host (lowercase
    letters, digits, underscore, hyphen)."

### Server-side defense in depth
- `backend/src/routes/accessRequests.js` create-schema:
  - Joi `requestedPrincipal` pattern enforcement; reject otherwise
  - 400 with a clear message when violated

### Existing data
- The bad request that's already in the DB (`requestedPrincipal: "Super Admin"`)
  cannot be repaired without re-creation. Document in `task-14L`'s smoke
  test that the QA agent should create a fresh request with a valid
  principal as the success path.

## Acceptance
- Cannot submit a request with `Super Admin`, `john doe`, `Foo Bar`, etc.
- Default principal for `admin@yavlabs.com` is `admin`, not `Super Admin`.
- Backend rejects bad principals even when called from the TUI / API.
