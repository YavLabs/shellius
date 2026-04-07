# Task 18Q-*: QA gates for Phase 18

**Agent:** qa
**Status:** [ ] Pending
**Blocked By:** matching implementation task
**Model:** sonnet

Same workflow as 14Q–17Q. Per-task scope below.

## 18Q-A — DataTable rows-per-page
- Vitest: dropdown calls `onPageSizeChange(n)` exactly once per change
- Live: pick 50 on Servers, network tab shows
  `GET /api/servers?page=1&pageSize=50` and exactly 50 rows render
- Verify the same on every server-paginated page

## 18Q-B — Sidebar collapse
- Visual: collapse the sidebar in Chrome — confirm the avatar, icon
  alignment, and dividers all look correct
- Tab through every collapsed nav item and confirm the tooltip shows
  the right label
- Confirm the avatar tooltip shows name + role

## 18Q-C — QuickConnect AR validity
- Jest: `getActiveByServerForUser` excludes EXPIRED, DENIED, REVOKED rows
- Live: confirm the button label is "Request Access" for:
  - A server with no AR for the user
  - A server with an EXPIRED AR
  - A server with a DENIED AR
- Live: confirm the label is "Connect" for an APPROVED non-expired AR
- Live: leave the Servers page open until an AR expires; confirm the
  button flips to "Request Access" within 60s

## 18Q-D — Policy Evaluator outcome
- Jest: `POST /api/policies/evaluate` returns the documented shape
  (allow/deny/requires_approval, matched policy id, constraints)
- Live: open the evaluator on the live stack, pick (user, server),
  click Preview, confirm the outcome label is non-null and matches
  the test (e.g. "ALLOW — default-allow-non-prod" for a dev server)

## 18Q-E — Private-IP VPN warning
- Vitest: `isPrivateIP` test cases (positive + negative, IPv4 + IPv6)
- Live: visit a server with a 10.x IP, confirm the banner appears in:
  - QuickConnect modal
  - RequestForm
  - ServerForm (edit)
  - ServerDetail header
- Visit a server with a public IP (8.8.8.8) and confirm no warning
  appears anywhere
