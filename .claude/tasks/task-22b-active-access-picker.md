# Task 22b — Default view: active access picker

**Phase:** 22
**Plan:** `.claude/plans/phase-22-tui-redesign.md`
**Agent:** tui + backend
**Depends on:** task-22a

## Scope
Replace the current all-servers list as the default TUI view with a "my active access requests" picker that takes the user straight to SSH with one keystroke.

## Steps (backend)
1. Add `?mine=true&active=true` query params to `GET /api/access-requests`:
   - `mine=true` → filter by `userId = req.user.id`.
   - `active=true` → `status = 'APPROVED' AND expiresAt > NOW()`.
2. Include inline server info (hostname, env, ipAddress, port, protocol, sshUser) in the response so the TUI doesn't need a second call.

## Steps (TUI)
1. New Bubble Tea model `activeAccessModel` in `tui/internal/tui/activeaccess.go`:
   - Fetches the active ARs on Init and every 30s.
   - Renders one row per AR: server name, env badge, principal, "expires in …".
   - Enter key → fetch fresh SSH credentials for that AR and exec `ssh` immediately (reuse existing `ssh/connect.go`).
   - Typing filters in-place (fuzzy match on server name + env).
2. Make this the default view in `app.go:NewApp` replacing `hostlist`.
3. Move the full host list to a new slash command `/servers` (covered by task-22c).
4. If there are zero active ARs, render a friendly empty state with a hint: "Press `/request` to submit one".

## Verification
- `shellius` opens directly on the active-access list (not the full host list).
- Enter on a row opens SSH within ~500ms, no intermediate prompts.
- List refreshes automatically every 30s without losing cursor position.
- Empty state renders correctly when no active ARs exist.
