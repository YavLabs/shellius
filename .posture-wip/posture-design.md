# Shellius Posture — design notes

**Status:** draft / WIP. Not committed to the product.
**Last updated:** 2026-09-20

---

## 1. The decision

Shellius extends into **exposure posture**, not into monitoring.

The distinction matters because it decides what we own. Shellius already
answers *"who may reach this host, and is that still authorized."* Posture adds
the network-layer half of the same question: *"what does this host expose, to
whom, and does anyone know why."* That is the same product, one layer down —
same buyer, same audit, same RBAC, same `org_id` scoping.

Metrics-as-time-series and centralized logging are a different product with a
different cost structure (unbounded write volume, retention, downsampling,
cardinality). We do not build a TSDB or a log store.

### In scope

| Capability | Why it fits |
|---|---|
| Listening ports + owning service | The core differentiator. See §3. |
| Firewall rules (ufw/nftables) | Needed to turn "a port is open" into "reachable". |
| Cloud security groups | Already synced by the cloud connectors. Completes the join. |
| Running services (docker / pm2 / systemd) | Falls out of port attribution for free. |
| Drift over time | "This port appeared yesterday" — a diff of two snapshots. |
| Resource gauges (CPU/mem/disk, ~24h) | Cheap, answers "is this box hot". Not a TSDB. |

### Out of scope

| Capability | Instead |
|---|---|
| Metrics time series | Shellius *deploys and governs* node_exporter; dashboards query your Prometheus. |
| Centralized logging | Shellius *deploys and governs* promtail/vector; we never store a log line. |
| APM / tracing | Not our problem. |

The pattern for both: **be the control plane for telemetry, not the sink.** The
agent is already on every host with a privileged install path, so "Shellius set
up your observability stack and tracks its health across the fleet" is real
value that costs us a job processor, not a storage tier.

### Naming

Call the feature **Posture** or **Exposure** in the UI. Never "Monitoring" —
that sets a Datadog-shaped expectation we are deliberately not meeting, and it
dilutes the security positioning that makes the feature coherent in the first
place.

---

## 2. Why this is defensible

Everyone can list open ports. `ss -tulpn` is free. The value is in the join
nobody does end to end:

```
             listening socket
                    │
                    ├── owning process ──── container / pm2 app / systemd unit
                    │
                    ├── host firewall ───── ufw / nftables rule for that port
                    │
                    └── cloud SG ────────── AWS/Azure/GCP ingress rule
                                            (already in our DB via connectors)
```

A port is only *reachable* when all three layers agree, and the layers are
normally owned by three different people looking at three different screens.
Shellius already holds the cloud half and already has an agent on the host for
the other two. Nothing else in our price bracket closes that loop.

The finding that sells the feature on its own is §3.3.

---

## 3. The attribution logic

Implemented and working in `shellius-posture-scan.sh`. This section is the
specification; the script is the reference implementation.

### 3.1 Finding the listeners

Two sources, because neither alone is complete:

1. **`ss -H -tulpn`** — every socket the kernel shows, with pid.
2. **`docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}'`**

Source 2 is not redundant. With `userland-proxy=false` there is **no host
listener and no `docker-proxy` process** — the port is served purely by a
`nat/PREROUTING` DNAT rule. `ss` shows nothing at all, yet the port is fully
reachable from the internet. Those are exactly the ports that end up exposed,
because every naive "check open ports" script misses them.

Rows are deduplicated per `proto:bind:port`, preferring the richest source
(Docker row > host-network container > plain process > unattributed), since a
published port legitimately appears in both sources.

### 3.2 Resolving the owner

All from `/proc`, no daemon interrogation except a cached `docker inspect`:

```
/proc/<pid>/cgroup
  ├─ 64-hex id                    → docker / podman / containerd
  │                                 under user@<uid>.service? → rootless
  ├─ <unit>.service|scope         → systemd
  │                                 under user@<uid>.service? → systemd-user
  └─ (k8s pod paths land in the container branch via the id)

/proc/<pid>/environ               → pm_id present? → pm2
  └─ name=, pm_exec_path=, pm_cwd=, PM2_HOME=

fallback: /proc/<pid>/{exe,cmdline,cwd}, parent cmdline matching "God Daemon"
```

