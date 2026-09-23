/**
 * chatDestinationService.js — configuring where messages go, and deciding
 * which destinations an event reaches.
 *
 * Configuration follows the audit sinks exactly: one encrypted blob per row,
 * secrets masked to `{ set: true }` on the way out, a secret left alone when
 * an update omits it, a test button whose result is stored, and auto-disable
 * after repeated failure.
 *
 * The routing rules are where this differs, and `matches()` is the part worth
 * reading. In particular the customer rule is **deny by default**, which is
 * the opposite of the "empty means everything" convention used elsewhere in
 * this file — see the comment there for why.
 */

import crypto from 'crypto';
import prisma from '../../config/db.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { encrypt, decrypt } from '../../utils/crypto.js';
import { ACTIONS, log as auditLog } from '../auditService.js';
import { getAdapter, PLATFORMS, canAct, describeAdapters } from './chat/index.js';
import {
  CHAT_DEFAULT_EVENT_KEYS,
  CHAT_SAFE_EVENT_KEYS,
  getEvent,
  severityRank,
} from '../../config/notificationEvents.js';

const RESOURCE = 'ChatDestination';

/** Give up on a destination after this many consecutive failures. */
export const MAX_CONSECUTIVE_FAILURES = 10;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function decryptConfig(row) {
  if (!row?.configEncrypted) return {};
  try {
    return JSON.parse(decrypt(row.configEncrypted));
  } catch (err) {
    logger.error('chatDestinationService: could not decrypt config', { id: row.id, error: err.message });
    return {};
  }
}

const encryptConfig = (config) => encrypt(JSON.stringify(config ?? {}));

