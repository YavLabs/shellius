# Task 20q — QA gates for Phase 20

**Phase:** 20
**Agent:** qa

## Acceptance criteria
- [ ] `SubjectType` enum has `USER`, `GROUP`, `ROLE`.
- [ ] Create policy attached to role `operator` via UI, save, reopen, data round-trips.
- [ ] A user with `role=operator` matches the policy without being listed individually.
- [ ] Changing that user's role to `viewer` removes the match (confirmed via access evaluation).
- [ ] Deny-wins: a ROLE-denied policy beats a USER-allowed policy at equal priority.
- [ ] Mixed subject policies (USER + GROUP + ROLE) evaluate correctly.
- [ ] POST `/api/policies` with invalid ROLE subjectId returns 400.
- [ ] No regression on existing USER-only or GROUP-only policies.
- [ ] Policy list, detail, and audit log all render ROLE subjects with the violet badge.
