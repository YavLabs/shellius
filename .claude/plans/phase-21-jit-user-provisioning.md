# Phase 21 — Agentless Just-In-Time User Provisioning

## Goal
Replace the "everyone logs in as `ubuntu`" pattern with per-user Linux accounts that are created on demand at connect time, scoped to the access request, and reaped after expiry. **Without** running a persistent Shellius daemon on target hosts — extend only what sshd already invokes (`check-principals`) plus a one-shot systemd reaper timer (same weight as the existing heartbeat unit).

## Non-negotiables (from user)
- No long-running agent on target machines.
- No reverse tunnels / persistent control sockets from host → control plane.
- Bootstrap footprint stays minimal: CA pubkey, sshd config, `check-principals`, heartbeat timer, plus (new) a reaper oneshot timer. Nothing else.

## Design summary

### Provisioning happens inside the SSH connection hook
Shellius already requires target hosts to call `POST /api/hosts/validate` on every inbound SSH via sshd's `AuthorizedPrincipalsCommand=check-principals` (CLAUDE.md principle #3). We extend the response from a boolean into a **provisioning manifest**:

```json
{
  "valid": true,
  "linuxUser": "alice_jit",
  "uid": 70142,
  "groups": ["docker"],
  "sudo": false,
  "aclReadPaths": ["/home/ubuntu"],
  "hardCutoff": false,
  "leaseId": "ar_01HXYZ…",
  "ttlSeconds": 3600
}
```

`check-principals` applies the manifest idempotently **before** returning success to sshd:
1. `id -u alice_jit || useradd -m -u <uid> -s /bin/bash alice_jit`
2. Diff current groups vs manifest.groups, `usermod -aG` / `gpasswd -d` to converge.
3. If `sudo: true` → write `/etc/sudoers.d/shellius-alice_jit` (0440, NOPASSWD scope TBD); else ensure file is absent.
4. `aclReadPaths` → `setfacl -m u:alice_jit:rX <path>` for each (non-recursive on top dir by default, recursive opt-in per-policy).
5. Record lease to `/var/lib/shellius/jit/<user>.lease` with expiry + leaseId + policyId.
6. Return success to sshd.

Fails closed: any provisioning error aborts the connection.

### UID allocation
- Per-org reserved range: `70000-79999`.
- Stored on `User` model as `jitUid Int?` (allocated lazily on first JIT connect, reused forever).
- Manifest always returns the stable UID so ownership stays consistent across reconnects and across hosts.

### Policy → OS mapping
Extend `AccessPolicy` with a JSON `osProvisioning` column:
```json
{
  "linuxGroups": ["docker"],
  "sudo": false,
  "aclReadPaths": ["/home/ubuntu"],
  "aclRecursive": false,
  "homeSkel": "minimal",
  "hardCutoff": false
}
```
Evaluated at cert-signing time, baked into the manifest.

### Cleanup (two layers — both agentless)
**A. Reap-on-next-connect (zero-cost):** every `check-principals` invocation scans `/var/lib/shellius/jit/*.lease`, expires any whose TTL passed AND the user has no live sessions (`loginctl show-user`), runs `userdel -r` + removes sudoers drop-in + strips ACLs.

**B. Reaper timer:** a `shellius-jit-reap.timer` (OnUnitActiveSec=5min) triggering a oneshot `shellius-jit-reap.service` that runs the same scan. Oneshot — no daemon. Same architectural weight as the existing heartbeat timer.

Active sessions are never killed unless `hardCutoff: true` (then `loginctl kill-user`). Default is graceful — cert expiry blocks new connections; existing shell finishes its work.

### Download-key + break-glass + reason — see Phase 21A below

## Tasks

### Phase A — control plane only (zero host impact)

#### T1 — Schema additions
- [ ] `User.jitUid Int?` with per-org unique constraint.
- [ ] `AccessPolicy.osProvisioning Json @default("{}")`.
- [ ] `AccessPolicy.allowKeyDownload Boolean @default(false)`.
- [ ] `AccessPolicy.isBreakGlass Boolean @default(false)`.
- [ ] Migration `jit_provisioning_fields`.

#### T2 — UID allocator
- [ ] `backend/src/services/jitUidService.js` — atomic allocator: SELECT next free in `70000-79999` for the org, set on User, return. Idempotent per user.

