/**
 * sinkService.js — audit sinks: configuration, and the delivery loop.
 *
 * Configuration follows emailProviderService exactly: one encrypted blob per
 * row, secrets masked to `{ set: true }` on the way out, a secret left alone
 * when an update omits it, and a test button whose result is stored.
 *
 * Delivery is **at-least-once**. The cursor advances only after an adapter
 * has returned, so a crash or a failure replays the last batch rather than
 * skipping it. Duplicates are the cost, and every record carries its
 * immutable id so a receiver can dedupe; the webhook sink also sends a
 * stable batch id as an idempotency key, and the S3 sink derives its object
 * key from that id so a retry overwrites instead of doubling up.
 *
 * Nothing here is allowed to throw into a caller's request path.
 */

import crypto from 'crypto';
import prisma from '../../config/db.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { encrypt, decrypt } from '../../utils/crypto.js';
import { ACTIONS, log as auditLog, stream, lagFrom, READ_LAG_MS } from '../auditService.js';
import { toEnvelope } from './envelope.js';
import { getAdapter, SINK_TYPES, STREAMING_TYPES } from './sinks/index.js';
import { SinkConfigError, PermanentSinkError } from './sinks/errors.js';
import { digestDue, periodLabel } from '../digestSchedule.js';

/** Give up after this many failures in a row and say so loudly. */
export const MAX_CONSECUTIVE_FAILURES = 10;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** Per sink, per tick — bounds how much one sink can hog a worker pass. */
export const MAX_BATCHES_PER_RUN = Number(process.env.AUDIT_SINK_MAX_BATCHES || 10);

const RESOURCE = 'AuditSink';

// ---------------------------------------------------------------------------
// Config encryption and masking
// ---------------------------------------------------------------------------

function decryptConfig(row) {
  if (!row?.configEncrypted) return {};
  try {
    return JSON.parse(decrypt(row.configEncrypted));
  } catch (err) {
    logger.error('sinkService: could not decrypt sink config', { sinkId: row.id, error: err.message });
    return {};
  }
}

const encryptConfig = (config) => encrypt(JSON.stringify(config ?? {}));

/**
 * Merge an update over the stored config, keeping any secret the caller
 * didn't resend — the same rule the email providers use, so "save" without
 * retyping a secret doesn't wipe it.
 */
export function mergeConfig(type, stored, incoming) {
  const adapter = getAdapter(type);
  const merged = { ...stored, ...(incoming || {}) };
  for (const field of adapter.secretFields) {
    const given = incoming?.[field];
    if (given === undefined || given === null || given === '') {
      if (stored?.[field] !== undefined) merged[field] = stored[field];
      else delete merged[field];
    }
  }
  return merged;
}

/** Public view: never the secrets themselves, only whether they are set. */
export function toPublic(row, config = null) {
  if (!row) return row;
  const adapter = SINK_TYPES.includes(row.type) ? getAdapter(row.type) : null;
  const cfg = config ?? decryptConfig(row);

  const publicConfig = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (adapter?.secretFields.includes(k)) continue;
    publicConfig[k] = v;
  }
  for (const k of adapter?.secretFields ?? []) {
    publicConfig[k] = { set: !!cfg[k] };
  }

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    streaming: adapter?.streaming ?? true,
    config: publicConfig,
    filters: row.filters ?? {},
    isActive: row.isActive,
    batchSize: row.batchSize,
    cursorCreatedAt: row.cursorCreatedAt,
    lastRunAt: row.lastRunAt,
    lastOkAt: row.lastOkAt,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    backoffUntil: row.backoffUntil,
    disabledReason: row.disabledReason,
    lastTestAt: row.lastTestAt,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    notReadyReason: adapter?.notReadyReason?.(cfg) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const asApiError = (err) =>
  err instanceof SinkConfigError ? new ApiError(400, err.message, { code: 'SINK_CONFIG_INVALID' }) : err;

function validate(type, config) {
  try {
    return getAdapter(type).validateConfig(config || {});
  } catch (err) {
    throw asApiError(err);
  }
}

