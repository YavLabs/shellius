# Task 21q — QA gates for Phase 21A

**Phase:** 21A — control-plane only, zero host impact
**Agent:** qa

## Acceptance criteria
- [ ] Migration `jit_provisioning_fields` applies cleanly, no data loss.
- [ ] `jitUidService` allocates stable, unique, per-org UIDs in 70000-79999 range. Concurrent allocation safe.
- [ ] `/api/hosts/validate` returns a manifest for valid requests, omits it for invalid ones, backwards compatible with existing `check-principals` clients.
- [ ] `osProvisioning` round-trips through the policy form.
- [ ] Break-glass flow works end-to-end (request → audit → notifications → web terminal opens).
- [ ] Non-admin cannot break-glass.
- [ ] SSH key download is denied by default, allowed when policy flag set, audit event logged.
- [ ] Reason field visible in AR list, approval modal, audit log, emails.
- [ ] No regression on existing access request / cert signing flows.
- [ ] **Critical:** existing bootstrapped hosts (with old `check-principals`) keep validating connections normally — Phase 21A must not break them.

## Out of scope (Phase 21B covers)
- Actual Linux user creation on target hosts.
- Reaper timer.
- Windows/RDP.