#### T3 — Manifest endpoint
- [ ] Extend `POST /api/hosts/validate` response to include the provisioning manifest when the cert/request is valid.
- [ ] Manifest built from: approved access request + matching policy's `osProvisioning` block + user's `jitUid`.
- [ ] Principal in the cert = `<username>_jit` (not `ubuntu`). Signer must encode this at approval time.

#### T4 — Policy form UI
- [ ] New "OS Provisioning" section in `PolicyForm.jsx`: linux groups multi-input, sudo toggle, ACL read paths list, hardCutoff toggle.
- [ ] "Key download allowed" toggle.
- [ ] "Break-glass policy" toggle with warning banner + admin-only edit.

#### T5 — Break-glass flow
- [ ] `POST /api/access-requests/break-glass` — any admin can invoke; creates an auto-approved request flagged `breakGlass=true`; fan-out notification to all org admins; audit log entry with `event=BREAK_GLASS_INVOKED`.
- [ ] Frontend: red "Break-glass access" action on server detail page, admin-only, confirmation modal with mandatory reason.

#### T6 — Key download gating
- [ ] Gate the existing SSH key download endpoint behind `policy.allowKeyDownload`. Default deny → web terminal only.
- [ ] Audit log `event=KEY_DOWNLOADED` as a distinct, high-severity event.

#### T7 — Reason field surfacing
- [ ] Already stored. Surface prominently in access request list, approval modal, audit log.

**Phase A ships independently.** Existing hosts keep working — they ignore the extra manifest fields.

### Phase B — host bootstrap v2 (requires re-bootstrap of existing hosts)

#### T8 — Extend `scripts/bootstrap.sh`
- [ ] Install updated `check-principals` (now a Go binary or beefed-up bash) that:
  - parses the manifest JSON from the `/api/hosts/validate` response
  - applies it idempotently (useradd, groups, sudoers, setfacl, lease file)
  - fails closed on any error
- [ ] Install `shellius-jit-reap.service` + `.timer` (oneshot, OnUnitActiveSec=5min).
- [ ] Install `/etc/sudoers.d/shellius-check-principals` granting the sshd-invoked helper the narrow set of commands it needs (`useradd`, `usermod`, `userdel`, `setfacl`, `gpasswd`, `tee /etc/sudoers.d/shellius-*`).

#### T9 — `check-principals` implementation
- [ ] New repo path `scripts/check-principals/` (Go, single binary, <5MB).
- [ ] Commands: `validate` (called by sshd), `reap` (called by timer).
- [ ] Logs to `/var/log/shellius-jit.log` (rotated via logrotate drop-in).

#### T10 — Lease file format
- [ ] `/var/lib/shellius/jit/<user>.lease` — JSON: `{ leaseId, policyId, expiresAt, uid, groups, sudo, aclPaths }`.
- [ ] Used by reaper to know what to undo.

#### T11 — E2E test
- [ ] Spin up a fresh Ubuntu VM, run the bootstrap, issue an access request, connect, confirm:
  - new user exists with correct UID + groups
  - user can access `/home/ubuntu` read-only via ACL
  - no password sudo unless policy says so
- [ ] Let lease expire, confirm reaper deletes the user, lease file gone, sudoers drop-in gone.
- [ ] Reconnect the same user later — UID is reused.

### Phase C — Windows / RDP JIT (deferred)
- Similar pattern via Guacamole connection prep hook. Separate design doc when we get there.

## Risks / decisions needed before starting
1. **`check-principals` now mutates the system as root.** Fail-closed is mandatory. Decision: confirm OK.
2. **Provisioning latency on first connect** (~100-300ms for useradd, longer if ACL recursive). Subsequent connects in the same lease are no-ops. Decision: acceptable?
3. **`/etc/passwd` growth** on long-lived boxes — reaper handles it, but confirm we're not moving to SSSD/LDAP (heavier path explicitly rejected).
4. **Re-bootstrap requirement** for existing hosts in Phase B. Is a one-command `bootstrap.sh --upgrade` acceptable, or do we need in-place rolling upgrade?

## Out of scope
- Windows/RDP (Phase C).
- SSO of Linux accounts back to IdP (still local users, just ephemeral).
- Home directory encryption.
