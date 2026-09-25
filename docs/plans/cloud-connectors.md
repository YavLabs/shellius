# Cloud connectors — AWS, Azure, GCP

What it would actually take to build the thing the README calls "parked".

## Where the code stands today

Less than nothing and more than nothing.

`Server` already carries `cloudProvider`, `cloudInstanceId` (unique),
`cloudRegion` and `cloudAccountId`. They are settable — `importService` maps
them from CSV — and they are used: `serverService` exposes `isCloud`, the
Servers page can group and filter by provider. So the *inventory* half of the
model exists and is wired through the UI.

What does not exist is everything that makes it a connector: no
`CloudConnector` model, no `backend/src/providers/`, no compute SDKs in
`package.json`, no sync, no credential storage. Today a cloud server is one
somebody typed in, or imported from a CSV, and said was a cloud server.

Two patterns in the repo are the right shape to copy, and copying them is most
of the design work:

- **`services/directory/`** — `directorySyncService.js` plus
  `adapters/{entra,google,okta,github}.js` with a shared `http.js` and
  `externalId.js`. A provider-agnostic engine with a thin adapter per vendor,
  an injectable client for tests, and `DirectorySync` / `DirectorySyncRun` /
  `DirectorySyncFinding` models. **This is the template.** Cloud discovery is
  the same problem with different nouns: reconcile an external system's list
  against ours, on a schedule, without destroying anything on a bad day.
- **`AuditSink`** — encrypted config blob, `isActive`, last-test result,
  `consecutiveFailures` / `backoffUntil` / `disabledReason`. The health and
  auto-disable rules are already proven there.

## The honest framing

**Discovery gives you inventory, not access.**

This is the single most important expectation to set, internally and in the
docs. Finding an EC2 instance does not make it connectable. It still needs
either the bootstrap agent (for certificate access) or a Keystore identity.
A connector turns "we have 400 instances somewhere" into "we have 400 rows,
380 of which nobody can log into through Shellius."

Auto-bootstrapping discovered hosts is a *second, larger* feature needing SSM
Run Command / Azure Run Command / GCP startup scripts, each of which is a much
higher privilege grant than read-only discovery. It should not be bundled in.

## What has to be built

### 1. Model

```prisma
model CloudConnector {
  id                  String    @id @default(cuid())
  orgId               String
  provider            String    // aws | azure | gcp
  name                String
  credentialsEncrypted String   // utils/crypto.js, like every other secret
  authMode            String    // role_assumption | static | workload_identity
  regions             String[]  // [] = every region the provider lists
  accountIdentifier   String?   // account id / subscription id / project id
  // Deny by default — see "Customer mapping" below. NOT the [] = all
  // convention used elsewhere.
  defaultCustomerId   String?
  tagMappings         Json?     // tag key -> customer / environment rules
  isActive            Boolean   @default(true)
  syncIntervalMinutes Int       @default(60)
  lastSyncAt          DateTime?
  lastSyncStatus      String?
  consecutiveFailures Int       @default(0)
  backoffUntil        DateTime?
  disabledReason      String?
  createdById         String?
  @@unique([orgId, provider, accountIdentifier])
}

model CloudSyncRun    { connectorId, startedAt, finishedAt, status, discovered,
                        created, updated, deactivated, skipped, error }
model CloudSyncFinding { runId, instanceId, action, reason }  // why a row was skipped
```

`CloudSyncFinding` matters more than it looks. "Why did my instance not appear?"
is the support question this feature generates, and without a per-instance
record the answer is a log grep.

### 2. Credentials, per provider

This is where self-hosting bites, and where the security review will focus.

| Provider | Preferred | Fallback | SDK |
|---|---|---|---|
| AWS | `AssumeRole` with an **ExternalId**, or the instance's own role (IRSA / instance profile) | static access key pair | `@aws-sdk/client-ec2`, `@aws-sdk/client-sts` |
| Azure | Managed Identity | service principal (tenant + client id + secret) | `@azure/arm-compute`, `@azure/identity` |
| GCP | Workload Identity Federation | service account JSON key | `@google-cloud/compute` |

Every stored credential is encrypted at rest with `utils/crypto.js` — CLAUDE.md
already names cloud connector credentials specifically — never returned by
list/get, never logged. The SDK style is familiar: `@aws-sdk/client-s3` and
`@azure/storage-blob` are already dependencies for recordings.

**Push customers hard towards role assumption.** A static AWS key pair in a
self-hosted database is a credential that outlives the person who created it
and that nobody rotates. ExternalId is what stops the confused-deputy problem
if you ever run a hosted version.

Ship the exact least-privilege policy for each provider in the docs:
`ec2:DescribeInstances` + `ec2:DescribeTags`; Azure `Reader` on the
subscription; GCP `compute.viewer`. Anything broader should be refused in
review.

### 3. Permissions

New catalogue keys in `config/permissions.js`: `cloud.view`, `cloud.manage`,
`cloud.sync`.

`cloud.manage` should be **sensitive and non-delegable**, defaulting to super
admin, like `settings.sso` — a connector holds cloud credentials and creates
inventory rows.

One consequence to decide deliberately: `apiTokenAuth.effectivePermissions()`
strips non-delegable permissions from **every** API token, including service
accounts. So a non-delegable `cloud.manage` means no machine client can ever
create or edit a connector. That is probably right for `manage`; it is probably
wrong for `sync`, which a CI job might reasonably trigger. Split them.

