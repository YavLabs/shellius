# Task 17Q-*: QA Gates for Phase 17

**Agent:** qa
**Status:** [ ] Pending
**Blocked By:** matching implementation task
**Model:** sonnet

Same workflow as 15Q / 16Q. Each implementation only ticks Done when
its qa gate AND reviewer gate are green.

## 17Q-A — QuickConnect modal close bug
- Live: open the QuickConnect modal on Servers list, type in the
  username field, confirm modal stays open and no navigation occurs.
- Live: ServerDetail page shows the Connect button when an active
  approved AR exists, Request Access otherwise.
- Vitest: snapshot of QuickConnectModal with focus on the input.

## 17Q-B — server.sshUser default + override toggle
- Vitest: principalForServer helper returns the right precedence.
- Live: open Connect modal on a server with `sshUser='deploy'` —
  field is pre-filled with `deploy`, locked, override toggle off.
- Toggle on → editable.

## 17Q-C — Bootstrap uninstaller
- Live: run install.sh on a test VM, confirm Shellius is configured.
- Run uninstall.sh, confirm:
  - All Shellius files removed
  - `sshd -T | grep trustedusercakeys` shows none
  - `sshd_config` backup exists at `sshd_config.shellius.bak`
  - Normal SSH (regular authorized_keys) still works
  - No unrelated SSH file was modified (`md5sum` of authorized_keys,
    host keys, and any other Include drop-ins before/after)

## 17Q-D — Default policies + Help drawer
- Jest: seedDefaultPolicies job creates 3 policies idempotently.
- Live: GET /api/policies on a fresh org returns the 3 defaults.
- Vitest: HelpDrawer renders content for every page slug in helpContent.js.
- Live: every top-level page shows a `?` icon that opens the drawer.

## 17Q-E — Notification badge
- Vitest: NotificationBell renders the badge correctly with 0, 1, 9, 10
  unread counts. Confirm icon switches to BellRing on > 0.
- Live: badge is visually correct in the topbar.

## 17Q-F — Profile + GDPR + registration
- Jest: PUT /api/users/me/password rejects SSO users (passwordHash
  null), accepts local users with correct current password.
- Jest: GET /api/users/me/export returns the expected JSON shape.
- Jest: DELETE /api/users/me soft-deletes correctly, revokes ARs/certs,
  blocks subsequent logins.
- Jest: hard-delete job purges soft-deleted users older than 30 days.
- Live: profile page renders with the right field visibility per
  auth method.
- Live: registration flow works end-to-end when self-service is enabled.