/** Only known keys, so a typo in `filters` can't silently match nothing. */
export function normalizeFilters(filters) {
  const out = {};
  if (Array.isArray(filters?.actions) && filters.actions.length) {
    out.actions = [...new Set(filters.actions.map((a) => String(a)))].slice(0, 200);
  }
  if (Array.isArray(filters?.resourceTypes) && filters.resourceTypes.length) {
    out.resourceTypes = [...new Set(filters.resourceTypes.map((r) => String(r)))].slice(0, 200);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function list(orgId) {
  const rows = await prisma.auditSink.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  return Promise.all(
    rows.map(async (row) => ({
      ...toPublic(row),
      lag: row.isActive && STREAMING_TYPES.includes(row.type) ? await lagOf(row) : null,
    }))
  );
}

/** How many entries this sink still has to ship. */
async function lagOf(row) {
  try {
    return await lagFrom({
      orgId: row.orgId,
      after: row.cursorCreatedAt ? { createdAt: row.cursorCreatedAt, id: row.cursorId } : null,
      filters: row.filters ?? {},
    });
  } catch {
    return null;
  }
}

export async function get(orgId, id) {
  const row = await prisma.auditSink.findFirst({ where: { id, orgId } });
  if (!row) throw new ApiError(404, 'Audit sink not found');
  return {
    ...toPublic(row),
    // Same shape as list(), so the UI doesn't have to care which it called.
    lag: row.isActive && STREAMING_TYPES.includes(row.type) ? await lagOf(row) : null,
  };
}

export async function create(orgId, { name, type, config, filters, isActive, batchSize, backfillFrom }, actor = null) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new ApiError(400, 'Name is required');
  if (!SINK_TYPES.includes(type)) throw new ApiError(400, `Unknown sink type '${type}'`);

  const normalized = validate(type, config);
  const adapter = getAdapter(type);

  // A new sink starts from now, not from the beginning of time — enabling
  // one should not replay the org's entire history into a SIEM unless that
  // was asked for explicitly.
  const cursorCreatedAt = adapter.streaming ? (backfillFrom ? new Date(backfillFrom) : new Date()) : null;

  const row = await prisma.auditSink.create({
    data: {
      orgId,
      name: trimmed,
      type,
      configEncrypted: encryptConfig(normalized),
      filters: normalizeFilters(filters),
      isActive: !!isActive,
      batchSize: Math.min(Math.max(Number(batchSize) || 500, 10), adapter.maxBatch || 500),
      cursorCreatedAt,
      cursorId: '',
      createdById: actor?.userId ?? null,
    },
  });

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.audit_sink.create,
    resourceType: RESOURCE,
    resourceId: row.id,
    metadata: { name: row.name, type, isActive: row.isActive },
  });

  return toPublic(row, normalized);
}

export async function update(orgId, id, data, actor = null) {
  const existing = await prisma.auditSink.findFirst({ where: { id, orgId } });
  if (!existing) throw new ApiError(404, 'Audit sink not found');

  const updateData = {};
  const stored = decryptConfig(existing);
  let effective = stored;

  if (data.name !== undefined) {
    const trimmed = String(data.name).trim();
    if (!trimmed) throw new ApiError(400, 'Name is required');
    updateData.name = trimmed;
  }

  if (data.config !== undefined) {
    effective = validate(existing.type, mergeConfig(existing.type, stored, data.config));
    updateData.configEncrypted = encryptConfig(effective);
    // Credentials changed, so the last test result no longer describes this
    // configuration.
    updateData.lastTestAt = null;
    updateData.lastTestOk = null;
    updateData.lastTestError = null;
  }

  if (data.filters !== undefined) updateData.filters = normalizeFilters(data.filters);
  if (data.batchSize !== undefined) {
    const adapter = getAdapter(existing.type);
    updateData.batchSize = Math.min(Math.max(Number(data.batchSize) || 500, 10), adapter.maxBatch || 500);
  }

  if (data.isActive !== undefined) {
    updateData.isActive = !!data.isActive;
    if (data.isActive) {
      // Turning a sink back on clears the reason it stopped, and its backoff.
      updateData.disabledReason = null;
      updateData.consecutiveFailures = 0;
      updateData.backoffUntil = null;
    }
  }

  const row = await prisma.auditSink.update({ where: { id }, data: updateData });

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action:
      data.isActive === true
        ? ACTIONS.audit_sink.activate
        : data.isActive === false
          ? ACTIONS.audit_sink.deactivate
          : ACTIONS.audit_sink.update,
    resourceType: RESOURCE,
    resourceId: id,
    metadata: { name: row.name, type: row.type, fields: Object.keys(updateData) },
  });

  return toPublic(row, effective);
}

