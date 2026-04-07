# Task 16E: Group Membership Audit Logging

**Agent:** backend
**Status:** [x] Done
**Blocks:** 16Q-E, 16R-E
**Blocked By:** None
**Model:** sonnet

## Objective
Follow-up to Phase 15R-A medium finding: no audit log entry when a
group member is added or removed.

## Deliverables
- `backend/src/routes/groups.js`:
  - POST `/:id/members` — add `audit('group.member.added', 'Group')`
  - DELETE `/:id/members/:userId` — add `audit('group.member.removed', 'Group')`
- Audit payload: `{ groupId, targetUserId }`

## Acceptance
- Adding/removing a member fires an audit entry visible in
  `/audit-log` immediately.
- Backend Jest regression test covering both verbs.
