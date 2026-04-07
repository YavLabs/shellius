# Task 14K: Cloud Connectors — Implement or Hide

**Agent:** planner
**Status:** [x] Done
**Blocks:** 14D, 14L
**Blocked By:** None

## Objective
The Cloud Connectors page exists in the sidebar and the Settings page
shows a "Coming soon (Phase 4)" placeholder, but Phase 4 was never
finished. Either build it for real or remove the dead UI before shipping
phase 14 — half-built features confuse users.

## Decision needed
1. **Implement**: scope a minimal version (AWS only?), Prisma model,
   credentials encrypted, sync job, sync history, frontend page. ~2-3
   days of work, primarily backend.
2. **Hide**: remove the sidebar entry, the placeholder Settings tab,
   and the page. Keep the existing schema/code paths if any.

## Inputs the planner agent should consider
- Phase 4 plans in `.claude/plans/phase-4-cloud-connectors.md`
- Existing backend service stubs (if any) under
  `backend/src/providers/{aws,azure,gcp}/`
- Whether the user actually has AWS/Azure/GCP accounts to connect
- Whether on-prem servers (added manually + via bootstrap) are sufficient
  for the foreseeable future

## Deliverable
A short decision doc in `.claude/plans/phase-14-cloud-decision.md` with
"implement" or "hide" + rationale. If implement, splits into 14K-1, 14K-2,
... sub-tasks.

## Acceptance
- The decision is recorded and the plan/tasks reflect it.
