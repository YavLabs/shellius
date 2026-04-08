# Task 20a — Add ROLE to SubjectType enum

**Phase:** 20 — Role-based policy attachment
**Plan:** `.claude/plans/phase-20-role-policies.md`
**Agent:** db

## Scope
Extend `SubjectType` enum in `backend/prisma/schema.prisma` to include `ROLE` alongside `USER` and `GROUP`.

## Steps
1. Edit `schema.prisma:397-400`: `enum SubjectType { USER GROUP ROLE }`.
2. `cd backend && npx prisma migrate dev --name policy_subject_role`.
3. Verify the generated migration contains `ALTER TYPE "SubjectType" ADD VALUE 'ROLE'` only — no data backfill, no destructive op.
4. Regenerate Prisma client.

## Verification
- `SELECT unnest(enum_range(NULL::"SubjectType"))` returns three values.
- Existing PolicySubject rows untouched.
- App boots, policies list still loads.
