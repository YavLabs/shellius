# Task 14E: Policy Priority Fix + Evaluator Panel

**Agent:** frontend (with backend touchpoint)
**Status:** [x] Done
**Blocks:** 14L
**Blocked By:** None

## Objective
Two related fixes on the Policies page:
1. The form ships `priority: 0` by default; backend Joi requires
   `priority >= 1`. The very first save 400s with
   `"priority" must be greater than or equal to 1`.
2. The backend exposes `POST /api/policies/evaluate` (preview a policy
   against a `(user, server)` pair) but no UI calls it. Admins have no
   way to test a policy before saving.

## Deliverables

### Priority fix
- `frontend/src/components/policies/PolicyForm.jsx` (or wherever the
  basics step lives):
  - Default `priority` state to `1`, not `0`
  - `<Input type="number" min={1} max={1000} ...>` so HTML validation
    blocks zero/negative
  - Inline help text: "Higher priority policies override lower ones"
  - On submit, coerce `priority = Math.max(1, Number(priority))`

### Evaluator panel
- `frontend/src/components/policies/PolicyEvaluator.jsx`:
  - Props: `policy` (in-progress draft from the form, or saved row)
  - Inputs: user picker (existing user select), server picker, optional
    requestedPrincipal text
  - Button: "Preview" → calls
    `policyService.evaluatePolicy({ policyId? draft?, userId, serverId })`
  - Render: outcome (allow / deny / requires-approval), matched rule,
    constraint summary
- Add an "Evaluate" button on the form footer (admin+) that opens the
  evaluator in a side panel or expanded card
- On the Policies list, add a per-row "Test" action that opens the
  evaluator pre-loaded with that policy

### Backend touchpoint
- `backend/src/routes/policies.js` `POST /evaluate` should accept either
  `policyId` (test against a saved policy) or `policy` (test a draft).
  Verify the service supports both shapes.

## Acceptance
- Submitting the form with default values no longer 400s.
- Admins can preview the outcome of a policy against any (user, server)
  pair without saving the draft first.
- Existing saved policies have a Test action in the row menu.
