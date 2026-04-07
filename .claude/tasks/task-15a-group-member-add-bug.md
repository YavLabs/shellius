# Task 15A: Group Member Add — Silent Failure

**Agent:** debugger → frontend (handoff)
**Status:** [x] Done
**Blocks:** 15Q-A, 15R-A
**Blocked By:** None
**Model:** sonnet (default)

## Objective
Adding a member via the Add Member modal in `/groups/:id` returns 200 but
the new member never shows up in the table. Verify whether the DB row
exists; if yes, this is a frontend unwrap/refetch bug; if no, the route
or service is dropping the write.

## Steps for the debugger
1. Reproduce against `https://shellius.yavlabs.com`. Add a member, watch
   the network tab for `POST /api/groups/:id/members` and the next
   `GET /api/groups/:id`.
2. `docker exec shellius-postgres-1 psql -U shellius -d shellius -c
   "select user_id, group_id, added_at from group_memberships order by
   added_at desc limit 5;"` — confirm whether the row exists.
3. Inspect `frontend/src/services/groupService.js`:
   - `addGroupMember` returns `r.data.data` — is that `{ membership }` or
     just `membership`?
   - `getGroup` — does it return the wrapped row or the unwrapped one?
     The earlier service unwrap audit (Task 13C) marked groupService as
     done, but only `listGroups` / `getGroup` / `createGroup` /
     `updateGroup` were touched. `addGroupMember` may still be wrapper-shape.
4. Inspect `frontend/src/pages/GroupDetail.jsx`:
   - Where does it set `members`? Does it read from `group.memberships`,
     `group._count`, or a separate field?
   - After `addGroupMember`, does it `await fetch()` (refetch the group)
     or does it locally append the new row to state?
5. Inspect `backend/src/routes/groups.js` `POST /:id/members` handler:
   - Confirm the `prisma.groupMembership.create` is awaited and the
     resulting `group` (with `memberships` included) is returned.
   - Check the relation include depth — `group.memberships.user`?

## Likely fix
- `groupService.addGroupMember` should unwrap to the membership object.
- `groupService.getGroup` should include the `memberships.user` relation
  in the response, OR the page should call a separate
  `listGroupMembers(id)` endpoint.
- After add, `GroupDetail` should refetch the group AND set
  `setMembers(group.memberships ?? [])`.

## Deliverables
- Backend route fix (if needed)
- Frontend service unwrap fix
- Frontend GroupDetail refetch / state-update fix
- Hand off to **frontend** agent for the actual code edit if the
  debugger doesn't ship code itself.

## Acceptance
- Adding a member shows the new row immediately, or after one refetch
  with no manual reload.
- DB row exists.
- Removing a member also reflects without reload.