/** Keep any secret the caller did not resend, so "save" never wipes one. */
export function mergeConfig(platform, stored, incoming) {
  const adapter = getAdapter(platform);
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

export function toPublic(row, config = null) {
  if (!row) return row;
  const adapter = PLATFORMS.includes(row.platform) ? getAdapter(row.platform) : null;
  const cfg = config ?? decryptConfig(row);

  const publicConfig = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (adapter?.secretFields.includes(k)) continue;
    publicConfig[k] = v;
  }
  for (const k of adapter?.secretFields ?? []) publicConfig[k] = { set: !!cfg[k] };

  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    platform: row.platform,
    platformLabel: adapter?.label ?? row.platform,
    mode: row.mode,
    // Enough to tell two destinations apart without revealing the credential.
    target: adapter?.describeConfig ? adapter.describeConfig(cfg) : null,
    canAct: canAct(row.platform, row.mode),
    supportsDirectMessages: adapter?.supportsDirectMessages ?? false,
    events: row.events,
    environments: row.environments,
    customerIds: row.customerIds,
    minSeverity: row.minSeverity,
    isActive: row.isActive,
    lastDeliveredAt: row.lastDeliveredAt,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    backoffUntil: row.backoffUntil,
    disabledReason: row.disabledReason,
    lastTestAt: row.lastTestAt,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    config: publicConfig,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeSettings(data) {
  const out = {};
  if (data.name !== undefined) out.name = String(data.name).trim().slice(0, 100);
  if (data.isActive !== undefined) out.isActive = !!data.isActive;
  if (data.events !== undefined) {
    const unknown = (data.events || []).filter((e) => !CHAT_SAFE_EVENT_KEYS.includes(e));
    if (unknown.length) {
      // Refuse rather than silently drop: an event that cannot go to chat
      // being quietly removed from a destination would read as configured.
      throw new ApiError(400, `Not a chat-deliverable event: ${unknown.join(', ')}`);
    }
    out.events = data.events;
  }
  if (data.environments !== undefined) out.environments = data.environments || [];
  if (data.customerIds !== undefined) out.customerIds = data.customerIds || [];
  if (data.minSeverity !== undefined) out.minSeverity = data.minSeverity || null;
  return out;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Does this destination want this event?
 *
 * @param {object} row - a ChatDestination
 * @param {object} definition - the event, from config/notificationEvents.js
 * @param {object} context - `{ environment, customerId }` of the subject
 */
export function matches(row, definition, context = {}) {
  if (!row.isActive) return false;

  const wanted = row.events?.length ? row.events : CHAT_DEFAULT_EVENT_KEYS;
  if (!wanted.includes(definition.key)) return false;

  if (row.minSeverity && severityRank(definition.severity) < severityRank(row.minSeverity)) return false;

  if (row.environments?.length) {
    // An event with no environment — a directory sync, a break-glass with no
    // server — cannot satisfy an environment filter, so a destination that
    // sets one does not receive those. Configuring "prod only" and then being
    // told about everything would make the filter meaningless.
    if (!context.environment || !row.environments.includes(context.environment)) return false;
  }

  // Customer scope, and this one is deny-by-default on purpose.
  //
  // Every in-app notification is already scoped: postureAlertService drops
  // recipients who cannot see the server, because a scoped user must not learn
  // that an out-of-scope server exists. A channel has no scope of its own, so
  // without this rule one destination in an MSP organisation would receive
  // every customer's servers, requesters and reasons.
  //
  // "Empty means all customers" would make that the DEFAULT, so empty instead
  // means "only events that concern no customer at all".
  if (context.customerId) {
    if (!row.customerIds?.length || !row.customerIds.includes(context.customerId)) return false;
  }

  return true;
}

/** Active destinations for an org that want this event, with config decrypted. */
export async function destinationsFor(orgId, definition, context = {}) {
  const rows = await prisma.chatDestination.findMany({ where: { orgId, isActive: true } });
  const now = Date.now();
  return rows
    .filter((row) => !row.backoffUntil || row.backoffUntil.getTime() <= now)
    .filter((row) => matches(row, definition, context))
    .map((row) => ({ row, config: decryptConfig(row) }));
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export const listAdapters = () => describeAdapters();

export async function list(orgId) {
  const rows = await prisma.chatDestination.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => toPublic(r));
}

export async function get(orgId, id) {
  const row = await prisma.chatDestination.findFirst({ where: { id, orgId } });
  if (!row) throw new ApiError(404, 'Chat destination not found');
  return row;
}

export async function create(orgId, data, actor = null) {
  if (!PLATFORMS.includes(data.platform)) throw new ApiError(400, `Unknown chat platform '${data.platform}'`);
  const adapter = getAdapter(data.platform);
  const mode = data.platform === 'slack' && data.mode === 'app' ? 'app' : 'webhook';
  const config = adapter.validateConfig({ ...(data.config || {}), mode });

  const row = await prisma.chatDestination.create({
    data: {
      orgId,
      platform: data.platform,
      mode,
      configEncrypted: encryptConfig(config),
      createdById: actor?.userId ?? null,
      name: String(data.name || adapter.label).trim().slice(0, 100),
      ...normalizeSettings(data),
    },
  });

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.chat_destination.create,
    resourceType: RESOURCE,
    resourceId: row.id,
    metadata: { platform: row.platform, mode: row.mode, name: row.name, events: row.events },
  });

  return row;
}

export async function update(orgId, id, data, actor = null) {
  const existing = await get(orgId, id);
  const patch = normalizeSettings(data);

  if (data.config !== undefined || data.mode !== undefined) {
    const adapter = getAdapter(existing.platform);
    const mode = existing.platform === 'slack' && (data.mode ?? existing.mode) === 'app' ? 'app' : 'webhook';
    const merged = mergeConfig(existing.platform, decryptConfig(existing), { ...(data.config || {}), mode });
    patch.configEncrypted = encryptConfig(adapter.validateConfig(merged));
    patch.mode = mode;
    // A changed credential clears the failure state: the reason it was
    // disabled may be exactly what was just fixed.
    patch.consecutiveFailures = 0;
    patch.backoffUntil = null;
    patch.disabledReason = null;
  }

  const row = await prisma.chatDestination.update({ where: { id }, data: patch });

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.chat_destination.update,
    resourceType: RESOURCE,
    resourceId: id,
    metadata: { fields: Object.keys(patch), platform: row.platform, isActive: row.isActive },
  });

  return row;
}