### 4. The sync engine

A BullMQ repeatable job per connector plus a manual "sync now", following
`jobs/directorySync.js`.

Per provider, the paging is the work: AWS `DescribeInstances` is paginated
**per region** and the region list itself must be enumerated; Azure lists VMs
per subscription and needs a second call for network interfaces to get IPs at
all; GCP `aggregatedList` returns every zone in one paginated call.

Things that will go wrong and need handling up front:

- **Partial region failure.** One region throttles or denies; the others
  succeed. The run must record what it *could not see* and must never treat
  an unseen region as an empty one.
- **Rate limits.** Exponential backoff honouring `Retry-After`, reusing the
  classifier from `audit/sinks/webhook.js`.
- **Credential expiry / rotation.** Assumed-role credentials are short-lived
  by design; a sync must refresh rather than cache to failure.
- **Clock skew** breaks AWS SigV4 signing specifically. Worth a named error.

### 5. Reconciliation — the part that can destroy data

When an instance vanishes from the API, there are at least five reasons and
only one of them is "it was terminated": the call failed, permissions were
narrowed, the region was removed from the connector, a tag filter changed, or
the account moved.

Rules, and they are not negotiable:

- **Never hard-delete.** CLAUDE.md says so, and the reason is in the schema:
  `Session.serverId` is `onDelete: Cascade`, so deleting a Server destroys its
  session history and orphans its recordings. A disappeared instance is marked
  inactive with a reason, and removal stays a human action.
- **Blast-radius guard.** If a sync would deactivate more than some fraction of
  a connector's servers (start at 20%), it stops and asks. A credential whose
  permissions were narrowed overnight otherwise deactivates an entire estate
  quietly. The bulk-bootstrap cap is the precedent.
- **Match on `cloudInstanceId` only.** It is already unique. Matching on
  hostname or IP invites adopting an unrelated hand-created server, and cloud
  IPs are reused. A hand-created server that *is* the same machine should be
  adopted explicitly by a person, once, not guessed at every hour.
- **Dynamic IPs.** Instances change IP on stop/start; the `dynamicIp` column
  exists for this. Sync updates the address; it must not treat a changed
  address as a new machine.

### 6. Customer mapping, and the tenancy trap

Every `Server` belongs to a `Customer`. A discovered instance belongs to
nothing.

Defaulting unmapped instances into some customer is a tenancy break in an MSP
org: everyone scoped to that customer suddenly sees another client's hosts.
So unmapped instances land in an **unassigned queue** and are not visible as
inventory until someone maps them. Deny by default, not `[] = all`.

Mapping rules run tag-first (`Customer=acme` → that customer, `Env=prod` →
`environment: prod`), then the connector's default, then the queue.

Environment mapping deserves care of its own: a mis-tagged instance landing in
`dev` instead of `prod` silently removes the approval requirement for it. Tag
values should map through an explicit table, never by string equality with the
enum, and an unrecognised value must mean "unassigned", never "dev".

### 7. UI

- **Administration → Cloud connectors**: list with health, add/edit per
  provider, "Test connection", "Sync now", run history, findings.
- **Unassigned queue**: map to customer/environment, or dismiss.
- **Servers**: a "discovered" badge, and sync-owned fields made read-only so a
  hand edit is not silently overwritten an hour later.

The Servers page already groups and filters by `cloudProvider`, so that part is
free.

### 8. Self-hosting specifics

You asked about this in particular:

- **Nothing phones home.** Credentials live in the customer's own database,
  encrypted with their `ENCRYPTION_KEY`. Lose that key and connectors break
  along with every other secret — the existing failure mode, not a new one.
- **Egress required.** The instance must reach the provider's API endpoints on
  443. An air-gapped install cannot use this feature at all, and should be told
  so rather than left to discover it.
- **Their credentials, their blast radius.** The least-privilege policies must
  be in the docs as copy-pasteable JSON, because whatever is easiest to paste
  is what will be used — and the easiest thing to paste is `ReadOnlyAccess`.
- **Rate limits are per *their* account**, shared with everything else they
  run. A 5-minute interval across a large estate will throttle their own
  tooling. Default to 60 minutes and make the cost visible in the UI.
- **Custom endpoints** (LocalStack, Azure Stack, private service connect) mean
  a user-supplied URL, which means `utils/ssrf.js` `guardSsrf()` applies.

## Sequencing

| PR | Scope | Size |
|---|---|---|
| 1 | Model, migration, permissions, encrypted CRUD, "test connection" — **AWS only** | M |
| 2 | Sync engine, reconciliation rules, blast-radius guard, job, audit | L |
| 3 | Mapping rules, unassigned queue, UI | M |
| 4 | Azure adapter | M |
| 5 | GCP adapter | M |
| 6 | Docs, least-privilege policies, release | S |

One provider end to end before the other two. The adapter boundary is only
proven once a second provider is forced through it, but designing for three
before shipping one is how you get an abstraction that fits none of them.

## What I would not build

- **Auto-bootstrap of discovered hosts.** Separate feature, much higher
  privilege, needs its own review.
- **Cost or utilisation data.** Not an access-management concern.
- **Writing to the cloud** — no start/stop/terminate. Read-only discovery keeps
  the credential read-only, which is most of the security argument for letting
  this exist at all.
