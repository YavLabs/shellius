# Task 17R-*: Reviewer Gates for Phase 17

**Agent:** reviewer
**Status:** [ ] Pending
**Blocked By:** matching implementation + QA gate
**Model:** sonnet

Same workflow. High/critical findings fixed inline, medium/low filed.

## 17R-A — QuickConnect bug
- Verify the fix doesn't introduce other event-bubble regressions
  (modal still closes on Escape, on backdrop click).

## 17R-B — sshUser default
- Server-side validation still applies — admin can't bypass POSIX
  regex by hiding the override toggle.

## 17R-C — Uninstaller (highest risk surface in Phase 17)
- Script does NOT touch any file outside the documented list.
- Script ALWAYS validates sshd config BEFORE reloading.
- Script ALWAYS backs up sshd_config before any sed edit.
- Backup is owned by root, mode 600.
- The route is admin-only, token-bound, single-use.
- No path traversal in any of the script's filename arguments.

## 17R-D — Default policies + help
- Seed runs only when no policies exist (idempotent).
- Seed runs per-org, not globally.
- Help drawer renders only static content from the catalogue (no
  user input interpolation).

## 17R-E — Notification badge
- aria-label is dynamic.
- Color contrast on the badge text meets WCAG AA.

## 17R-F — Profile + GDPR + registration (highest risk)
- Password change: rate-limited; old password verified via bcrypt
  constant-time compare; new password meets the same complexity
  requirements as invite/reset; password.changed audit fires.
- Export: only the calling user's own data, never anyone else's.
  No org-wide tables.
- Soft delete: cascades correctly; refresh tokens invalidated;
  audit log immutable; user can't log in after delete.
- Hard delete job: dry-run mode for the first run; respects 30-day
  grace period; logs every purge.
- Self-service registration: rate-limited; verifies email before
  activating; org gating enforced server-side, not just client-side.
