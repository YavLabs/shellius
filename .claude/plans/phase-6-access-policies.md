# Phase 6: Access Policies

## Goal
Implement the policy engine with customer + environment scoping, deny-before-allow precedence, group membership resolution, and the hard-coded prod approval requirement.

## Duration Estimate
1-2 weeks

## Dependencies
Phase 5 complete (Certificate system exists)

## Tasks

### Task 6A: Policy Models [Agent: db]
**Status:** [ ] Pending

- Add AccessPolicy model: org_id, customer_id (nullable -- null=org-wide), name, description, effect (allow/deny), target_environments[], target_labels (Json), target_server_ids[], allowed_principals[], max_session_duration (seconds), require_approval, auto_approve, is_active, priority, created_at, updated_at
- Add PolicySubject model: policy_id, subject_type (user/group), subject_id
- Run migration

### Task 6B: Policy Service [Agent: backend]
**Status:** [ ] Pending
**Blocked By:** 6A

- Implement policyService.js:
  - evaluate(userId, serverId, requestedPrincipal):
    1. Load server -> get environment, customer_id, labels
    2. HARD RULE: if server.environment === 'prod' -> return { requiresApproval: true } always
    3. Load all active policies where user is subject (direct or via group)
    4. Filter policies by: customer match, environment match, label match, server ID match
    5. Apply deny-before-allow (deny policies take precedence regardless of priority)
    6. Return: { allowed, requiresApproval, principals[], maxTtl, autoApprove }
  - getAccessibleServers(userId): return all servers user can access with TTL info
  - create/update/delete CRUD
- Implement routes/policies.js:
  - GET /api/policies (admin+)
  - GET /api/policies/:id (admin+)
  - POST /api/policies (admin+)
  - PUT /api/policies/:id (admin+)
  - DELETE /api/policies/:id (admin+)
  - POST /api/policies/evaluate (internal/admin)
  - GET /api/policies/my-access (all -- returns user's accessible servers with TTLs)

### Task 6C: Policy Frontend [Agent: frontend]
**Status:** [ ] Pending
**Blocked By:** 6B

- Build Policies page: policy list with effect badges (allow=green, deny=red), customer scope, environment tags
- Build PolicyForm: multi-step dialog:
  - Step 1: Name, description, effect (allow/deny)
  - Step 2: Subjects (select users and/or groups)
  - Step 3: Targets (select customer, environments, label matchers, specific servers, principals)
  - Step 4: Constraints (max session duration, require approval toggle, auto-approve toggle)
- Build "My Access" widget for Dashboard: shows servers user can access with expiry countdown, grouped by customer

## Acceptance Criteria
- Create allow policy for dev servers -> user can access dev servers
- Create deny policy for specific server -> access denied even if allow policy exists
- Prod server always returns requiresApproval=true regardless of policy
- Auto-approve works for dev/demo with matching policy
- My Access widget shows correct servers with TTLs
- Policy evaluation considers group membership
