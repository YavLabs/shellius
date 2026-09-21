# Shellius Posture — implementation specification

Status: **accepted, in build**. Decisions settled 2026-09-20.
Source design: `.posture-wip/posture-design.md` (the reasoning) and
`.posture-wip/shellius-posture-scan.sh` (the reference collector).
This document is the build contract; where the two disagree, this one wins.

---

## 1. Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | v1 breadth | **Phases 1–4**: snapshot + inventory, cloud SG join, drift + alerting, resource gauges |
| 2 | Collector privilege | **Root + a narrow sudoers drop-in. No `docker` group, no Docker socket.** Container id→name degrades to `runtime:<short-id>` where it cannot be resolved, and we say so in the UI |
| 3 | UI placement | **Top-level Posture page + a Posture tab on server detail** |
| 4 | Rollout | **`bootstrap.sh --upgrade` per host**, and the collector is installed automatically by the normal bootstrap / auto-provision flow so every newly added or re-provisioned server gets it |
| 5 | Retention | **Org-configurable**, with defaults: snapshots 7d, metric samples 24h, findings kept until resolved + 90d |
| 6 | Alerting | **Rule-based routing** (§6), not a hard-coded admin list |
| 7 | Noise suppression | **Per-finding mute with reason + expiry, plus an org-level expected-public port list** |
| 8 | Firewall engines | **ufw + firewalld** in v1. nftables/iptables hosts report "no usable firewall data" and firewall-dependent verdicts are withheld rather than guessed |
| 9 | Cross-feature | Posture stays in its own surfaces. **No badge in the access-request flow** |

### Carried over from the design doc, unchanged

- Separate systemd unit and timer from `check-principals`. A crashing collector
  must never be able to break SSH authentication on a prod box.
- The snapshot is **attacker-controlled input from a host that may already be
  compromised**. Hard Joi caps on every array and string; reject, never truncate.
- Never call it "Monitoring" in the UI.
- Windows/RDP hosts are explicitly out of scope for v1 and are labelled as such,
  not shown as "clean".

---

## 2. Data model

Per the design doc's sketch, with the additions the decisions above require.

```prisma
model HostSnapshot {
  id           String   @id @default(cuid())
  orgId        String   @map("org_id")
  serverId     String   @map("server_id")
  collectedAt  DateTime @map("collected_at")
  agentVersion String?  @map("agent_version")
  collectorOk  Boolean  @default(true) @map("collector_ok")   // false = collector ran but degraded
  degradedReason String? @map("degraded_reason")              // "no docker socket", "firewall engine unknown"
  firewall     Json     // { engine: ufw|firewalld|none|unknown, active, defaultIncoming }
  raw          Json
  @@index([orgId, serverId, collectedAt])
}

model HostListener { /* as designed; ownerUser, sourcePath, containerPort included */ }

model ExposureFinding {
  // as designed, plus:
  acknowledgedAt   DateTime? @map("acknowledged_at")
  acknowledgedById String?   @map("acknowledged_by_id")
  severityOverride String?   @map("severity_override")   // org policy can lower/raise
  @@unique([orgId, serverId, code, proto, port])
}

model HostMetricSample {
  id         String   @id @default(cuid())
  orgId      String   @map("org_id")
  serverId   String   @map("server_id")
  at         DateTime
  cpuPct     Float?   @map("cpu_pct")
  memPct     Float?   @map("mem_pct")
  diskPct    Float?   @map("disk_pct")
  load1      Float?   @map("load_1")
  @@index([orgId, serverId, at])
}

model PostureAlertRule { /* §6 */ }
model PostureSettings  { /* org-level: retention, expected-public ports, collector interval */ }
```

**Why findings are long-lived rows, not events:** `firstSeenAt` / `resolvedAt`
is what makes "open for 14 days" and "who resolved it" answerable without a
time-series store. A row per scan would be a TSDB by accident.

**Customer scope applies.** Every posture read is filtered by the same
`lib/scope.js` predicate through the `server` relation
(`docs/rbac/customer-scope-spec.md`). Posture is shipping after that work
precisely so it is scoped from day one rather than retrofitted.