export async function remove(orgId, id, actor = null) {
  const existing = await prisma.auditSink.findFirst({ where: { id, orgId } });
  if (!existing) throw new ApiError(404, 'Audit sink not found');

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.audit_sink.delete,
    resourceType: RESOURCE,
    resourceId: id,
    metadata: { name: existing.name, type: existing.type },
  });

  await prisma.auditSink.delete({ where: { id } });
  return { deleted: true };
}

export async function test(orgId, id, actor = null, ctx = {}) {
  const existing = await prisma.auditSink.findFirst({ where: { id, orgId } });
  if (!existing) throw new ApiError(404, 'Audit sink not found');

  const adapter = getAdapter(existing.type);
  const config = decryptConfig(existing);

  let result;
  try {
    result = await adapter.test(config, { ...ctx, orgId, sinkId: id });
  } catch (err) {
    await prisma.auditSink.update({
      where: { id },
      data: { lastTestAt: new Date(), lastTestOk: false, lastTestError: err.message?.slice(0, 2000) ?? 'failed' },
    });
    await auditLog({
      orgId,
      actorId: actor?.userId ?? null,
      action: ACTIONS.audit_sink.test,
      resourceType: RESOURCE,
      resourceId: id,
      metadata: { name: existing.name, type: existing.type, ok: false },
    });
    return { ok: false, error: err.message };
  }

  await prisma.auditSink.update({
    where: { id },
    data: { lastTestAt: new Date(), lastTestOk: true, lastTestError: null },
  });
  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.audit_sink.test,
    resourceType: RESOURCE,
    resourceId: id,
    metadata: { name: existing.name, type: existing.type, ok: true },
  });

  return { ok: true, detail: result?.detail ?? null };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Stable across retries of the same row range — the idempotency key. */
export const batchIdFor = (sinkId, firstId, lastId) =>
  crypto.createHash('sha1').update(`${sinkId}:${firstId}:${lastId}`).digest('hex').slice(0, 24);

/** Resolve actor names for a batch in one query, for readable records. */
async function actorsFor(rows) {
  const ids = [...new Set(rows.map((r) => r.actorId).filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true, kind: true },
  });
  return new Map(users.map((u) => [u.id, u]));
}

const backoffFor = (failures) => Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);

/**
 * Ship whatever one sink currently owes, up to MAX_BATCHES_PER_RUN batches.
 * Never throws: a broken sink must not take the worker down with it.
 *
 * @returns {Promise<{delivered: number, batches: number, stopped: string|null}>}
 */
