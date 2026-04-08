# Task 21i — Reaper systemd timer + reap-on-connect

**Phase:** 21B
**Plan:** `.claude/plans/phase-21-jit-user-provisioning.md`
**Agent:** devops
**Depends on:** task-21h

## Scope
Two cleanup mechanisms for expired JIT users: reap-on-next-connect (inside `check-principals validate`) and a oneshot systemd timer (`check-principals reap`).

## Steps
1. `check-principals reap` subcommand:
   - Walk `/var/lib/shellius/jit/*.lease`.
   - For each lease whose `expiresAt` has passed:
     - If the user has an active login (`loginctl show-user <linuxUser>` returns a session AND the lease's `hardCutoff` is false): skip this pass, retry next tick.
     - Else: `userdel -r <linuxUser>`, remove `/etc/sudoers.d/shellius-<linuxUser>`, strip ACLs from `aclReadPaths`, delete the lease file.
     - If `hardCutoff === true`: `loginctl kill-user <linuxUser>` before `userdel`.
2. `check-principals validate` also runs the same reap logic at the top of each invocation (reap-on-connect — costs nothing on busy hosts).
3. Systemd units installed by bootstrap:
   - `shellius-jit-reap.service` (Type=oneshot, ExecStart=/usr/local/bin/check-principals reap).
   - `shellius-jit-reap.timer` (OnBootSec=5min, OnUnitActiveSec=5min).
4. Logrotate drop-in `/etc/logrotate.d/shellius-jit` for `/var/log/shellius-jit.log`.

## Verification
- Create a JIT user with a 1-minute lease, wait 2 minutes, confirm user is gone and lease file is removed.
- Active SSH session blocks reap (default) until user logs out.
- `hardCutoff: true` → active session is killed on reap.
- Timer fires every 5 min: `systemctl list-timers | grep shellius-jit-reap`.
