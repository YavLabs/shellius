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
- `GET /api/terminal/sessions/:id/recovery` → what happened to a tab's session and what will
  work now, based on the caller's *current* access (owner only, else 404). `endReason` is one of
  `server_restart | shutdown | expired | terminated | revoked | detached_timeout | exit | closed |
  error`. `action` is one of:
  - `attach`: still live.
  - `reconnect`: the same, or another, approved unexpired request for the server; or a Quick
    Connect that used a saved Keystore identity.
  - `pending`: a request for the server awaits approval.
  - `request_access`: access expired, was revoked, or was denied.
  - `quick_connect`: a one-off password/key; returns a `prefill` with host/port/username/auth
    type only, never the secret.
  - `none`.
- `POST /api/terminal/sessions/:id/reconnect` → `{ connect }` for `attach`/`reconnect` (409
  `CANNOT_RECONNECT` otherwise). Quick Connect gets a fresh single-use ticket through the normal
  ticket path (prod-host guard included). Rate limited with the ws-ticket limiter; audited as
  `session.reconnect`.
- Session rows record what recovery needs, with no secrets: `metadata.principal`
  (certificate sessions) and `metadata.quickConnect = { authType, credentialId }`.
- **Startup sweep:** hub sessions live in memory, so on boot the backend marks every SSH
  `Session` still `ACTIVE` as `ENDED` with `endReason: 'server_restart'`
  (`reconcileOrphanedSessions`). A graceful shutdown already ends them with `shutdown`. This
  assumes one backend process, the same limitation as the hub.

### Recovery and reconnection (frontend)

| What happened | What the user sees |
|---|---|
| Network blip, laptop sleep, proxy hiccup | Amber "Connection lost. Reconnecting…" bar and **automatic re-attach** (1s, 2s, 4s, 8s, then every 15s; immediately when the browser is back online), with a "Retry now" button. Replayed output replaces the screen, so nothing is printed twice. |
| Shellius restarted or crashed | Re-attach finds the session gone (4404), and the tab becomes **lost** with a recovery card: "Shellius restarted" plus the action above. |
| Access expired / revoked | "Access ended" plus **Request access again**. An auto-approved request (non-prod, or an admin's audited prod bypass) connects in the same tab; otherwise the tab turns into the request's status tab. |
| A newer approved or pending request exists | **Reconnect** on it, or **View request**. |
| Quick Connect with a one-off password/key | **Quick Connect again**, prefilled; the result reconnects in the *same* tab. |
| Quick Connect with a saved identity | **Reconnect** directly. |
| Admin terminated, sessions revoked, detach timeout, `exit` | Explains why, then offers whichever action applies. |
| Couldn't connect at all (host down, auth failed) | **Retry** (access-request tabs) or **Edit and retry** (Quick Connect). |
| Reload after any of the above | Restored tabs whose session is gone open straight on the card (no failing attach). |
| Several tabs affected | Banner "N terminals lost their sessions" with **Reconnect all**, which handles every tab whose access is still valid and reports how many need attention. It also has **Show** and **Close all**. |
| Request status tab can't load (Shellius restarting) | Retries every 5s by itself. |

Every recovery action reuses the tab, so its place in the tab bar and its split are kept.

**Re-attaching running sessions:** live sessions not open in a tab are listed under "Running
sessions" in the empty workspace **and** in the "+" New connection dialog, each with Attach, plus
**Attach all**. The Sessions button in the tab bar shows how many there are.

**Per-user storage:** workspace state is stored under `shellius.workspace.v2:<userId>`, so another
person signing in on the same browser never inherits tabs.

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
  (`shellius.workspace.v2:<userId>`: tabs + split groups; v1's single layout is migrated. No
  secrets. Tabs whose session is no longer live open on the recovery card). Leaving `/terminals` or reloading re-attaches every tab and
  replays recent output.
- Every "Connect" entry point (server Connect modal, Quick Connect, dashboard "Connect again",
  command palette) opens a **tab in the workspace** by default; "Open in new window" remains as
  a secondary option (standalone `/terminal?attach=…`). "Back" / closing a window only detaches.
- The standalone `/terminal` page supports `?attach=<sessionId>` and shows "Session is still
  running — reattach from Terminals" after detaching.
- The admin `/sessions` page keeps its org-wide view; for the caller's own live sessions it
  offers "Open in Terminals".
