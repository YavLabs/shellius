# Task 18D: Policy Evaluator outcome shows null

**Agent:** debugger → frontend
**Status:** [ ] Pending
**Blocks:** 18Q-D, 18R-D
**Blocked By:** None
**Model:** sonnet

## Symptom
The Phase 14E Policy Evaluator panel always renders the outcome label
as `null`. The result card shows up but the allow/deny/requires-approval
text is missing.

## Diagnosis
1. Read `backend/src/services/policyService.js` `evaluate()` and
   `backend/src/routes/policies.js` `POST /evaluate`. Find the actual
   key the backend returns the outcome under (likely `effect`,
   `decision`, `result`, or `outcome`).
2. Read `frontend/src/components/policies/PolicyEvaluator.jsx` and
   find the line that reads `result.outcome` (or whatever it's
   called). Compare to the actual backend shape.

## Fix
- Update PolicyEvaluator.jsx to read from the correct field
- If the backend returns a more useful object (matched policy id,
  applied constraints, etc.) surface that too in the result card
- Add a Jest test on the route's response shape so the contract
  can never silently drift again

## Acceptance
- Running the evaluator against a (user, server) pair returns and
  displays one of: `allow` / `deny` / `requires_approval` (or whatever
  the canonical values are)
- The matched policy name and applied constraints are also visible
