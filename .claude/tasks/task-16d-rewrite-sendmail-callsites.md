# Task 16D: Rewrite sendMail Callsites to Use Templates

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 16Q-D, 16R-D
**Blocked By:** 16A, 16C
**Model:** sonnet

## Objective
Every existing callsite of `mailer.sendMail({ text })` switches to the
new template-based API so HTML emails ship across the board.

## Known callsites
- `inviteService.createInvite()` → `invite` template
- `inviteService.resend()` → `invite` template
- Password reset request (`/api/auth/password-reset`) → `passwordReset`
- Password reset completed → `passwordChanged` security-hygiene email
- Access request submitted → `accessRequestSubmitted` to reviewer
- Access request approved → `accessRequestApproved` to requester
- Access request denied → `accessRequestDenied` to requester
- Cert expiring job → `certificateExpiring`

For each: read the current callsite, extract the vars the template
needs (name, URL, org, etc.), call `sendMail({ orgId, to, template, vars })`.

## Acceptance
- `grep -rn 'sendMail.*text:' backend/src` returns zero results outside
  `mailer.js` itself.
- Every old plain-text path now sends HTML + text fallback.
- No behavioral change to the rate limiter or audit log.
