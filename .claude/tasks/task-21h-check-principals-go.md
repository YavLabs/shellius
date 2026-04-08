# Task 21h — Rewrite check-principals as Go binary

**Phase:** 21B — host bootstrap v2
**Plan:** `.claude/plans/phase-21-jit-user-provisioning.md`
**Agent:** backend (Go) / devops
**Depends on:** task-21c (manifest endpoint must be live)

## Scope
Replace the current `check-principals` shell helper with a Go binary under `scripts/check-principals/` that parses the provisioning manifest and applies it idempotently before returning success to sshd.

## Steps
1. New Go module `scripts/check-principals/` with subcommands:
   - `validate <username>` — called by sshd via `AuthorizedPrincipalsCommand`. POSTs to `/api/hosts/validate`, parses response, applies manifest, exits 0 with the cert principal on stdout.
   - `reap` — called by the systemd timer; scans lease files and expires stale users (see task-21i).
2. Manifest application (all idempotent, fail-closed):
   - `id -u <linuxUser>` → if missing, `useradd -m -u <uid> -s /bin/bash <linuxUser>`.
   - Diff current groups vs `manifest.groups`; `usermod -aG` / `gpasswd -d` to converge.
   - If `manifest.sudo === true` → write `/etc/sudoers.d/shellius-<linuxUser>` (mode 0440, content: `<linuxUser> ALL=(ALL) NOPASSWD: ALL`). Else ensure absent.
   - For each `manifest.aclReadPaths`: `setfacl [-R] -m u:<linuxUser>:rX <path>`. Recursive only if `manifest.aclRecursive`.
   - Write/update lease file `/var/lib/shellius/jit/<linuxUser>.lease` (JSON: leaseId, policyId, expiresAt, uid, groups, sudo, aclPaths).
3. Logging: structured JSON to `/var/log/shellius-jit.log`, one line per run. Include provisioning deltas.
4. Fail-closed: any error aborts the connection (non-zero exit).
5. Cross-compile: static linux/amd64 + linux/arm64 binaries.

## Verification
- Unit tests for manifest application with mocked command runner.
- Integration test on a throwaway container: hit it with a manifest, verify user exists with correct groups, ACL, sudoers entry, lease file.
- Idempotent: running twice with the same manifest is a no-op on the second run (except lease file mtime).
- Error paths (malformed manifest, useradd failure, setfacl failure) all fail closed with non-zero exit and logged error.