**Multi-user is the default assumption, not an edge case.** On a shared box the
processes behind a port routinely belong to someone other than root: each
user's pm2 daemon has its own `PM2_HOME` and its own id space, rootless Docker
and Podman run under the user's own daemon (invisible to `docker inspect` as
root), and `systemctl --user` units live under `user@<uid>.service`. So the
collector:

- records the owning unix user for every listener and reports exposure grouped
  by user, because on a shared host "whose is it" is the question after "what
  is it";
- retries container inspection as the owning user
  (`sudo -n -u <user> XDG_RUNTIME_DIR=/run/user/<uid> …`) before giving up;
- reports a container it cannot inspect as `runtime:<short-id>` rather than
  silently dropping it;
- notes a non-default `PM2_HOME`, since `pm2 restart 3` is ambiguous without it.

This is the reason the script refuses to run without root: all of the above
reads another user's `/proc` entries, and unprivileged the report looks clean
while being blind.

### 3.2b Where it came from

Each listener also carries a **source path** — the thing you need in order to
change it:

| Owner | Source |
|---|---|
| docker / podman | `com.docker.compose.project.config_files`, else the project working dir |
| pm2 | `pm_cwd` from the process environment |
| systemd | `systemctl show -p FragmentPath` (`--user` for user units) |
| anything else | `/proc/<pid>/cwd` |

The pm2 case is worth calling out: **pm2 processes show up as `node` in `ss`**,
which is why "which pm2 app owns port 3001" is normally unanswerable. Reading
`pm_id`/`name` out of the child's environment block resolves it exactly, with
no dependency on `pm2 jlist`, no JSON parsing, and no jq. Falling back to the
God Daemon parent check covers processes whose env was stripped.

`docker-proxy` is special-cased: it is a shim, so its `-container-ip` /
`-container-port` args are parsed to point at the real owner rather than
reporting `docker-proxy` as the service.

### 3.3 The reachability verdict

```
bind is 127.0.0.1 / ::1                        → LOOPBACK
published by Docker (proxy or DNAT), non-local → INTERNET   [see below]
bind is RFC1918 / link-local                   → LAN
wildcard or specific public bind:
    ufw ALLOW for the port                     → INTERNET
    ufw DENY  for the port                     → FIREWALLED
    ufw active and default incoming = deny     → FIREWALLED
    otherwise                                  → INTERNET
```

**The Docker branch is the whole point.** Docker's published-port traffic is
DNAT'd in `nat/PREROUTING` and then traverses `FORWARD` (the `DOCKER` chain).
ufw's rules live in `INPUT` (`ufw-user-input`). They are different chains, so:

> `ufw deny 5432` does **not** protect `docker run -p 5432:5432`.
> The rule is present, the admin believes the port is closed, and it is open
> to the internet.

When we see a Docker publish on a non-loopback bind **and** a ufw rule that
would have denied it, we raise `DOCKER_FIREWALL_BYPASS` at CRITICAL. That
single finding is the most valuable thing in this feature — it is silent, it is
extremely common, and no dashboard the customer already owns shows it.

### 3.4 Identifying the service

Port numbers are remapped constantly (5433 for Postgres, 6380 for Redis), so a
port-number lookup alone misses most real deployments. Evidence in order:

1. **Container port** — `0.0.0.0:5433->5432/tcp` means Postgres regardless of 5433
2. Host port against the known-ports table
3. Image name (`postgres:16-alpine`, `redis:7-alpine`, …)
4. Container / unit / pm2 app name
5. Process name (`postgres`, `redis-server`, `mongod`)

This is why scenario 2 in the harness passes: a Postgres on 5433 is reported as
PostgreSQL and escalated to CRITICAL, where a port-table scanner would have
shrugged and called it "unknown service on a high port".

