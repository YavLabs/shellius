# Task 21g — Surface AR reason across UI + audit

**Phase:** 21A
**Plan:** `.claude/plans/phase-21-jit-user-provisioning.md`
**Agent:** frontend

## Scope
The `reason` field already exists on access requests but is underexposed. Make it prominent.

## Steps
1. Access requests list (`/access-requests`) — show the first 60 chars of the reason as a new column with tooltip for full text.
2. Approval modal — render the reason prominently at the top before the approve/deny buttons. Make it un-missable.
3. Audit log entries for `ACCESS_REQUEST_CREATED` — include the reason in the human-readable description.
4. Email templates for `accessRequestSubmitted` / `accessRequestApproved` / `accessRequestDenied` — include the reason in the body.

## Verification
- Submit a request with a distinctive reason, confirm it shows on list/modal/audit/email.
