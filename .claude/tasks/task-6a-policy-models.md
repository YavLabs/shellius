# Task 6A: Access Policy & Policy Subject Prisma Models

**Agent:** db
**Status:** [ ] Pending
**Blocks:** 6B
**Blocked By:** None

## Objective
Define Prisma models for access policies and policy subjects, enabling rule-based access control with deny-before-allow semantics.

## Deliverables
- `AccessPolicy` model in `prisma/schema.prisma` with fields: id, name, description, effect (ALLOW/DENY), priority (Int), environment (String, nullable — null means all), serverIds (String[]), principals (String[]), maxSessionDuration (Int, seconds), requireApproval (Boolean), requireMfa (Boolean), isActive (Boolean), createdBy (FK to User), createdAt, updatedAt
- `PolicySubject` model in `prisma/schema.prisma` with fields: id, policyId (FK to AccessPolicy), subjectType (USER/GROUP/ROLE), subjectId (String), createdAt
- Prisma migration for both models
- Indexes on AccessPolicy.effect, AccessPolicy.environment, AccessPolicy.isActive, PolicySubject.subjectType+subjectId

## Acceptance Criteria
- `npx prisma validate` passes with no errors
- `npx prisma migrate dev` applies cleanly
- AccessPolicy has a unique constraint on name
- PolicySubject has a composite unique on (policyId, subjectType, subjectId)
- Cascade delete on PolicySubject when AccessPolicy is deleted