---

## 3. Ingest

`POST /api/hosts/posture` — `agentAuth`, per-host token, identity taken from
the token exactly as `routes/hosts.js` does today; `serverId`/`orgId` in the
body are ignored in per-host-token mode.

Caps (reject with 413/400, never truncate): ≤ 500 listeners, ≤ 200 firewall
rules, ≤ 300 services, every string ≤ 512 chars, whole body ≤ 256 KB.

`postureService.ingest()`:
1. Persist the snapshot.
2. Replace the listener set for that server.
3. Recompute findings, diffing against the previous open set:
   open new ones, touch `lastSeenAt` on continuing ones, `resolvedAt` the gone.
4. Emit alert events for transitions only (§6).

**Idempotency and clock skew:** snapshots carry the agent's `collectedAt`, but
ordering uses server receipt time. A snapshot older than the newest stored one
is accepted for history and ignored for finding state, so a late retry cannot
resurrect a resolved finding.

---

## 4. Collector and rollout

**Implementation note (supersedes anything above that conflicts):** there is
no standalone `scripts/bootstrap.sh` file — the host installer is generated
per-request by `backend/src/routes/bootstrap.js` (`GET
/api/bootstrap/install.sh`). Posture packaging follows the same model: the
canonical, lintable sources live in `scripts/posture/` (shipped in both
`docker/Dockerfile.backend` and `docker/Dockerfile.allinone` via `COPY
scripts/posture/`) and `bootstrap.js` reads them at request time and embeds
them as base64 blobs in the generated `install.sh`, decoded and written to
disk by two new, unconditional steps (`[10/14]`, `[11/14]` — run on both a
first bootstrap and `--upgrade`). Base64, not the printf-per-line technique
`check-principals` uses, specifically to avoid a latent bug in that technique:
a JS template literal silently drops a trailing `\` wherever the source
contains the two-character sequence `\'`, which breaks any embedded script
that relies on bash line-continuation.

- Separate unit `shellius-posture.service` + `shellius-posture.timer`,
  currently a fixed 5 minutes (`OnUnitActiveSec=5min`, `RandomizedDelaySec=30`
  to avoid fleet-wide lockstep). Wiring the interval to
  `PostureSettings.collectorIntervalSeconds` (org-configurable, floor 1
  minute) is a follow-up for whoever owns `PostureSettings` — the unit is
  regenerated on every `--upgrade`, so that just becomes another templated
  value in `shellius-posture.timer` when the settings API exists.
- `MemoryMax=128M` and `CPUQuota=20%` on the unit, plus `NoNewPrivileges`,
  `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp` and friends. A collector
  that OOMs or is compromised is a reported degradation, never a broken host
  and never a way to escalate past its own sudoers grant.