export async function runSink(sinkRow, ctx = {}) {
  // `ctx.adapter` lets a caller supply the destination rather than look it
  // up — used by tests to exercise the loop's guarantees without a network,
  // and the same seam adapters use for `fetchImpl`/`connectImpl`.
  const adapter = ctx.adapter ?? getAdapter(sinkRow.type);
  const config = decryptConfig(sinkRow);

  const notReady = adapter.notReadyReason?.(config);
  if (notReady) {
    await prisma.auditSink.update({
      where: { id: sinkRow.id },
      data: { lastRunAt: new Date(), lastError: notReady },
    });
    return { delivered: 0, batches: 0, stopped: notReady };
  }

  let cursor = sinkRow.cursorCreatedAt ? { createdAt: sinkRow.cursorCreatedAt, id: sinkRow.cursorId ?? '' } : null;
  let delivered = 0;
  let batches = 0;

  for (let i = 0; i < MAX_BATCHES_PER_RUN; i += 1) {
    const iterator = stream({
      orgId: sinkRow.orgId,
      after: cursor,
      filters: sinkRow.filters ?? {},
      batchSize: sinkRow.batchSize,
    });
    const { value: rows, done } = await iterator.next();
    await iterator.return?.();
    if (done || !rows?.length) break;

    const actors = await actorsFor(rows);
    const envelopes = rows.map((r) => toEnvelope(r, { actor: actors.get(r.actorId) ?? null }));
    const first = rows[0];
    const last = rows[rows.length - 1];
    const batchId = batchIdFor(sinkRow.id, first.id, last.id);
    const startedAt = new Date();

    try {
      const result = await adapter.deliver(config, envelopes, {
        ...ctx,
        orgId: sinkRow.orgId,
        sinkId: sinkRow.id,
        batchId,
      });

      // The cursor moves only now, after the adapter has returned. This is
      // the at-least-once guarantee and the one invariant here that must
      // never be relaxed.
      cursor = { createdAt: last.createdAt, id: last.id };
      await prisma.$transaction([
        prisma.auditSink.update({
          where: { id: sinkRow.id },
          data: {
            cursorCreatedAt: last.createdAt,
            cursorId: last.id,
            lastRunAt: new Date(),
            lastOkAt: new Date(),
            lastError: null,
            consecutiveFailures: 0,
            backoffUntil: null,
          },
        }),
        prisma.auditSinkDelivery.create({
          data: {
            sinkId: sinkRow.id,
            orgId: sinkRow.orgId,
            batchId,
            fromCreatedAt: first.createdAt,
            toCreatedAt: last.createdAt,
            firstLogId: first.id,
            lastLogId: last.id,
            count: rows.length,
            status: 'ok',
            objectKey: result?.objectKey ?? null,
            durationMs: Date.now() - startedAt.getTime(),
            finishedAt: new Date(),
          },
        }),
      ]);

      delivered += rows.length;
      batches += 1;
    } catch (err) {
      const failures = (sinkRow.consecutiveFailures ?? 0) + 1;
      const permanent = err instanceof PermanentSinkError;
      const giveUp = permanent || failures >= MAX_CONSECUTIVE_FAILURES;

      await prisma.auditSinkDelivery.create({
        data: {
          sinkId: sinkRow.id,
          orgId: sinkRow.orgId,
          batchId,
          fromCreatedAt: first.createdAt,
          toCreatedAt: last.createdAt,
          firstLogId: first.id,
          lastLogId: last.id,
          count: rows.length,
          status: 'failed',
          attempt: failures,
          error: err.message?.slice(0, 2000) ?? 'failed',
          durationMs: Date.now() - startedAt.getTime(),
          finishedAt: new Date(),
        },
      });

      await prisma.auditSink.update({
        where: { id: sinkRow.id },
        data: {
          lastRunAt: new Date(),
          lastError: err.message?.slice(0, 2000) ?? 'failed',
          consecutiveFailures: failures,
          // Cursor untouched: this batch goes again.
          ...(giveUp
            ? {
                isActive: false,
                disabledReason: permanent
                  ? `Stopped: ${err.message}`.slice(0, 500)
                  : `Stopped after ${failures} failures in a row`,
              }
            : { backoffUntil: new Date(Date.now() + (err.retryAfterMs ?? backoffFor(failures))) }),
        },
      });

      if (giveUp) {
        await auditLog({
          orgId: sinkRow.orgId,
          action: ACTIONS.audit_sink.disabled,
          resourceType: RESOURCE,
          resourceId: sinkRow.id,
          metadata: { name: sinkRow.name, type: sinkRow.type, reason: err.message, failures },
        });
        logger.error('sinkService: sink disabled after repeated failures', {
          sinkId: sinkRow.id,
          orgId: sinkRow.orgId,
          failures,
          error: err.message,
        });
      } else {
        logger.warn('sinkService: delivery failed, will retry', {
          sinkId: sinkRow.id,
          failures,
          error: err.message,
        });
      }

      return { delivered, batches, stopped: err.message };
    }
  }

  return { delivered, batches, stopped: null };
}


