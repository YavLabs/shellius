# Task 22a — Fix TUI persistent login bug

**Phase:** 22 (T1, ships independently)
**Plan:** `.claude/plans/phase-22-tui-redesign.md`
**Agent:** tui

## Scope
The TUI currently asks the user to log in on every invocation. Fix the three root causes identified in the plan.

## Steps
1. **`tui/internal/tui/login.go`** `ServerURLPromptModel.Update` (~line 257-272):
   - After `m.cfg.ServerURL = val`, call `m.cfg.Save()` immediately and surface any save error.
   - Reason: URL currently only persists when a later step saves tokens; if the user quits between URL entry and login completion, the URL is lost.
2. **`tui/internal/api/client.go`** (~line 80):
   - Stop silently discarding `auth.RefreshIfNeeded` errors (`_ = err`).
   - Log them at WARN to `~/.shellius/shellius.log` with timestamp + context (old token expiry, new response).
   - Surface the error to the caller as a sentinel `ErrTokenRefreshFailed` that the app can render as a non-destructive toast.
   - **Do NOT** wipe the config on refresh failure — only on explicit `shellius logout`.
3. **`tui/internal/auth/token.go`** `RefreshIfNeeded`:
   - Always persist the rotated refresh token from the refresh response (backend may rotate every refresh).
   - Also persist the new `tokenExpiresAt`.
   - Call `cfg.Save()` before returning, even in the edge case where only the access token changed.
4. **New `shellius doctor` subcommand** in `tui/cmd/shellius/main.go`:
   - Prints: config absolute path, file exists, file perms, `ServerURL`, token expiry (relative), last refresh attempt result from the log.
   - Exits 0 on healthy, non-zero on any issue.
5. **Logging:** on config load, log the absolute path resolved from `os.UserHomeDir()` to the rolling log file so future issues are diagnosable without source-diving.

## Verification (test matrix)
- [ ] Fresh install → `shellius login` → `shellius` → lands on host list with zero prompts.
- [ ] Let access token expire → `shellius` → silently refreshes, still on host list.
- [ ] Let refresh token be rotated (simulate by calling refresh twice from the backend) → next `shellius` run reads the NEW refresh token from disk.
- [ ] Delete refresh token from config → `shellius` → shows login screen cleanly, does not crash.
- [ ] Kill network → `shellius` → shows toast about refresh failure, does not wipe config.
- [ ] `shellius doctor` reports sane output for all states above.
