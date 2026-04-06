# Task 6C: Policy Frontend

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** 6B

## Objective
Build the Policies page with a data table and multi-step policy creation form, plus a "My Access" widget for the dashboard showing the current user's accessible servers.

## Deliverables
- `client/src/pages/Policies.jsx` — data table with columns: name, effect (color-coded ALLOW/DENY), environment, subjects count, priority, status; row actions: edit, delete; filters by effect and environment
- `client/src/components/PolicyForm.jsx` — multi-step form:
  - Step 1: Name, description, effect (ALLOW/DENY), priority
  - Step 2: Subjects (search and add users/groups/roles)
  - Step 3: Servers (select servers or environments), principals
  - Step 4: Options (max session duration, require approval, require MFA)
  - Step 5: Review and confirm
- `client/src/components/MyAccess.jsx` — dashboard widget showing servers the current user can access, grouped by customer/environment, with badge for approval-required servers
- `client/src/hooks/usePolicies.js` — React Query hooks for policy CRUD and evaluation endpoints

## Acceptance Criteria
- Policies page displays all policies with correct color-coding for ALLOW (green) and DENY (red)
- Multi-step form validates each step before allowing progression
- PolicyForm correctly submits with subjects and server selections
- MyAccess widget shows accessible servers grouped by customer and environment
- Servers requiring approval are visually distinguished
- Delete action shows confirmation dialog
- All API errors displayed as toast notifications
