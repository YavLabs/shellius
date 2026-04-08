# Phase 22 — TUI Redesign: Claude-Code / Codex / Gemini Feel

## Goal
Rebuild the `shellius` TUI to feel like Claude Code / Codex / Gemini CLI: clean, minimal chrome, slash-command palette, persistent login, instant host list, one-keystroke SSH.

## Product framing
The Shellius TUI is a **developer tool** installed on the user's own laptop/workstation. It is NOT installed on target servers. It is:
- a one-liner install (`curl … | sh`)
- a persistent identity (log in once, stay logged in until `shellius logout`)
- a fast picker for servers the user already has approved access to
- a one-key launcher into an SSH session using the short-lived cert issued by the control plane

## Current state (see investigation)
- `tui/cmd/shellius/main.go`, `tui/internal/{auth,api,ssh,tui,config}/`
- Uses Bubble Tea + Lipgloss. Device auth flow. Config at `~/.shellius/config.yaml` stores access + refresh tokens.
- **Bug:** every run asks to log in again. Probable root causes (to confirm in T1):
  1. `ServerURLPromptModel.Update` at `tui/internal/tui/login.go:257-272` sets `m.cfg.ServerURL = val` but **never calls `cfg.Save()`**. The save only happens later when tokens are written. If the user quits between ServerURL prompt and completing login, the URL is lost — and even if it isn't, nothing persists until `SaveTokens`.
  2. `api/client.go:80` calls `auth.RefreshIfNeeded` and then **silently discards the error** (`_ = err`). If the refresh fails (token rotated, network, clock skew), every subsequent API call 401s and the TUI treats it as "not logged in".
  3. `RefreshIfNeeded` may not be persisting the rotated refresh token under all code paths.
- No slash commands, no command palette, no session resume concept, no cached host list.
- `hostlist` shows ALL servers, not just those with active access requests (user wants the latter by default).

## Design — target UX

### Layout
```
╭─ shellius ──────────────────────────────── alice@acme · prod ─╮
│                                                               │
│  > _                                                          │  ← command input (always focused)
│                                                               │
│  ACTIVE ACCESS                                                │
│  ▸ prod-web-01       ubuntu  expires in 42m   [enter] ssh     │
│    prod-web-02       ubuntu  expires in 1h 12m                │
│    stage-db-03       postgres expires in 3h 50m               │
│                                                               │
│  /help  /servers  /request  /sessions  /logout                │
╰─ ↑↓ select  ↵ connect  / commands  ? help  ctrl+c quit ──────╯
```

### Modes
- **Default (picker):** arrow keys navigate; `↵` launches SSH; typing filters. No modal screens for routine work.
- **Slash-command mode:** typing `/` opens a command palette with fuzzy search. Commands:
  - `/servers` — all servers (not just active access)
  - `/request <server>` — submit a new access request (reason + duration form)
  - `/sessions` — recent sessions with replay/info
  - `/refresh` — force host list refetch
  - `/logout` — clear tokens, exit
  - `/profile` — show current identity, token expiry, server URL
  - `/help` — keybinding cheatsheet
  - `/quit` — exit
- **Ex-command mode (`:`)** — power-user shortcut. `:q`, `:w` (noop), etc. Optional.

### Visual style (Claude-Code / Codex inspired)
- Single rounded border, thin. No nested boxes.
- Two accent colors max: one for "active/selected", one for "warning/prod".
- Generous vertical whitespace. No emoji decorations.
- Status bar: one line, right-aligned identity + token TTL.
- Monochrome base palette, true-color accents (gracefully degrades on 256-color terms).
- Typography: bold for headers, dim for help hints, default for content.

### Persistence contract
- `shellius login` once → tokens persisted → **every subsequent invocation is instant**, never prompts.
- Token refresh happens automatically and silently in the background on every API call.
- `shellius logout` is the ONLY way to clear credentials.
- If a refresh genuinely fails (e.g. backend invalidated the refresh token), show a toast "Session expired — run `shellius login`" and exit cleanly, but do NOT wipe the config automatically.

### Multiple windows / session resume
- TUI instance N and instance N+1 are independent — they can hit the same backend with the same token.
- If the user already has an active web-terminal session for a server, `shellius` should still be able to open a **parallel** SSH session to the same server (provided the access request is still valid).
- A lightweight `~/.shellius/sessions/` state dir records recent SSH processes (PID + server ID + started-at) so `/sessions` can show "what's open from this machine right now".

## Tasks

### T1 — Diagnose & fix the persistent-login bug (do this first)
- [ ] Add a `cfg.Save()` call at the end of `ServerURLPromptModel.Update` the moment the URL is accepted (login.go:263).
- [ ] In `api/client.go:80`, log refresh errors at WARN level to `~/.shellius/shellius.log` instead of silently dropping, and propagate them as an auth error the app can render (but NOT auto-logout).
- [ ] In `auth.RefreshIfNeeded`, always persist the rotated refresh token (the backend may rotate every refresh — assume it does).
- [ ] Add `shellius doctor` subcommand that prints: config path, file exists/perms, ServerURL, token expiry, last refresh result. Makes this class of bug diagnosable without source-diving.
- [ ] Confirm the config path is stable across invocations (log the absolute path on load).
- [ ] Test matrix: fresh install → login → quit → reopen → must be on host list, zero prompts. Let access token expire → reopen → must silently refresh. Delete refresh token → reopen → must show "log in" screen (not crash).

