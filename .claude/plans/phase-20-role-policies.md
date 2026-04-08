# Phase 20 — Role-Based Policy Attachment

## Goal
Allow an `AccessPolicy` to be attached to a **role** (super_admin / admin / operator / viewer) in addition to — or instead of — users and groups. A policy matches a user if ANY of (direct user / any of their groups / their role) is listed as a subject.

## Current state
- `backend/prisma/schema.prisma`:
  - `enum SubjectType { USER GROUP }` (lines 397-400)
  - `PolicySubject` is already polymorphic: `{ policyId, subjectType, subjectId }` — no schema redesign needed, just an enum value.
- `backend/src/services/policyService.js`:
  - `loadMatchingPolicies(orgId, userId, userGroupIds)` at lines 33-57 — matches USER or GROUP only.
  - `create()` / `update()` at lines 419-491 / 501-572 iterate over `subjects[]` generically.
- `backend/src/routes/policies.js` Joi validator `subjectSchema` restricts `subjectType` to `USER|GROUP`.
- `frontend/src/components/policies/PolicyForm.jsx` Step 2 (lines 161-335) has a two-column Users + Groups picker.

## Tasks

### T1 — Schema
- [ ] Edit `schema.prisma`: `enum SubjectType { USER GROUP ROLE }`.
- [ ] `npx prisma migrate dev --name policy_subject_role`. Enum-add only; no data backfill.

### T2 — Backend service
- [ ] `policyService.loadMatchingPolicies`: fetch `user.role` once, then add `{ subjectType: 'ROLE', subjectId: user.role }` to the existing `OR` subjectFilter. Keep sort + deny-wins logic unchanged.
- [ ] Validate in `create()` / `update()` that when `subjectType === 'ROLE'`, `subjectId` is one of `super_admin|admin|operator|viewer`. Reject otherwise with 400.
- [ ] Unit test: user with role `operator` matches a ROLE-operator policy and a USER-direct policy; deny ROLE policy wins over allow USER policy at same priority.

### T3 — Routes / validators
- [ ] `routes/policies.js` `subjectSchema`: extend `subjectType` to include `ROLE`; add a conditional that constrains `subjectId` to the OrgRole literal set when type is `ROLE`.

### T4 — Frontend form
- [ ] `PolicyForm.jsx` Step 2: convert the 2-column Users/Groups grid into a 3-column grid adding a "Roles" picker.
- [ ] Roles list is static: `['super_admin','admin','operator','viewer']`. No API call.
- [ ] Reuse `addSubject('ROLE', role, role)` and the existing chip renderer. Role chip badge color = neutral/violet to distinguish.
- [ ] Show the chips across all three types in the selected-subjects strip.

### T5 — Policy detail / list
- [ ] Wherever a policy's subjects are rendered (policy list row, detail view), handle the `ROLE` case: render as a small badge (e.g. "role: operator").

### T6 — Verification
- [ ] Create policy attached to role `operator`. Confirm all operators match it without being explicitly listed.
- [ ] Change a user from `operator` to `viewer` — they no longer match.
- [ ] Policy attached to `role=operator` + `group=sre` ORs correctly.
- [ ] Deny-wins across role vs user vs group.

## Out of scope
- Custom/user-defined roles (the OrgRole enum is closed for now).
- Inheritance hierarchy across roles (super_admin does NOT auto-inherit operator policies — still uses the existing super_admin bypass at policyService lines 161-171).
