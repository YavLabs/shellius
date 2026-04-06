# Task 6B: Policy Service

**Agent:** backend
**Status:** [ ] Pending
**Blocks:** 6C
**Blocked By:** 6A

## Objective
Implement policyService.js with deny-before-allow evaluation logic, hard-coded production approval requirement, group membership resolution, and accessible server computation. Add API routes for policy CRUD.

## Deliverables
- `src/services/policyService.js` with functions:
  - `evaluate({ userId, serverId, environment })` — collect all matching policies for user (via direct user, group membership, role), apply deny-before-allow (DENY policies always win over ALLOW at same or higher priority), return { allowed, requireApproval, requireMfa, maxSessionDuration, matchedPolicies[] }
  - Hard-coded rule: production environment always requires approval regardless of policy
  - `resolveSubjects(userId)` — resolve user's groups and roles for policy matching
  - `getAccessibleServers(userId)` — return all servers the user has access to with policy details
  - `create(policyData)`, `update(id, policyData)`, `delete(id)`, `list({ page, limit })`, `getById(id)`
- `src/routes/policyRoutes.js` — full CRUD routes + GET /policies/evaluate?userId&serverId, GET /policies/accessible-servers?userId
- Unit tests for evaluate() covering: deny overrides allow, production requires approval, group membership matching, no matching policy denies by default

## Acceptance Criteria
- DENY policies always override ALLOW policies at the same or higher priority level
- Production environment servers always return `requireApproval: true`
- A user with no matching policies is denied access by default
- Group membership is resolved transitively (user -> groups -> policies)
- `getAccessibleServers()` returns correct results reflecting all policy evaluations
- All routes require authentication; CRUD restricted to admin role