// ---------------------------------------------------------------------------
// Non-streaming sinks: the periodic digest
// ---------------------------------------------------------------------------

/**
 * One CSV cell. Quotes everything, which is always valid and saves guessing
 * which of a comma, a quote, a newline or a leading `=` is in the value.
 */
function csvCell(v) {
  if (v === null || v === undefined) return '""';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula,
  // and a leading tab or carriage return does the same in some Excel and
  // Sheets configurations — the value after it is what gets evaluated.
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

const CSV_COLUMNS = ['id', 'occurredAt', 'action', 'category', 'severity', 'actor', 'resource', 'ip'];

function toCsv(envelopes) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const e of envelopes) {
    lines.push(
      [
        e.id,
        e.occurredAt,
        e.action,
        e.category,
        e.severity,
        e.actor?.email || e.actor?.name || e.actor?.id || 'system',
        [e.resource?.type, e.resource?.id].filter(Boolean).join(':'),
        e.ip ?? e.ipAddress ?? '',
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return lines.join('\n');
}

/**
 * Run one non-streaming (digest) sink.
 *
 * Separate from `runSink` because the two have opposite shapes: a streaming
 * sink holds a durable cursor and ships everything it owes, while a digest
 * answers "what happened in this period?" and is bounded by a clock.
 *
 * This exists because the `email_digest` sink was shipped with no scheduler
 * at all — `jobs/auditExport.js` selects `STREAMING_TYPES`, and `email_digest`
 * is `streaming: false`, so its `deliver()` was reachable only from the Test
 * button. An organization could configure a daily audit digest, see it
 * saved and healthy, and never receive one.
 *
 * Never throws: a broken destination must not take the worker down.
 *
 * @returns {Promise<{delivered: number, sent: boolean, stopped: string|null}>}
 */
export async function runDigestSink(sinkRow, ctx = {}) {
  const now = ctx.now ?? new Date();
  const adapter = ctx.adapter ?? getAdapter(sinkRow.type);
  const config = decryptConfig(sinkRow);

  const notReady = adapter.notReadyReason?.(config);
  if (notReady) {
    await prisma.auditSink.update({
      where: { id: sinkRow.id },
      data: { lastRunAt: now, lastError: notReady },
    });
    return { delivered: 0, sent: false, stopped: notReady };
  }

  // The watermark is the end of the last period this sink covered. On a sink
  // that has never run it is `createdAt`, never the beginning of time — a
  // digest turned on this morning must not attach the org's entire history.
  const window = digestDue(
    { schedule: config.schedule, hour: config.hour, dayOfWeek: config.dayOfWeek },
    { anchor: sinkRow.lastOkAt ?? sinkRow.createdAt, now }
  );
  if (!window.due) return { delivered: 0, sent: false, stopped: null };

  // Two corrections to the obvious version of this, both of which lose or
  // duplicate audit entries — the one thing this feature cannot do.
  //
  // 1. `stream()` applies its READ_LAG_MS write-visibility buffer ONLY when
  //    no `until` is supplied (auditService.js:1011). Passing the raw tick
  //    time therefore walked right up to the present, which is precisely
  //    what that buffer exists to prevent: a row whose transaction commits
  //    just after the SELECT, but whose createdAt is inside the window,
  //    would never be read — and because the watermark advances on success,
  //    no later window reaches back for it. Permanently lost, silently.
  //    The ceiling is clamped to the same lag the streaming path respects.
  //
  // 2. The ceiling is INCLUSIVE (`lte`), and the lower bound uses a cursor
  //    id of '' which every cuid sorts above — so a row landing exactly on a
  //    boundary millisecond was included by the window that ended there AND
  //    by the one that began there. The watermark therefore advances to one
  //    millisecond past the ceiling; DateTime(3) makes that the next
  //    representable instant, so this closes the overlap without opening a
  //    gap.
  const ceiling = new Date(Math.min(window.to.getTime(), Date.now() - READ_LAG_MS));
  if (ceiling.getTime() <= window.from.getTime()) {
    // The whole window is still inside the lag. Try again next tick rather
    // than reading a period we cannot yet read completely.
    return { delivered: 0, sent: false, stopped: null };
  }
  const nextWatermark = new Date(ceiling.getTime() + 1);

  const startedAt = new Date();
  const max = adapter.MAX_DIGEST_ROWS ?? 20_000;
  const rows = [];
  let truncated = false;

  try {
    const iterator = stream({
      orgId: sinkRow.orgId,
      after: { createdAt: window.from, id: '' },
      until: ceiling,
      filters: sinkRow.filters ?? {},
      batchSize: sinkRow.batchSize || 500,
    });
    for await (const batch of iterator) {
      for (const r of batch) {
        if (rows.length >= max) {
          truncated = true;
          break;
        }
        rows.push(r);
      }
      if (truncated) break;
    }
    await iterator.return?.();

    const actors = await actorsFor(rows);
    const envelopes = rows.map((r) => toEnvelope(r, { actor: actors.get(r.actorId) ?? null }));

    // An empty period still counts as covered, but sending "nothing happened"
    // every morning is how a digest stops being read.
    if (envelopes.length > 0) {
      const json = config.format === 'json';
      const attachment = {
        filename: `shellius-audit-${window.to.toISOString().slice(0, 10)}.${json ? 'json' : 'csv'}`,
        content: json ? JSON.stringify(envelopes, null, 2) : toCsv(envelopes),
        contentType: json ? 'application/json' : 'text/csv',
      };
      await adapter.deliver(config, envelopes, {
        ...ctx,
        orgId: sinkRow.orgId,
        sinkId: sinkRow.id,
        periodLabel: periodLabel(window.from, ceiling),
        attachment,
        truncated,
      });
    }

    await prisma.$transaction([
      prisma.auditSink.update({
        where: { id: sinkRow.id },
        data: {
          // lastOkAt IS the watermark, and it is one millisecond past the
          // ceiling actually read — see the note above about boundary rows.
          lastRunAt: new Date(),
          lastOkAt: nextWatermark,
          lastError: null,
          consecutiveFailures: 0,
          backoffUntil: null,
        },
      }),
      ...(envelopes.length
        ? [
            prisma.auditSinkDelivery.create({
              data: {
                sinkId: sinkRow.id,
                orgId: sinkRow.orgId,
                batchId: batchIdFor(sinkRow.id, rows[0].id, rows[rows.length - 1].id),
                fromCreatedAt: window.from,
                toCreatedAt: ceiling,
                firstLogId: rows[0].id,
                lastLogId: rows[rows.length - 1].id,
                count: rows.length,
                status: 'ok',
                durationMs: Date.now() - startedAt.getTime(),
                finishedAt: new Date(),
              },
            }),
          ]
        : []),
    ]);

    return { delivered: envelopes.length, sent: envelopes.length > 0, stopped: null };
  } catch (err) {
    const failures = (sinkRow.consecutiveFailures ?? 0) + 1;
    const giveUp = err instanceof PermanentSinkError || failures >= MAX_CONSECUTIVE_FAILURES;

    // The watermark is deliberately NOT advanced: the next tick retries the
    // same period. A duplicated digest beats a silently missing one.
    await prisma.auditSink.update({
      where: { id: sinkRow.id },
      data: {
        lastRunAt: now,
        lastError: err.message?.slice(0, 2000) ?? 'failed',
        consecutiveFailures: failures,
        ...(giveUp
          ? { isActive: false, disabledReason: `Stopped after ${failures} failures: ${err.message}`.slice(0, 2000) }
          : { backoffUntil: new Date(Date.now() + backoffFor(failures)) }),
      },
    });
    logger.error('sinkService: digest failed', { sinkId: sinkRow.id, error: err.message });
    return { delivered: 0, sent: false, stopped: err.message };
  }
}

export default {
  MAX_CONSECUTIVE_FAILURES,
  MAX_BATCHES_PER_RUN,
  toPublic,
  mergeConfig,
  normalizeFilters,
  batchIdFor,
  list,
  get,
  create,
  update,
  remove,
  test,
  runSink,
  runDigestSink,
};