- **Collector privilege, precisely:** the unit runs as a dedicated,
  unprivileged, login-less system account (`shellius-posture`) — not root,
  not `nobody` (kept separate from `check-principals`'s account so the two
  agents' privilege grants never compound), not in the `docker` group, and
  with no Docker socket access at all. Root-only operations go through
  `sudo -n` for exactly six fixed commands (sudoers drop-in, verbatim, at
  `scripts/posture/shellius-posture.sudoers`):
  `ss -H -tulpn`, `ufw status verbose`, `firewall-cmd --list-all`,
  `systemctl show -p FragmentPath --value <unit>`, `iptables -t nat -S`, and
  `nft list table ip nat`. Same narrow-drop-in style as `check-principals`,
  different account, different command set.
- **Consequence, stated plainly because it changes what v1 can see:** with no
  Docker socket access at all, container id→name/image resolution is not a
  sometimes-degrades case, it **never** resolves — every container listener
  reports `ownerName: "docker:<12-char-id>"` (or `podman:<id>`) and the
  snapshot carries `collectorOk: false` with a `degradedReason` whenever this
  happens. The common case (Docker's default `userland-proxy=true`) is
  fully detected, including `DOCKER_FIREWALL_BYPASS` evidence — the
  `docker-proxy` process's own `/proc/<pid>/cmdline` names the real
  container's ip:port and needs no socket access.
  **The `userland-proxy=false` / DNAT-only gap — no host listener, no
  `docker-proxy` process, only a `nat/PREROUTING` rule — is now CLOSED**,
  without a Docker socket: the collector reads the NAT table through the
  same narrow sudoers grant (`iptables -t nat -S`, falling back to
  `nft list table ip nat` on nft-native hosts), parses DNAT rules into
  host proto/port → container ip:port, and emits them as listeners with
  `"source": "nat"` and `containerPort` set. It also raises
  `DOCKER_FIREWALL_BYPASS` evidence for these exactly as it already does for
  `docker-proxy` rows, since both are DNAT'd through the same chain the host
  firewall's `INPUT` rules never see. A NAT-derived row is deduplicated
  against any `ss`-sourced row for the same `proto:bind:port` (dedup always
  prefers the `ss` source — see `dedupe_endpoints()` in the collector — so a
  userland-proxy=true port is never double-counted or downgraded); a NAT-only
  port that `ss` has no row for at all is what actually surfaces the
  DNAT-only case. The container id behind a NAT-derived row is resolved on a
  best-effort basis by scanning `/proc` for a container whose own network
  namespace shows a LISTEN on the container-side port (no socket, no
  `nsenter`); where that does not resolve to exactly one candidate, the row
  is still reported — never dropped — as `ownerKind: "docker"`,
  `ownerName: "runtime:<container-ip>:<container-port>"`. **What remains
  genuinely unavailable, with or without the NAT-table read, is the same as
  the cgroup case above: a container's name and image**, because that
  mapping only exists behind `docker inspect` / the Docker socket, which
  this privilege model deliberately continues to exclude.
- The collector emits evidence only — listeners (with a host-computed
  `reachability` verdict per §2's `HostListener`, since that needs host-local
  firewall state only available at collection time) and firewall rules. It
  raises no findings; `postureService.ingest()` is the only place findings
  are computed, exactly per §3.
- Installed by the generated install script on first bootstrap **and** by
  `--upgrade`, so the auto-provision flow (`POST /api/servers/:id/provision`
  and the bulk onboarding job) covers it with no extra step. Uninstall
  (`GET /api/bootstrap/uninstall.sh`) removes the timer/unit (disabling first),
  the sudoers drop-in, both scripts, and the `shellius-posture` account —
  but only that account if it still looks Shellius-created (system uid,
  `nologin` shell); a colliding pre-existing local account of the same name
  is left alone.
- The wrapper (`shellius-posture-report`, run by the unit) authenticates to
  `POST /api/hosts/posture` exactly the way `shellius-heartbeat` authenticates
  to `POST /api/hosts/heartbeat`: the per-host token at
  `/etc/shellius/agent-token`, sent as the `x-agent-token` header, resolved by
  `agentAuth`. `serverId`/`orgId` are never sent — identity comes from the
  token. It enforces its own 256 KB payload cap (mirroring the server's,
  §3) and drops an oversized payload rather than truncating it; retries once,
  only on a transport error or a 5xx (never on a 4xx, which is not
  transient); 15 s curl timeout.
- The UI shows, per server: collector installed / version / last snapshot, and
  a copy-paste `--upgrade` command for hosts that predate it.

**Resolved gap — credential-mode hosts.** Servers with `authMode: 'credential'`
deliberately never run bootstrap (`ServerDetail.jsx` hides the bootstrap card
for them: "no agent or bootstrap is required" — Shellius connects with the
stored Keystore identity directly). That made them a permanent posture blind
spot: the only installer that existed also configured sshd for certificate
auth, CA trust, and JIT provisioning, none of which a credential-mode host
wants or needs. **`mode=posture`** closes this gap with a reduced installer
that adds *only* the posture collector — see below.

- **Requesting it:** `POST /api/bootstrap/token` and `POST
  /api/bootstrap/uninstall-token` accept an optional `mode` field —
  `'full'` (default, unchanged) or `'posture'`. Both mints are customer-scope
  filtered exactly as before (`serverScopeWhere(req.scope)`); `mode` doesn't
  change that. The mode is encoded **inside the signed JWT** returned by the
  mint (`payload.mode`), not as a separate query parameter on
  `GET /api/bootstrap/install.sh` / `uninstall.sh` — those routes only ever
  take `?token=...`, so there is nothing in the URL an operator (or an
  attacker with a logged link) can edit to change which script they get.
  `verifyBootstrapToken`/`verifyUninstallToken` normalize any token without a
  recognized `mode` claim (i.e. every link minted before this shipped) to
  `'full'`, so nothing already issued changes behaviour.
- **What `mode=posture` installs — and only this:** the posture collector
  scripts (`shellius-posture-collect`, `shellius-posture-report`), the
  `shellius-posture.service`/`.timer` systemd units, the narrow
  `/etc/sudoers.d/shellius-posture` drop-in, the unprivileged
  `shellius-posture` system account, and the per-host agent token at
  `/etc/shellius/agent-token` (see "shared token" below). It never writes
  `/etc/ssh/shellius_ca.pub`, never edits `sshd_config`/`sshd_config.d`,
  never installs `check-principals`, and never touches the JIT reaper or
  heartbeat timer — those remain exclusively `mode=full` territory
  (`buildUnixInstallScript`). It is idempotent, supports `--upgrade` (a
  no-op today — every step already re-applies on every run), and its
  uninstall counterpart (`buildPostureOnlyUninstallScript`) removes exactly
  the components above and nothing else.
- **Coexistence of the two modes on one host:** `/etc/shellius/agent-token`
  is the one path both modes write, because it holds a single per-host
  token shared by every agent-authenticated endpoint (heartbeat,
  certificates/verify, posture ingest) — whichever script runs most
  recently mints and writes the current token, which is the existing
  rotation model, not new behaviour. Running `mode=full` on a host that
  already has `mode=posture` installed simply layers CA trust and
  check-principals on top (the full script's own posture steps [10]/[11]
  are byte-identical to what the posture-only script installs, so nothing
  is duplicated or conflicts). Running `mode=posture` on a host that
  already has `mode=full` installed only touches the posture collector
  pieces and the shared token — sshd and CA trust are untouched either way.
  The one place this needs an explicit guard is **uninstall**: the
  posture-only uninstall script checks for full-agent markers
  (`shellius-check-principals`, `shellius_ca.pub`, the sshd drop-in, or the
  inline `# >>> shellius >>>` block) before touching
  `/etc/shellius/agent-token`, and leaves it in place if any are found —
  deleting it would otherwise break `check-principals`'s ability to verify
  certificates on the very next SSH login. The full uninstall script is
  unaffected: it already removes the posture collector unconditionally (§4
  above), which is correct for "remove Shellius entirely from this host."

**Resolved gap — hosts with no stored credentials.** The bulk installer
planned every host into one of two buckets: it had a bound Keystore identity,
or the operator supplied one for the batch. Anything else was skipped as
`no_credentials`. That is the inverse of the truth for the most common case
in an established fleet: a **bootstrapped** host already trusts the org CA,
which is the entire point of bootstrapping it, so it needs no stored secret
at all. A fleet that was fully bootstrapped before posture existed could
therefore plan to **zero** automatic targets — the hosts most ready to be
installed on were the only ones being refused.

- **`credentialSource`** (`bulkBootstrapService.planBulkInstall`) is now
  `'server' | 'certificate' | 'supplied' | null`, in that precedence.
  `'certificate'` applies when `isBootstrapped(server)` — `provisionStatus
  === 'provisioned'` or an `agentId` is set. It outranks `'supplied'`
  deliberately: the batch fallback is one account typed once for hosts that
  have nothing, and there is no reason to believe it exists on a host that
  never needed it.
- **Signing is not enough.** A bootstrapped host runs `check-principals` as
  sshd's `AuthorizedPrincipalsCommand`, which calls
  `POST /api/certificates/verify`; `certificateService.verify()` looks the
  serial up in the DB and, under a per-host agent token, requires
  `issuedForId` to be that host. A certificate from
  `caService.signCertificate()` alone has no row, so verify answers
  "certificate not found" and sshd rejects the login. **Every install
  certificate must be persisted and bound to its server** —
  `installCertService.mintInstallCertificate()` does both, and
  `installCert.test.js` pins it against the real `verify()`.
- **Not `certificateService.issue()`**: that is the human access path, which
  evaluates policy per principal and refuses prod outright. This is the
  platform running an installer on a host the caller already administers —
  the same act bulk install already performs with a stored password, under
  the same `servers.onboard` permission and the same route audit.
- **Narrow by construction:** 300 seconds, one principal (the host's
  `sshUser`, non-nullable and defaulting to `root`), `permit-pty` only, and
  `REVOKED` in the DB as soon as the install returns — so the window is the
  install, not the TTL. The ephemeral private key lives in a 0700 temp dir
  removed in a `finally`, and its buffer is zeroed.
- **Known limit:** certificate auth carries no password, so `sudo -S` has
  nothing to read. A certificate install needs **passwordless sudo**, which
  bootstrap does not grant. Typical on cloud images (`ubuntu`, `ec2-user`);
  not guaranteed. The bulk runner therefore retries once with the supplied
  fallback credentials when a certificate install fails and a fallback
  exists, announcing the retry in the log rather than doing it silently. The
  single-host modal states the requirement instead of offering a sudo-password
  field the mode cannot use.
- **Latent bug found and fixed on the way:** `caService.signCertificate`
  emitted `-O extension=permit-pty`, which ssh-keygen rejects with
  "Unsupported certificate option" — `extension=` is for names it does not
  know, and the five standard permits are options in their own right. Every
  `permit-*` in `certificateService.ALLOWED_EXTENSIONS` would have failed the
  whole signing call. Dormant only because the issue route defaults
  `extensions` to `{}`. `signCertificate` now emits standard permits as bare
  `-O <name>`, preceded by `-O clear` so an explicit list means exactly what
  it says rather than "the defaults, plus these".

**Resolved gap — imported hosts.** Bulk import destroys the credentials it
was given: `stageCredentialAtUpload` encrypts them into an
`OnboardingCredential`, and `jobs/serverOnboarding.js finalize()` nulls every
secret column once onboarding reaches a terminal state (success *and*
failure), with a 6 h TTL reaper for anything left behind. `server.credentialId`
was never set. So a fleet that had just been imported and bootstrapped had
nothing stored for any of its hosts — manufacturing the very `no_credentials`
population the bulk installer then had to skip.

- **`storeAsIdentity`** (boolean, default **false**) and **`identityName`**
  are new columns on the servers import, carried on `OnboardingCredential`
  and applied by `materializeIdentity()` at commit. Opt-in only: an import
  must never quietly turn one-shot bootstrap material into standing access.
- **Dedupe is by `identityName`.** Rows sharing a name collapse into one
  Keystore entry, so fifty servers behind one bastion key produce one
  identity rather than fifty. Unnamed rows fall back to `Imported — <hostname>`.
- **A name collision with a different username fails the row loudly** rather
  than binding the server to someone else's identity.
- **`authMode` is untouched.** The stored identity is for installs and
  recovery; a bootstrapped host keeps authenticating by certificate for
  ordinary access.
- **`sudoPassword` is not stored** — `Credential` has no field for it, and the
  Keystore is deliberately not a password manager. Stated in the template
  rather than dropped silently.

**Coverage counts exclude what cannot run the collector.** `listServerCoverage`
and `getSummary` filtered on `isActive` only, so Windows and RDP-only hosts
were counted as `notInstalled` — a shortfall no action could ever close, shown
on the Posture page and the Dashboard widget, with a per-row Install button
that opened a wizard that could not work. Both now classify via
`canInstallOn()` into a separate `notApplicable` bucket, excluded from
`total`; `totalAll` keeps the true fleet size. The coverage modal reads the
same plan the installer runs from (`lib/installPlan.js groupPlan`), so
"Ready to install: N" and "Install on N hosts" are the same N by construction.

---

## 5. Findings

Taxonomy exactly as the design doc §3.5, with `firewalld` treated as a
first-class engine alongside `ufw`:

- `firewall-cmd --list-all` (zone, services, ports) feeds the same
  ALLOW/DENY/default-deny verdict logic.
- **The `DOCKER_FIREWALL_BYPASS` finding applies to firewalld too**, and for a
  different reason worth stating: firewalld hosts usually have Docker's own
  zone/direct rules, so "the port is in no zone" does not mean it is closed.
  Where we cannot prove either way, we report `FIREWALL_STATE_UNKNOWN` (INFO)
  rather than a false FIREWALLED.
- **`DOCKER_FIREWALL_BYPASS` also fires from NAT-only evidence.** A listener
  with `"source": "nat"` (§4 — a Docker `userland-proxy=false` publish with no
  host listener and no `docker-proxy` process) is subject to exactly the same
  bypass check as a `docker-proxy` row: if the host firewall would have
  denied the port (an explicit DENY, or an active default-deny with no
  matching rule) the finding still fires, because that traffic is DNAT'd
  before the firewall's `INPUT` chain ever sees it either way. This was the
  actual gap closed by the NAT-table read — previously these ports produced
  no evidence at all, so `DOCKER_FIREWALL_BYPASS`, the highest-value finding
  in the feature, silently never fired for them.

Severity may be lowered (never silently) by the org's expected-public list:
a port on that list becomes `EXPECTED_PUBLIC` (INFO) with the rule that matched
shown in the UI.

---

## 6. Alerting flow

Not a hard-coded "notify admins". Findings route through org-defined rules.

```prisma
model PostureAlertRule {
  id          String   @id @default(cuid())
  orgId       String   @map("org_id")
  name        String
  isActive    Boolean  @default(true) @map("is_active")
  // Match
  severities  String[]                        // [] = any
  codes       String[]                        // [] = any finding code
  customerIds String[] @map("customer_ids")   // [] = any customer
  environments String[]                       // [] = any (dev/staging/prod/demo)
  // Route
  recipientRoles   String[] @map("recipient_roles")     // role keys or base tiers
  recipientGroupId String?  @map("recipient_group_id")
  recipientUserIds String[] @map("recipient_user_ids")
  channels    String[]                        // inapp | email
  // Behaviour
  mode        String   @default("immediate")  // immediate | digest
  throttleMinutes Int  @default(0)            // per finding, 0 = no extra throttle
  escalateAfterHours Int? @map("escalate_after_hours")
  escalateToGroupId  String? @map("escalate_to_group_id")
  @@index([orgId, isActive])
}
```

**Events that can notify:** finding opened, finding severity increased,
finding reopened, finding still open at escalation time, finding resolved
(resolution notices are opt-in per rule, off by default).

**Rules that keep it from becoming noise:**
1. Transitions notify, scans do not. A finding that persists across 300 scans
   is one notification.
2. A muted finding notifies nobody, including escalations.
3. Recipients are intersected with customer scope — a scoped user is never
   alerted about a customer they cannot see. This also means a rule cannot be
   used to leak the existence of out-of-scope servers.
4. `digest` mode batches into one daily message per recipient.
5. Acknowledging a finding stops its escalation clock without resolving it.

**Seeded default rule** (so a fresh org is useful but quiet): *"Critical
exposure"* — severities `[CRITICAL]`, any code, any customer, recipients
`roles: [admin, super_admin]`, channels `[inapp, email]`, immediate, no
escalation. Editable and deletable like any other rule.

Routing reuses `resolveApprovers`-style union logic from
`accessRequestService` (roles + group + explicit users) so there is one mental
model for "who gets told" across the product.

---

## 7. Permissions

| Key | Default tier | Gates |
|---|---|---|
| `posture.read` | member | Posture page, server Posture tab |
| `posture.mute` | manager | Mute/unmute, acknowledge |
| `posture.settings` | admin | Retention, collector interval, expected-public list, alert rules |

Added with a new `since`; `syncSystemRoles()` back-fills by tier on boot.
Never gated on role names.

---

## 8. UI

**Top-level "Posture"** — findings inbox: severity filter, customer/environment
filter, open/muted/resolved tabs, grouped by server. Each row states the
finding, the owner (`docker/pg-main`), and the fix. Bulk mute with a reason.

**Server detail → Posture tab** — that host's listeners table (proto, port,
bind, reachability, service, owner, source path), firewall state, running
services, resource sparklines, and its open findings.

**Design rules for both** (non-negotiable, this is where new features usually
drift): existing shadcn primitives only; Tailwind utilities, no inline styles;
Lucide icons; the severity tones must reuse the existing badge `tone` values
rather than introducing a new colour vocabulary; tables use the existing
`DataTable`; on phones they become `MobileCard` lists with the same
`MobileDataList` options (accent, corner, group) the rest of the app uses;
sparklines are SVG, no chart library, matching the existing metric cards.

---

## 9. Edge cases to handle explicitly

The ones that will otherwise surface as bugs or as false confidence:

1. **A host that stops reporting.** Findings must not silently "resolve"
   because the collector died. Stale snapshot ⇒ findings hold their state and
   the server is flagged `POSTURE_STALE`.
2. **Server deleted / terminated** — cascade posture rows, and never resurrect
   them from a late snapshot.
3. **Server moved to another customer** — findings follow the server; alert
   routing re-evaluates against the new customer on the next transition.
4. **Cloud SG join with no SG** (on-prem hosts) — labelled "host-only view",
   not silently "less exposed" (design doc §6).
5. **IPv6-only listeners and asymmetric v4/v6 firewall policy** — v1 collapses
   ufw's `(v6)` suffix; where v4 and v6 policy differ we report
   `FIREWALL_STATE_UNKNOWN` instead of the v4 answer.
6. **Docker with `userland-proxy=false`** — the whole reason for the second
   collection source; there is no host listener at all, only a DNAT rule.
7. **Rootless Docker / Podman / `systemctl --user`** — reported per owning unix
   user; uninspectable containers appear as `runtime:<id>`, never dropped.
8. **pm2 under a non-default `PM2_HOME`** — recorded, because `pm2 restart 3`
   is ambiguous without it.
9. **Port reused by a different service between scans** — the finding is keyed
   `(server, code, proto, port)`; a changed owner closes the old finding and
   opens a new one rather than mutating in place.
10. **Two servers behind one IP / NAT** — findings are per server row, never
    deduplicated by address.
11. **Agent clock skew** — §3.
12. **A compromised host sending crafted payloads** — caps at ingest, escaping
    at render, and the raw payload is never rendered as HTML.
13. **Very large fleets** — the findings inbox paginates server-side; the
    fleet page must never load every listener row.
14. **An org with posture disabled** — no collector installed, no empty tabs:
    the UI shows the enablement path instead of zeroes.
15. **Scoped users** — every query filtered; alert routing intersected (§6).

---

## 10. Build order

| Step | Contents |
|---|---|
| 1 | Schema + migration + permissions + `PostureSettings` defaults |
| 2 | Ingest endpoint + `postureService.ingest` + finding computation + tests |
| 3 | Collector packaging: systemd unit/timer, sudoers drop-in, bootstrap + `--upgrade` integration |
| 4 | Read APIs (fleet findings, per-server posture) with scope filtering |
| 5 | UI: Posture page + server tab (desktop and mobile) |
| 6 | ~~Cloud SG join (phase 2)~~ — **deferred, not built.** It depends on cloud connectors syncing security groups, and no connector layer exists in this repo (no `CloudConnector` model, no `src/providers/`, no EC2/Compute SDKs — `Server.cloudProvider`/`cloudInstanceId` are populated by bulk import only). Doing it means first building encrypted per-provider credentials, region enumeration, a sync job and connector CRUD/UI: a feature in its own right, to be specced separately. Until then the Posture page states plainly that it is a host-only view (§9.4). |
| 7 | Drift + alert rules + notification routing (phase 3) |
| 8 | Resource gauges + pruning job (phase 4) |
| 9 | Retention settings UI + expected-public list |
