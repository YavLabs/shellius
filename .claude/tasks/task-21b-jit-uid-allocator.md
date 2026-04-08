# Task 21b — JIT UID allocator service

**Phase:** 21A
**Plan:** `.claude/plans/phase-21-jit-user-provisioning.md`
**Agent:** backend
**Depends on:** task-21a

## Scope
Implement `backend/src/services/jitUidService.js` that atomically allocates a stable per-org Linux UID in the range 70000-79999 for a user on first JIT connect.

## Steps
1. Exported function `getOrAllocateUid(orgId, userId)`:
   - If `user.jitUid` is non-null, return it.
   - Otherwise, inside a Prisma transaction, SELECT the current max `jitUid` for that org FOR UPDATE, compute `max+1` (or 70000 if none), clamp to the range, set on the user row, return.
   - Throw `JIT_UID_RANGE_EXHAUSTED` (500) if next would exceed 79999.
2. Idempotent: subsequent calls for the same user return the same UID.
3. Unit test with concurrent allocations — verify no two users get the same UID.

## Verification
- Allocate for user A → UID 70000.
- Allocate for user B in same org → 70001.
- Re-allocate for user A → still 70000.
- Different org, new user → 70000 again (namespaced per org).