export async function remove(orgId, id, actor = null) {
  const existing = await get(orgId, id);
  await prisma.chatDestination.delete({ where: { id } });
  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.chat_destination.delete,
    resourceType: RESOURCE,
    resourceId: id,
    metadata: { platform: existing.platform, name: existing.name },
  });
  return { id };
}

export async function test(orgId, id, actor = null, ctx = {}) {
  const row = await get(orgId, id);
  const adapter = ctx.adapter ?? getAdapter(row.platform);
  try {
    const result = await adapter.test(decryptConfig(row));
    await prisma.chatDestination.update({
      where: { id },
      data: { lastTestAt: new Date(), lastTestOk: true, lastTestError: null },
    });
    await auditLog({
      orgId,
      actorId: actor?.userId ?? null,
      action: ACTIONS.chat_destination.test,
      resourceType: RESOURCE,
      resourceId: id,
      metadata: { ok: true, platform: row.platform },
    });
    return { ok: true, detail: result?.detail ?? 'Delivered' };
  } catch (err) {
    await prisma.chatDestination.update({
      where: { id },
      data: { lastTestAt: new Date(), lastTestOk: false, lastTestError: err.message?.slice(0, 2000) ?? null },
    });
    await auditLog({
      orgId,
      actorId: actor?.userId ?? null,
      action: ACTIONS.chat_destination.test,
      resourceType: RESOURCE,
      resourceId: id,
      metadata: { ok: false, platform: row.platform, error: err.message?.slice(0, 500) },
    });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export async function recordSuccess(id) {
  await prisma.chatDestination.update({
    where: { id },
    data: { lastDeliveredAt: new Date(), consecutiveFailures: 0, backoffUntil: null, lastError: null },
  });
}

/**
 * Record a failure and decide whether the destination should stop trying.
 * A dead endpoint that spins forever is noise; one that stops silently is
 * worse, so switching off is audited and carries a reason.
 */
export async function recordFailure(row, err) {
  const failures = row.consecutiveFailures + 1;
  const disable = failures >= MAX_CONSECUTIVE_FAILURES || err?.disable === true;
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);

  await prisma.chatDestination.update({
    where: { id: row.id },
    data: {
      consecutiveFailures: failures,
      lastError: err?.message?.slice(0, 2000) ?? null,
      backoffUntil: disable ? null : new Date(Date.now() + backoff),
      ...(disable
        ? {
            isActive: false,
            disabledReason:
              err?.disable === true
                ? err.message?.slice(0, 500)
                : `Switched off after ${failures} consecutive failures. Last error: ${err?.message?.slice(0, 300)}`,
          }
        : {}),
    },
  });

  if (disable) {
    logger.error('chatDestinationService: destination disabled', { id: row.id, failures, error: err?.message });
    await auditLog({
      orgId: row.orgId,
      action: ACTIONS.chat_destination.disabled,
      resourceType: RESOURCE,
      resourceId: row.id,
      metadata: { failures, error: err?.message?.slice(0, 500), platform: row.platform },
    });
  }
  return { disabled: disable };
}

export async function listDeliveries(orgId, destinationId, { limit = 50 } = {}) {
  await get(orgId, destinationId);
  return prisma.chatDelivery.findMany({
    where: { orgId, destinationId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(Number(limit) || 50, 1), 200),
  });
}

/** Delivery rows older than this are pruned; they are diagnostics, not records. */
export const DELIVERY_RETENTION_DAYS = 30;

export default {
  listAdapters,
  list,
  get,
  create,
  update,
  remove,
  test,
  matches,
  destinationsFor,
  mergeConfig,
  toPublic,
  decryptConfig,
  recordSuccess,
  recordFailure,
  listDeliveries,
  MAX_CONSECUTIVE_FAILURES,
  DELIVERY_RETENTION_DAYS,
};
