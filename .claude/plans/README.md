# Shellius — Active Phase Plans

Index of the currently-proposed phases. Sorted by phase number. Each file is a self-contained plan with tasks, acceptance criteria, and open questions.

## Queued (proposed, awaiting go-ahead)

- [Phase 19 — MinIO for session recordings](phase-19-minio-recordings.md)
  Replicate VaultHive's MinIO deployment. Recordings live in MinIO, browsable at `/minio/`. Replaces the local-disk `recordings` volume.

- [Phase 20 — Role-based policy attachment](phase-20-role-policies.md)
  Extend `AccessPolicy` subjects to support `ROLE` in addition to `USER` and `GROUP`. Small enum + service + form change.

- [Phase 21 — Agentless JIT user provisioning](phase-21-jit-user-provisioning.md)
  Per-user Linux accounts created on connect, reaped on expiry, via the existing `check-principals` sshd hook plus a oneshot reaper timer. No persistent daemon on targets. Includes break-glass, key-download gating, `osProvisioning` policy block.

- [Phase 22 — TUI redesign: Claude-Code feel](phase-22-tui-redesign.md)
  Rebuild the Go TUI with persistent login (fix the "every run asks to log in" bug), slash-command palette, active-access picker as default view, one-liner install script, clean minimal style. Developer tool installed on the user's laptop, not on target servers.

## Recently completed (see phase files for detail)
See the other `phase-*.md` files at the repo root of this directory.
