# Task 21d — Policy form: OS Provisioning section

**Phase:** 21A
**Plan:** `.claude/plans/phase-21-jit-user-provisioning.md`
**Agent:** frontend
**Depends on:** task-21a

## Scope
Add an "OS Provisioning" section to `frontend/src/components/policies/PolicyForm.jsx` collecting the `osProvisioning` JSON block plus three standalone policy flags.

## Steps
1. New form step (or inline section after target selection):
   - **Linux groups** — comma-separated input, parsed to `string[]`.
   - **Grant sudo** — toggle.
   - **ACL read paths** — list input (add/remove) of absolute paths.
   - **ACL recursive** — toggle (applies to all paths).
   - **Hard cutoff** — toggle with explainer "End active sessions when lease expires".
2. Standalone policy flags (outside `osProvisioning`):
   - **Allow key download** — toggle with red "risky" warning banner.
   - **Break-glass policy** — toggle, admin-only edit, with red warning banner and mandatory confirmation modal.
3. Backend payload: send `osProvisioning: { linuxGroups, sudo, aclReadPaths, aclRecursive, hardCutoff }` and top-level `allowKeyDownload`, `isBreakGlass`.
4. Display these fields on the policy detail/view page as well.

## Verification
- Create policy with groups `docker,webapp`, sudo off, ACL read `/home/ubuntu` non-recursive, hard cutoff off → saved and round-trips.
- Break-glass toggle blocks non-admin users.
- Key download toggle shows warning.
