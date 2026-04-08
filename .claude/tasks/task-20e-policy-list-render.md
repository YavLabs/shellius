# Task 20e — Render ROLE subjects in policy list/detail

**Phase:** 20
**Plan:** `.claude/plans/phase-20-role-policies.md`
**Agent:** frontend
**Depends on:** task-20d

## Scope
Wherever policy subjects are rendered (policy list row, detail view, audit log entries), handle the new `ROLE` case.

## Steps
1. Find subject renderers: `grep -r "subjectType" frontend/src`.
2. For each, add a `case 'ROLE'` branch rendering a small badge: `role: operator` (lowercase label + role name).
3. Use the same violet accent as task-20d.

## Verification
- Policies list shows a row with "Role: operator" badge for a role-attached policy.
- Policy detail page renders all three subject types in the same section.
