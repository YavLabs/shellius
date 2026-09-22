# Audit Export, Sinks and Retention

Until 2.0 the audit log lived in Postgres and nowhere else. There was a manual
CSV export and a `TODO` for an archive job. "Can we get this into our SIEM?"
was a no.

2.0 adds four destinations behind one adapter registry, plus retention and
archiving.

| Sink | Delivery | Good for |
|---|---|---|
| `webhook` | batched JSON POST, HMAC-signed | Splunk HEC, Datadog, Panther, Tines, a script someone wrote |
| `s3` | gzipped NDJSON object per batch | a compliance bucket, Athena, long-term retention |
| `syslog` | RFC 5424 over TCP+TLS | an existing on-prem collector |
| `email_digest` | scheduled summary with CSV | the people who want a daily read, not a pipeline |

## Reading the log in order

The UI's `list()` is offset-paginated, which is right for jump-to-page and
wrong for streaming. Sinks use a keyset reader instead
(`auditService.stream`), walking `(createdAt, id)` ascending. That pair is a
**total order** because `id` is unique — `id` is a tiebreak within the same
millisecond, not a clock. (cuid is not time-sortable; nothing here assumes it
is.)

Two details that are easy to get wrong:

**The read head lags five seconds** (`READ_LAG_MS`). `created_at` is assigned
at INSERT but becomes visible at COMMIT, so a reader that walks right up to
"now" will step over rows whose timestamps it has already passed. The sink is
therefore always a few seconds behind live, deliberately, and the UI says so
rather than letting it read as a fault.

A `BIGSERIAL` sequence column was considered and rejected: sequence values are
also drawn at INSERT, so it has exactly the same hole, plus a backfill.

**Delivery is at-least-once.** The cursor advances only after the adapter
returns, inside the same transaction that records the delivery. A crash or a
failed batch replays rather than skips. Duplicates are the correct outcome and
every record carries its immutable `id` for deduplication; the webhook sink
also sends a stable batch id as an idempotency key, and the S3 sink derives
its object key from that id so a retry overwrites instead of doubling up.

If you must choose, losing an audit entry is worse than seeing one twice.
This chooses.

## The envelope

Every record leaves as a versioned envelope
(`backend/src/services/audit/envelope.js`), not a raw row: `ENVELOPE_VERSION`,
the action, actor, resource, IP, user agent, a derived severity, and metadata
re-scrubbed through `redactValue` on the way out. Re-scrubbing is deliberate —
the log is already scrubbed on the way in, but a sink sends data to a third
party and that is the wrong place to rely on a single layer.

## Per-sink notes

**Webhook.** Signed `X-Shellius-Signature: t=<unix>,v1=<hex>`, an HMAC over
`<t>.<body>` — the convention Stripe popularised, because it is the one
receivers already have code for. The timestamp is inside the signed material,
so an old valid body cannot be replayed later. Private-network destinations
are blocked by an SSRF guard unless `AUDIT_WEBHOOK_ALLOW_PRIVATE=true`; an
on-prem SIEM is a legitimate target, but it has to be a deliberate choice
rather than a way to make Shellius probe its own network.

**Syslog.** RFC 5424 with octet-counted framing (RFC 6587) — a **byte** count,
not a character count. That distinction is the whole reason to use octet
counting: a message containing multi-byte UTF-8 has more bytes than
characters, and a collector that trusts the wrong number desynchronises.

Honest limitation: **a TCP write is not an acknowledgement.** The sink cannot
know the collector persisted anything. It advances only after a batch drains
cleanly, and a mid-batch failure replays the batch — duplicates at the
collector rather than gaps. The UI says this where someone configuring it will
read it.

**S3.** Uses the install's storage credentials, not per-org ones, because
`storageConfigService` is deliberately a global singleton. A sink chooses the
bucket and prefix, not the credentials. An org that needs its own credentials
should use a webhook; the UI says so.

Key: `<prefix>/org=<orgId>/dt=<YYYY-MM-DD>/<stamp>_<batchId>.ndjson.gz`.

**Email digest.** Scheduled, not streamed, so it has no cursor and does not
hold retention back.

## Failure handling

Failures back off exponentially and a sink auto-disables after
`MAX_CONSECUTIVE_FAILURES` (10) with an in-app notification, so a dead
endpoint cannot spin forever. Auto-disabling is audited as its own action
(`audit_sink.disabled`) rather than a field on an update: an audit pipeline
that has quietly died is worse than one that is loudly broken.

Each sink's delivery history is visible in the UI, including the failures.

## Retention

Nothing in Shellius updates or deletes an `AuditLog` row except
`retentionService`. Three rules, in order:

1. **Nothing is deleted unless a retention period is set.** The default is to
   keep everything forever.
2. **Nothing is deleted past what an active sink still owes.** An active
   streaming sink's cursor is a hard floor.
3. **Nothing is deleted without an archive**, unless someone has explicitly
   asked for that (`deleteWithoutArchive`). The archive is written and
   verified first; an archive failure stops the deletion rather than bypassing
   it.

Rule 2 deserves the emphasis. Retention and sinks are configured on different
screens, often by different people. A short retention plus a stalled sink
would destroy entries that reached neither place. The API reports the floor
(`heldBySinkUntil`), so "why has nothing been deleted?" is answerable without
reading the code.

Minimum retention is 7 days. Archives are day-at-a-time gzipped NDJSON with a
SHA-256 receipt, optionally encrypted — though note that an archive a SIEM
cannot read defeats much of the point; bucket SSE is usually the better
answer.

## Operations

- `backend/src/jobs/auditExport.js` — every 30s, per-sink Redis lock, fails
  open (a duplicate is better than a stall).
- `backend/src/jobs/auditArchive.js` — daily; also prunes delivery records
  older than 30 days.
- Indexes: `(org_id, created_at, id)` for the keyset walk, plus
  `(org_id, action)` and `(org_id, resource_type)` for filtered sinks.
  **On a large `audit_logs` table**, create these by hand with
  `CREATE INDEX CONCURRENTLY` and then
  `npx prisma migrate resolve --applied 20261002000000_audit_read_indexes` —
  Prisma runs each migration in one transaction, so `CONCURRENTLY` cannot be
  used inside it, and the migration would otherwise hold a write lock.
- Permissions: `audit.sinks` and `audit.retention`, both super-admin by
  default and both non-delegable — an API token must never be able to point
  the audit trail somewhere else or switch it off.

## Related

- `backend/src/services/audit/` — the reader, envelope, adapters and services
- `docs/directory-sync.md` — the other 2.0 compliance feature
