# Task 21c — Provisioning manifest in /api/hosts/validate

**Phase:** 21A
**Plan:** `.claude/plans/phase-21-jit-user-provisioning.md`
**Agent:** backend
**Depends on:** task-21a, task-21b

## Scope
Extend the `POST /api/hosts/validate` response (called by each target's `check-principals` on every SSH) to include a provisioning manifest when the access request is valid.

## Steps
1. Build a `buildProvisioningManifest(user, accessRequest, policy)` helper that returns:
   ```js
   {
     linuxUser: `${sanitized(user.username)}_jit`,
     uid: await jitUidService.getOrAllocateUid(orgId, user.id),
     groups: policy.osProvisioning?.linuxGroups || [],
     sudo: !!policy.osProvisioning?.sudo,
     aclReadPaths: policy.osProvisioning?.aclReadPaths || [],
     aclRecursive: !!policy.osProvisioning?.aclRecursive,
     hardCutoff: !!policy.osProvisioning?.hardCutoff,
     leaseId: accessRequest.id,
     ttlSeconds: Math.max(0, Math.floor((accessRequest.expiresAt - Date.now()) / 1000)),
   }
   ```
2. Attach the manifest under `data.manifest` in the validate response. Existing `valid` boolean stays for backwards compatibility.
3. Cert signer: ensure the principal encoded in the cert matches `linuxUser` (e.g. `alice_jit`), not `ubuntu`. Update `certService` accordingly — backwards-compat path: if `policy.osProvisioning` is empty, fall back to the current principal behavior so existing hosts still work until their bootstrap is upgraded.
4. Do not return the manifest if `valid === false`.

## Verification
- Valid request: response contains `manifest` with correct shape.
- Invalid request: no `manifest` field.
- Legacy policy with empty `osProvisioning`: manifest has sensible defaults, no crash, principal stays backwards compatible.
- Existing hosts (with old `check-principals` that ignores `manifest`) still validate normally.