### 3.5 Finding taxonomy

| Code | Sev | Fires when |
|---|---|---|
| `DOCKER_FIREWALL_BYPASS` | CRITICAL | Docker publish is reachable despite a firewall rule that appears to cover it |
| `SENSITIVE_PORT_EXPOSED` | CRITICAL | A known datastore/admin service is reachable from any source |
| `PORT_EXPOSED` | HIGH | Reachable from anywhere and not a known-public service |
| `NO_HOST_FIREWALL` | HIGH | No firewall engine detected |
| `FIREWALL_INACTIVE` | HIGH | ufw installed but `Status: inactive` |
| `SENSITIVE_PORT_WILDCARD_BIND` | MEDIUM | Datastore binds `0.0.0.0`, saved only by a firewall rule — one `ufw disable` from an incident |
| `SENSITIVE_PORT_LAN` | LOW | Datastore reachable from the local network |
| `STALE_FIREWALL_RULE` | LOW | ufw allows a port nothing listens on |
| `UNATTRIBUTED_LISTENER` | LOW | Could not tie the listener to a container/app/unit |
| `EXPECTED_PUBLIC` | INFO | 22/80/443 — public by design |

MEDIUM vs CRITICAL in rows 1 and 6 is the credibility line. A correctly
firewalled Postgres is *not* an incident, and reporting it as one is how a
posture tool trains its users to ignore it. It is fragile, and we say exactly
that.

---

## 4. Worked examples

### 4.1 The footgun (harness scenario 1)

Host: ufw active, default deny, `ufw deny 5432` explicitly set. Admin believes
Postgres is closed.

```
PROTO PORT   BIND             REACH       SERVICE        OWNER
tcp   22     0.0.0.0          INTERNET                   systemd/ssh.service
tcp   5432   0.0.0.0          INTERNET    PostgreSQL     docker/pg-main postgres:16-alpine

CRITICAL  tcp/5432   DOCKER_FIREWALL_BYPASS
          PostgreSQL — Docker publishes this port; the DNAT rule bypasses the
          ufw INPUT chain, so the firewall rule covering it is NOT enforced.
          Bind to 127.0.0.1 or install ufw-docker.
          owner: docker/pg-main
INFO      tcp/22     EXPECTED_PUBLIC   SSH — public exposure is expected here.
```

### 4.2 The pm2 question

The original motivating case — "which pm2 process is exposing which port":

```
PROTO PORT   BIND             REACH       SERVICE        OWNER
tcp   3001   0.0.0.0          INTERNET                   pm2/billing-worker
tcp   3002   127.0.0.1        LOOPBACK                   pm2/notifications-api
```

`ss` alone reports both of these as `node`. The `pm_id` env lookup is what
turns them into app names.

### 4.3 Remapped ports (harness scenario 2)

```
tcp   5433   0.0.0.0          INTERNET    PostgreSQL     docker/db →:5432
tcp   6380   0.0.0.0          INTERNET    Redis          docker/cache →:6379
```

Both CRITICAL. A port-table scanner reports neither.

---

## 5. Build plan

### Phase 1 — snapshot + inventory (the foundation)

Agent collects a posture snapshot every 5 min on its own systemd timer and
POSTs it to a new endpoint. UI shows, per server: listeners, owners, firewall
state, running services.

**Hard constraint: a separate systemd unit from `check-principals`.** Today a
broken agent costs a heartbeat. After this, a crashing collector must never be
able to break SSH authentication on a prod box. Separate unit, separate
failure domain, collector failure is reported and otherwise inert.

Backend:
- `POST /api/hosts/posture` — new route, `agentAuth`, identity from the
  per-host token exactly as `routes/hosts.js` does today. The body's
  `serverId`/`orgId` are ignored in per-host-token mode, same rule.
- Joi schema with hard size caps. **The snapshot is attacker-controlled input
  from a host that may be compromised, rendered in our UI.** Cap the array
  lengths, cap every string, reject the request rather than truncating.
