# Task 21a — Prisma schema: JIT + policy extensions

**Phase:** 21A — JIT control-plane groundwork
**Plan:** `.claude/plans/phase-21-jit-user-provisioning.md`
**Agent:** db

## Scope
Add JIT provisioning and break-glass fields to `User` and `AccessPolicy` in `backend/prisma/schema.prisma`.

## Steps
1. `User`:
   - `jitUid Int?` with `@@unique([orgId, jitUid], map: "user_org_jit_uid_unique")` to prevent collisions within an org.
2. `AccessPolicy`:
   - `osProvisioning Json @default("{}") @map("os_provisioning")`
   - `allowKeyDownload Boolean @default(false) @map("allow_key_download")`
   - `isBreakGlass Boolean @default(false) @map("is_break_glass")`
3. `npx prisma migrate dev --name jit_provisioning_fields`.
4. Regenerate client, rerun type-check in backend.

## Verification
- Migration applies cleanly to the existing prod DB snapshot.
- `User` rows default `jitUid` to NULL; existing policies default the three new fields to false/`{}`.
- `prisma studio` shows the new columns.