### T2 — New default view: "Active Access" picker
- [ ] New API call (or filter param on existing): `GET /api/access-requests?mine=true&active=true` → returns only the caller's currently-approved, unexpired access requests with server info inlined.
- [ ] Replace `hostlist` default mode with this active-access picker. Full host list moves behind `/servers`.
- [ ] Each row: server name, environment badge, principal, "expires in …", current host count (from local sessions state dir).
- [ ] Enter key on a row → build cert + exec `ssh` immediately. No extra prompts.

### T3 — Slash-command palette
- [ ] New Bubble Tea model `paletteModel` triggered when the user types `/` at the input.
- [ ] Fuzzy filter over a static command registry.
- [ ] Each command is a `type Command struct { Name, Desc string; Run func(app *AppModel) tea.Cmd }` — extensible.
- [ ] Register: `/help`, `/servers`, `/request`, `/sessions`, `/refresh`, `/logout`, `/profile`, `/quit`.
- [ ] `?` key opens `/help` directly.

### T4 — Visual overhaul
- [ ] Rewrite `styles.go` with the new palette: single accent (teal), single warning (red for prod), dim gray for helpers. No multi-color status bar.
- [ ] Strip nested borders from every sub-view. One border around the whole app.
- [ ] Replace ASCII decorations with lipgloss-drawn separators.
- [ ] New app header: `shellius` (bold) left, `user@org · server-url` dim right.
- [ ] Footer key-hint bar: context-aware per view.

### T5 — Cached host list for offline feel
- [ ] On successful fetch, persist host list to `~/.shellius/cache/hosts.json` with a TTL and ETag.
- [ ] On startup, paint from cache instantly, then refresh in the background and reconcile. Makes the TUI feel instant like Claude Code.

### T6 — Local sessions state dir
- [ ] `~/.shellius/sessions/<uuid>.json` — records active SSH subprocess: `{ pid, serverId, startedAt, leaseExpiry, principal }`.
- [ ] Cleaned up on `ssh` exit (deferred cleanup in `ExecProcess`).
- [ ] `/sessions` command lists current + last 20 historical (historical = disk-kept for 7 days).

### T7 — One-liner install
- [ ] `scripts/install-tui.sh` hosted at `https://get.shellius.io/install.sh` (or wherever). Detects OS/arch, downloads the matching release binary from GitHub releases, drops it in `/usr/local/bin/shellius` or `~/.local/bin/shellius`, chmods it, prints next-step.
- [ ] `shellius --version` reports the build stamp.
- [ ] GitHub Actions release workflow building `darwin/{amd64,arm64}`, `linux/{amd64,arm64}`, `windows/amd64` — tied into the Makefile's existing cross-compile targets.

### T8 — Session resume / multi-window
- [ ] Confirm the backend doesn't single-bind a cert to one connection (should already be fine since access requests allow N connects until expiry).
- [ ] In `/sessions`, an entry for an active SSH subprocess on this machine shows a "focus" hint (can't actually re-attach a live tty from a new window, but we can re-issue a fresh cert against the same access request and open a second SSH in this new window).
- [ ] Document that "resume" for Shellius means "open another connection to the same server under the same access grant", not tmux-style tty attach.

### T9 — Config & token store
- [ ] Migrate from `~/.shellius/config.yaml` to a split layout:
  - `~/.shellius/config.yaml` — non-secret user prefs (serverURL, last-used orgSlug, theme, keybinds).
  - `~/.shellius/credentials` — tokens only, `0600`, explicitly NOT in config.yaml.
- [ ] Keep backwards compat read from the old file for one release.
- [ ] Optional: on macOS use Keychain, on Linux try `libsecret` when present, fall back to the plaintext `credentials` file. This can be phase 2.

### T10 — Docs
- [ ] Update `docs/tui.md` (or create) with: install, login, slash commands, troubleshooting, `shellius doctor`.

## Acceptance criteria
- `shellius login` once → all future `shellius` invocations land on the active-access picker in <500ms, zero prompts.
- Typing a letter filters; `↵` opens SSH instantly with no intermediate forms.
- `/` opens the palette; fuzzy search works; arrow + enter runs a command.
- Refresh-token rotation works silently across days.
- Opening a second terminal window and running `shellius` again works — no lock, no conflict.
- UI visibly resembles the reference feel (Claude Code / Codex). Specifically: single outer frame, minimal chrome, slash commands, persistent identity, instant list.
- `shellius doctor` prints a useful diagnosis.

## Out of scope for this phase
- RDP launching (web UI only for now).
- Session recording playback in the TUI.
- In-TUI access request approvals (approver flow stays on web).
- Keychain integration (deferred to phase 22.5).