- `postureService.ingest()` — diff against the previous snapshot, write
  findings, emit drift events.

Schema sketch:

```prisma
model HostSnapshot {
  id           String   @id @default(cuid())
  orgId        String   @map("org_id")
  serverId     String   @map("server_id")
  collectedAt  DateTime @map("collected_at")
  agentVersion String?  @map("agent_version")
  firewall     Json     // { engine, active, defaultIncoming }
  raw          Json     // full payload, retained N days then pruned
  @@index([orgId, serverId, collectedAt])
}

model HostListener {
  id           String  @id @default(cuid())
  orgId        String  @map("org_id")
  serverId     String  @map("server_id")
  snapshotId   String  @map("snapshot_id")
  proto        String
  bind         String
  port         Int
  containerPort Int?   @map("container_port")
  bindClass    String  @map("bind_class")     // wildcard|loopback|private|specific
  reachability String                          // INTERNET|FIREWALLED|LAN|LOOPBACK
  service      String?                         // PostgreSQL, Redis, ...
  ownerKind    String  @map("owner_kind")      // docker|pm2|systemd|process|unknown
  ownerName    String  @map("owner_name")
  ownerDetail  String? @map("owner_detail")    // image / exec path
  ownerId      String? @map("owner_id")        // container id / pm2 id / unit
  ownerUser    String? @map("owner_user")      // owning unix user
  sourcePath   String? @map("source_path")     // compose file / unit file / cwd
  pid          Int?
  @@index([orgId, serverId])
  @@index([orgId, reachability])
}

model ExposureFinding {
  id          String    @id @default(cuid())
  orgId       String    @map("org_id")
  serverId    String    @map("server_id")
  code        String                            // DOCKER_FIREWALL_BYPASS, ...
  severity    String
  proto       String?
  port        Int?
  ownerLabel  String?   @map("owner_label")
  message     String
  firstSeenAt DateTime  @map("first_seen_at")
  lastSeenAt  DateTime  @map("last_seen_at")
  resolvedAt  DateTime? @map("resolved_at")
  mutedUntil  DateTime? @map("muted_until")
  mutedReason String?   @map("muted_reason")
  @@unique([orgId, serverId, code, proto, port])
  @@index([orgId, severity, resolvedAt])
}
```

`firstSeenAt`/`resolvedAt` rather than a row per scan: a finding is a
long-lived object that opens and closes, not an event stream. That is what
makes "open since 14 days" and "resolved by whom" possible without a TSDB.

Permissions (`config/permissions.js`, new `since`):
`posture.read`, `posture.mute`, `posture.settings`. `syncSystemRoles()` grants
by base tier on boot, per the existing convention. Never gate on role names.

### Phase 2 — the cloud SG join

Correlate `HostListener` against the security groups the cloud connectors
already sync. Upgrades `PORT_EXPOSED` from "reachable per the host" to
"reachable from `0.0.0.0/0` per the SG", and adds the inverse finding — an SG
opening a port no host in the group listens on.

This is where the feature stops being a better `ss` and starts being something
the customer cannot assemble themselves.

### Phase 3 — drift + notifications

Diff consecutive snapshots: new listener, listener gone, firewall rule changed,
service stopped. Route through the existing `notificationService`. Audit every
posture finding transition — it is a security event and `AuditLog` is already
immutable.

Budget for the alerting tail here, honestly: thresholds → notification →
escalation → dedupe → mute/silence → on-call. `mutedUntil`/`mutedReason` are in
the schema above precisely because a posture tool with no mute is a posture
tool everyone turns off in week two.

### Phase 4 — resource gauges

CPU / mem / disk / load in the same snapshot. `HostMetricSample`, 1-min
resolution, ~24h retention, pruned by a BullMQ job alongside
`quickConnectHistoryPrune`. Sparkline on the server detail page. **Stop here.**
If someone asks for 90-day graphs, that is the signal to deploy Prometheus, not
to add retention.

### Phase 5 — telemetry control plane

