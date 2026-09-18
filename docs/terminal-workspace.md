# Terminal Workspace — persistent sessions, tabs and split view

Goal: a Termius/Termix-style in-app terminal workspace. SSH sessions live in
tabs inside Shellius, survive navigation, tab closes and reloads (for a grace
period), can be split side-by-side, duplicated and re-attached.

## 1. Persistent (detachable) sessions — backend

Today the ssh2 connection is bound to one WebSocket: when the browser tab
closes or navigates away, the SSH session ends. New model (tmux-like):

- `services/terminalHub.js` owns live SSH sessions, keyed by `Session.id`:
  `{ orgId, userId, client, stream, cols, rows, sockets:Set<ws>, buffer (ring,
  512 KB of recent output), recordingWriter, meta (host, port, username,
  authMethod, serverId, accessRequestId, label), connectSpec (for duplicate),
  detachedAt, detachTimer, lastActivityAt }`.
- A WebSocket **attaches** to a hub session. Output fans out to every attached
  socket (same user may view one session in two panes/windows).
- Socket drop / page close = **detach** (session keeps running). When the last
  socket detaches, a timer starts: `TERMINAL_DETACH_TTL_SECONDS` (default
  900 = 15 min). Reattach cancels it; expiry ends the session (`ENDED`,
  reason `detached_timeout`).
- Explicit end: client sends `{ "type": "close" }` (the "Close session" / tab
  close with "End session") → ssh ends, all sockets get `{type:'ended'}`.
- Hard limits still apply regardless of attachment: access-request expiry,
  admin terminate (`POST /api/sessions/:id/terminate`), shell exit, org
  revocation. Each sends `{ type:'ended', reason }` to attached sockets.
- Recording continues across detach/attach (one cast per SSH session).
- Audit: `session.attach`, `session.detach`, `session.end` (with reason).
- Single-process state: reattach must reach the backend instance that owns
  the session. Current deployments run one backend; multi-replica setups need
  sticky routing on `/api/terminal/*` (documented limitation).

### WebSocket `/api/terminal/ssh`

Query (one of):
- `?token=&requestId=&principal=&cols=&rows=` — new session from an approved access request
- `?token=&ticket=&cols=&rows=` — new Quick Connect session
- `?token=&attach=<sessionId>&cols=&rows=` — **attach** to a live session
  (caller must own it: same user + org; session must be live in the hub;
  4404 `SESSION_NOT_FOUND` / 4403 `SESSION_FORBIDDEN` otherwise)

Server → client control frames (JSON text; everything else is raw output):
- `{ type:'hostkey', … }` (new sessions), `{ type:'connected', sessionId, authMethod, host, port, username, label }`
- `{ type:'attached', sessionId, replayBytes }` — sent on attach, followed by the buffered output replay
- `{ type:'ended', reason }` — `exit` | `closed` | `detached_timeout` | `expired` | `terminated` | `error`
- `{ type:'error', message }`

Client → server: raw input, `{type:'resize', cols, rows}`, `{type:'close'}`.
Resize from any attached socket applies to the PTY (last writer wins).

### REST `/api/terminal/sessions` (authenticate + tenant; caller's own sessions only)

- `GET /api/terminal/sessions` → `{ sessions: [{ id, label, host, port, username, authMethod,
  server: {id, displayName, hostname, environment} | null, accessRequestId, attachedCount,
  state: 'attached'|'detached', startedAt, lastActivityAt, detachedAt, endsAt /* detach deadline or AR expiry, whichever first */,
  canDuplicate }] }` — live hub sessions only.
- `POST /api/terminal/sessions/:id/duplicate` → `{ connect: { ticket } | { requestId, principal } }` —
  a *new* SSH session to the same target with the same auth. Access-request sessions reuse the
  (still-approved) request; Quick Connect sessions get a fresh single-use ticket minted from the
  original session's auth, which the hub keeps **in memory only** (encrypted, never persisted,
  dropped when the session ends). Certificate/identity server sessions re-resolve credentials.
- `PATCH /api/terminal/sessions/:id` `{ label }` → rename (shown in tabs, max 60 chars).
- `POST /api/terminal/sessions/:id/close` → end the session (same as the `close` frame).

## 2. Workspace UI — frontend

- Sidebar entry **Terminals** (all roles; badge = live session count) → `/terminals`.
- Tab bar (Termius-like): status dot (connecting / live / detached / ended), label, env badge,
  close ×; context menu: Rename, Duplicate, Split right, Split down, Remove from split, Open in
  new window, Close, Close others, End session. Tabs that are part of a split show a small
  split icon, highlighted when that split is on screen. `+` opens a "New connection" picker (servers you can
  connect to, recent Quick Connects, "Quick Connect…").
- Panes: single, split right (2 columns), split down (2 rows), 2×2 grid. **Splits belong to their
  tabs**, not to the whole page (`frontend/src/lib/workspaceLayout.js`, unit-tested in
  `workspaceLayout.test.js`):
  - Selecting or opening a tab that isn't in a split shows it **full size**. Any other splits
    stay as they are, and selecting one of their tabs brings that split back.
  - Several splits can exist at once. The Layout menu (and Single) only changes the split on
    screen.
  - "Split right/down" on the shown tab adds an empty, focused pane. Clicking a tab in the bar,
    or opening a new connection, fills it. A split left with an unfilled pane is discarded when
    you switch away.
  - Dragging a tab onto a pane edge splits (a cross-axis edge on a 2-pane split makes a 2×2
    grid); the centre replaces that pane. A tab dropped within its own split swaps places. A tab
    moved out of a split, or a replaced tab, becomes standalone. A split left with one tab
    dissolves, and a grid left with two becomes side-by-side.
  - Terminals render into stable host nodes that are moved between panes, so switching tabs or
    layouts never reconnects (no new ticket, no replay).
- A side panel / section lists **all live sessions** (including detached ones not open in any
  tab) with Attach, Duplicate, End.
- Workspace state (open tabs → sessionIds, labels, layout) persists in `localStorage`
  (`shellius.workspace.v2`: tabs + split groups; v1's single layout is migrated. No secrets; stale sessionIds are pruned against
  `GET /api/terminal/sessions`). Leaving `/terminals` or reloading re-attaches every tab and
  replays recent output.
- Every "Connect" entry point (server Connect modal, Quick Connect, dashboard "Connect again",
  command palette) opens a **tab in the workspace** by default; "Open in new window" remains as
  a secondary option (standalone `/terminal?attach=…`). "Back" / closing a window only detaches.
- The standalone `/terminal` page supports `?attach=<sessionId>` and shows "Session is still
  running — reattach from Terminals" after detaching.
- The admin `/sessions` page keeps its org-wide view; for the caller's own live sessions it
  offers "Open in Terminals".
