# Task 22h — TUI Phase 22 Follow-ups

Tracks everything from tasks 22b–22g that was intentionally deferred from the MVP commit.

## From task-22a (persistent-login fixes)
- All three root-cause fixes (cfg.Save on URL entry, RefreshIfNeeded always persists rotated token, api/client propagates refresh error as toast) were already in the codebase before this PR. No outstanding items.
- `shellius doctor` subcommand was already implemented in `cmd/shellius/main.go`.

## From task-22b (active-access picker)
- 30-second background refresh is implemented but does NOT preserve cursor position across refreshes when the list changes order. Should reconcile by server ID.
- Inline server info (Server field on AccessRequest) depends on the backend returning it — older backends return only `serverId`. The fallback displays the raw UUID. Backend should be updated to include server info in the access-request list response.
- "expires in" countdown does not tick in real time; it is only updated on the 30s refresh. A per-second tick would improve UX.

## From task-22c (slash-command palette)
- `/request` currently opens the full host list rather than a dedicated request form. A proper `/request <server>` inline form should be built.
- `/sessions` is a stub ("coming soon"). Requires task-22e implementation.

## From task-22d (visual overhaul)
- The outer AppStyle border uses a fixed `borderWidth = m.width - 2`. This is correct in alt-screen but should be verified on very narrow (< 60 col) terminals.
- The legacy `BadgeProd / BadgeStaging / BadgeDev / BadgeDemo` lipgloss variables were removed from styles.go. Any future code that references them by the old var names will break. The replacement is the `EnvBadge()` function.
- The old `colorBg`, `colorSurface`, `colorHighlight` constants are kept as aliases; a cleanup pass should remove unused ones.

## From task-22e (host cache + sessions dir) — NOT DONE
- Host list cache (`~/.shellius/cache/hosts.json`) with ETag + TTL was explicitly excluded from MVP scope. The active-access list always fetches live.
- Local sessions state dir (`~/.shellius/sessions/`) was excluded. `/sessions` is a stub.
- Stale-session pruning (7-day history) is not implemented.
- Multi-window awareness (second instance sees active sessions) is not implemented.

## From task-22f (one-liner install) — NOT DONE
- `scripts/install-tui.sh` was excluded from MVP scope.
- `shellius --version` is implemented (`const version = "0.1.0"` in main.go) but no build-stamp injection via `ldflags -X`.
- GitHub Actions release workflow for darwin/linux/windows × amd64/arm64 was excluded.

## From task-22g (config/credentials split) — NOT DONE
- The monolithic `~/.shellius/config.yaml` still stores both prefs and tokens. Splitting to `config.yaml` (prefs) + `credentials` (secrets, 0600) was excluded.
- `config.Clear()` currently rewrites `config.yaml` with empty token fields rather than deleting a separate `credentials` file.
- Backwards-compat migration path was excluded.
- macOS Keychain / libsecret integration is deferred.

## Other observations from reading the codebase
- `app.go` `prevView` is used for Esc-back from overlays but is single-level; a proper stack would handle deeper navigation chains.
- The `hostlist.go` `max()` and `min()` helpers will conflict with the built-in `max`/`min` from Go 1.21+ if the build target is ever raised. Rename them to `clampMax` / `clampMin`.
- `accessrequest.go` `arStateSubmitting` is defined but the model jumps straight to `arStatePolling`; the submitting state is never actually set.
