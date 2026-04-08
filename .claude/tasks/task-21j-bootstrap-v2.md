# Task 21j — Update bootstrap.sh to install check-principals v2 + reaper

**Phase:** 21B
**Plan:** `.claude/plans/phase-21-jit-user-provisioning.md`
**Agent:** devops
**Depends on:** task-21h, task-21i

## Scope
Update `scripts/bootstrap.sh` so a single re-run upgrades an existing host to the v2 provisioning stack without breaking its current operation.

## Steps
1. Download/install the new `check-principals` Go binary to `/usr/local/bin/check-principals` (mode 0755, root:root).
2. Update `/etc/ssh/sshd_config.d/shellius.conf` so `AuthorizedPrincipalsCommand=/usr/local/bin/check-principals validate %u` (if not already).
3. Install a narrow `/etc/sudoers.d/shellius-check-principals` granting the sshd-invoked helper only the exact commands it needs: `useradd`, `usermod`, `userdel`, `gpasswd`, `setfacl`, `tee /etc/sudoers.d/shellius-*`, `loginctl`. Do NOT grant blanket ALL.
4. Install `shellius-jit-reap.service` + `.timer` units, enable + start the timer.
5. Install the logrotate drop-in.
6. `mkdir -p /var/lib/shellius/jit /var/log` with correct perms.
7. Idempotent: re-running is a no-op on an up-to-date host.
8. `bootstrap.sh --upgrade` flag that runs just the upgrade steps on an already-bootstrapped host without touching CA trust.
9. Reload sshd at the end.

## Verification
- Fresh Ubuntu 22.04 VM → run bootstrap → SSH in as a JIT user via the control plane → user exists, ACLs work, sudoers correct (if enabled), lease expires, reaper cleans up.
- Existing already-bootstrapped host → run `bootstrap.sh --upgrade` → all v2 components installed, existing access not interrupted.