Agent can install/configure node_exporter and promtail/vector. Shellius stores
the config and the rollout state, renders dashboards by querying the customer's
Prometheus/Loki. We never store a metric point or a log line.

---

## 6. Risks and open questions

**Privilege — the big one.** `check-principals` currently runs as `nobody` with
a deliberately narrow sudoers drop-in. That was a good decision and the
collector must not undo it. `ss -p`, `ufw status` and the Docker socket all
want root, and **Docker socket access is effectively root on the host** —
granting the collector the `docker` group fleet-wide is a larger privilege
expansion than anything Shellius does today. Prefer: `/proc` walking (which
needs root but not the socket) plus a narrow sudoers for named commands, same
discipline as the existing drop-in. Decide this deliberately; do not drift into
it. *Open: can we get container name/image without the socket? `/proc` gives us
the container ID; mapping ID→name currently needs `docker inspect`. Worth
testing whether reading the container's own `/proc/<pid>/environ` or
`/proc/<pid>/root/etc/hostname` is enough.*

**Payload trust.** Covered in Phase 1, repeated because it is the thing that
will get skipped: the snapshot is untrusted input. Validate hard, cap sizes,
escape on render.

**Agent lifecycle.** The agent is currently a 60s curl. Once it collects, it
needs versioning, staged rollout, rollback, and a resource cap (`MemoryMax`,
`CPUQuota` on the unit). The bootstrap script in `routes/bootstrap.js` is
already a 12-step installer, so the mechanism exists — the discipline is new.

**Noise.** Every posture product dies of false positives. The MEDIUM/CRITICAL
split in §3.5 is the first defence; per-finding mute with a reason is the
second; a per-org "expected public ports" list is probably the third.

**Non-Linux hosts.** Windows/RDP targets get nothing from this design. Fine for
v1 — say so explicitly rather than shipping a half-working Windows collector.

**Cloud SG coverage.** Only cloud-discovered servers have an SG to join
against. On-prem hosts get the two-layer join and should be labelled as such in
the UI rather than silently appearing "less exposed".

---

## 7. Known limitations of the current script

- Attribution reads `/proc/<pid>` after `ss` reports the pid. If the process
  exits in between, the owner degrades to `unknown` (correct). Pid reuse inside
  that window would mis-attribute, but the window is sub-millisecond.
  *(This is visible in the fixture harness, where synthetic pids collide with
  real ones on the test machine — a fixture artifact, not a runtime bug.)*
- nftables is detected but not parsed; only ufw rules feed the verdict. Hosts
  on raw nftables currently fall through to "no usable firewall data".
- IPv6 firewall rules are collapsed into their v4 equivalents (ufw's `(v6)`
  suffix is stripped). Fine for ufw, wrong if someone has asymmetric v4/v6
  policy.
- No cloud SG join yet — that is Phase 2, and it is the piece that turns a
  good script into a product.
- The USER column for a container is the uid its main process runs as. Without
  userns-remap that is a real host uid, but it is *not* who administers the
  container — that is whoever owns the runtime. Containers reached through the
  system daemon are therefore reported as `root`; looking the container's
  internal uid up in the host passwd file produced nonsense like MySQL's uid
  999 resolving to an unrelated local account.
- Implementation gotcha worth keeping: `resolve_owner` runs inside a process
  substitution, so anything it assigns to a global is discarded when that
  subshell exits. Per-owner facts must travel in the emitted record, not in a
  shell variable. Related: `declare -A` is load-bearing — without it bash reads
  `ARR[someuser]` as an arithmetic subscript and dies under `set -u`, which
  silently blanked every pm2 listener while the report still rendered. The
  harness now asserts stderr is empty on every scenario for exactly this
  reason.
- TAB is a whitespace IFS character, so `read -r` with `IFS=$'\t'` collapses
  runs of tabs and drops empty fields, shifting every later column. No field is
  ever written empty; everything defaults to `-`.
- Container inspection as another user needs passwordless sudo for that user
  (`sudo -n`); where that is unavailable a rootless container is reported as
  `runtime:<short-id>` with no name or image.
