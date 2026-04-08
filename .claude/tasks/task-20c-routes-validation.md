# Task 20c — Validate ROLE in policy routes

**Phase:** 20
**Plan:** `.claude/plans/phase-20-role-policies.md`
**Agent:** backend
**Depends on:** task-20a

## Scope
Update Joi validation in `backend/src/routes/policies.js` (around line 37-39) to accept `ROLE` in the `subjectSchema`.

## Steps
1. Extend `SUBJECT_TYPES` constant to `['USER', 'GROUP', 'ROLE']`.
2. `subjectSchema`: add a Joi `.when('subjectType', { is: 'ROLE', then: Joi.string().valid('super_admin','admin','operator','viewer'), otherwise: Joi.string().required() })` constraint on `subjectId`.
3. Reject any POST/PUT with `{ subjectType: 'ROLE', subjectId: '<anything else>' }` with 400 and a clear error message.

## Verification
- POST `/api/policies` with `{ subjects: [{ subjectType: 'ROLE', subjectId: 'operator' }] }` → 201.
- POST with `subjectId: 'foo'` for ROLE → 400 with descriptive error.
- Existing USER/GROUP requests keep working.
