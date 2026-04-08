# Task 20b — Role subject matching in policyService

**Phase:** 20
**Plan:** `.claude/plans/phase-20-role-policies.md`
**Agent:** backend
**Depends on:** task-20a

## Scope
Extend `policyService.loadMatchingPolicies` at `backend/src/services/policyService.js:33-57` to match policies whose subjects include the user's role.

## Steps
1. Inside `loadMatchingPolicies(orgId, userId, userGroupIds)`:
   - Fetch `user.role` via `prisma.user.findUnique({ where: { id: userId }, select: { role: true } })` — or accept it as a parameter from the caller to avoid the extra query (check call sites at `policyService.js:253`).
   - Extend `subjectFilter` to always include `{ subjectType: 'ROLE', subjectId: userRole }` in addition to the existing USER and GROUP entries.
2. Caller at line 253: fetch `user.role` once alongside `resolveUserGroupIds()` and pass it in.
3. No changes needed to `create()` / `update()` — already iterate over `subjects[]` generically.

## Verification
- Unit test: a user with role `operator` matches a policy whose only subject is `{ROLE, operator}`.
- Unit test: changing the user's role from `operator` to `viewer` re-evaluates — they no longer match the operator-only policy.
- Unit test: deny-wins across ROLE + USER + GROUP at same priority (deny ROLE beats allow USER).
- Integration test: create policy attached to `ROLE=operator`, confirm all org operators can access the target without being explicitly listed.
