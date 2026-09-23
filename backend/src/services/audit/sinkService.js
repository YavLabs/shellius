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
import { ACTIONS, log as auditLog, stream, lagFrom } from '../auditService.js';
import { toEnvelope } from './envelope.js';
import { getAdapter, SINK_TYPES, STREAMING_TYPES } from './sinks/index.js';
import { SinkConfigError, PermanentSinkError } from './sinks/errors.js';

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
};
