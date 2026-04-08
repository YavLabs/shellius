# Task 21k — E2E host test for JIT provisioning

**Phase:** 21B
**Agent:** qa
**Depends on:** task-21h, task-21i, task-21j

## Scope
End-to-end test of the v2 bootstrap + provisioning stack against a clean Ubuntu VM.

## Steps
1. Spin up a fresh `ubuntu:22.04` VM or container with SSH exposed.
2. Run `bootstrap.sh` pointing at the local Shellius backend.
3. Create a test user in Shellius, assign a policy with:
   - `linuxGroups: ["docker"]`
   - `sudo: false`
   - `aclReadPaths: ["/home/ubuntu"]`
   - `hardCutoff: false`
4. Submit access request (1 min TTL), approve, connect via web terminal.
5. Verify on the target: `id <user>_jit` shows the allocated UID + docker group, `/home/<user>_jit` exists, `getfacl /home/ubuntu` shows the user entry, `/etc/sudoers.d/shellius-*` does NOT exist.
6. Let the lease expire (~2 min), connect again (fails, expected).
7. Wait for reaper (~5 min) OR trigger manually: `systemctl start shellius-jit-reap`.
8. Verify the user is gone: `id <user>_jit` returns no such user, lease file deleted, ACL stripped, `/home/<user>_jit` removed.
9. Reconnect with a new access request → same user → SAME UID allocated (stable).
10. Toggle `hardCutoff: true`, start a session, let it expire, confirm the session is killed on reap.

## Acceptance
- All 10 steps pass without manual intervention.
- `/var/log/shellius-jit.log` has structured entries for each action.
