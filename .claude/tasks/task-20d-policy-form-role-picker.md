# Task 20d — Role picker in PolicyForm

**Phase:** 20
**Plan:** `.claude/plans/phase-20-role-policies.md`
**Agent:** frontend
**Depends on:** task-20c

## Scope
Add a Role selector to Step 2 of `frontend/src/components/policies/PolicyForm.jsx` (around lines 161-335) alongside the existing Users and Groups pickers.

## Steps
1. Change the existing `grid grid-cols-2` in Step 2 to `grid grid-cols-3`.
2. Add a third column "Roles":
   - Static list: `const ROLES = ['super_admin','admin','operator','viewer']`
   - Render each as a clickable row that calls `addSubject('ROLE', role, role)`.
3. Update the selected-subjects chip strip to render ROLE chips with a distinct badge color (e.g. violet-500/20 bg, violet-700 text) to visually separate from USER/GROUP chips.
4. Ensure `removeSubject` works on ROLE subjects identically.

## Verification
- Create a new policy → Step 2 → pick "operator" from the roles column → save → reopen the policy, role chip still present.
- Edit a policy that mixes USER + GROUP + ROLE subjects — all chips render with correct colors.
- Save → backend receives all three subject types, persists them.
