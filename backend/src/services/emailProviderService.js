/**
 * emailProviderService.js — outbound email providers per org
 * (docs/email-delivery.md).
 *
 * - An org may define several providers; at most ONE is active. Enforced by
 *   the partial unique index email_providers_one_active_per_org and by
 *   activate(), which deactivates the others in the same transaction.
 * - All type-specific settings (secrets included) are stored as one
 *   AES-256-GCM encrypted JSON blob (configEncrypted). Secrets are never
 *   returned: toPublic() replaces each with { set: boolean }.
 * - Every query is scoped by orgId. Audit entries never carry secrets.
 */

import crypto from 'crypto';
import prisma from '../config/db.js';
import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { log as auditLog } from './auditService.js';
import { ADAPTERS, PROVIDER_TYPES, getAdapter, sendWith, resolveFrom } from './email/providers/index.js';
import { ProviderConfigError } from './email/providers/common.js';
import { defaultSecurityForPort } from './email/providers/smtp.js';
import * as google from './email/providers/google.js';
import { envSmtpConfigured } from './email/envSmtp.js';
import { permissionsForUser } from './roleService.js';
import { renderTemplate } from '../email/index.js';

export { PROVIDER_TYPES };

export const AUDIT = {
  created: 'email_provider.create',
  updated: 'email_provider.update',
  deleted: 'email_provider.delete',
  activated: 'email_provider.activate',
  deactivated: 'email_provider.deactivate',
  tested: 'email_provider.test',
  googleConnected: 'email_provider.google_connect',
};

const RESOURCE = 'EmailProvider';
const GOOGLE_STATE_TTL_SECONDS = 600;
const GOOGLE_STATE_PREFIX = 'email:google:state:';

// ---------------------------------------------------------------------------
// Encryption + masking
// ---------------------------------------------------------------------------

function encryptConfig(cfg) {
  return encrypt(JSON.stringify(cfg || {}));
}

function decryptConfig(row) {
  if (!row?.configEncrypted) return null;
  return JSON.parse(decrypt(row.configEncrypted));
}

/** API shape of a provider. Secrets → { set }, never values. */
export function toPublic(row, cfg = undefined) {
  if (!row) return null;
  const adapter = ADAPTERS[row.type];
  let settings = cfg;
  if (settings === undefined) {
    try {
      settings = decryptConfig(row);
    } catch (err) {
      logger.error('emailProviderService: could not decrypt provider config', { providerId: row.id, error: err.message });
      settings = null;
    }
  }
  const secretFields = adapter?.secretFields || [];
  const publicConfig = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (secretFields.includes(k)) continue;
    publicConfig[k] = v;
  }
  for (const k of secretFields) publicConfig[k] = { set: !!settings?.[k] };

  const out = {
    id: row.id,
    name: row.name,
    type: row.type,
    typeLabel: adapter?.label || row.type,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    isActive: row.isActive,
    lastTestAt: row.lastTestAt,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    config: publicConfig,
    // Copied from smtp_configs by the migration, settings not imported yet.
    pendingImport: !row.configEncrypted && !!row.legacySmtpConfigId,
  };
  if (settings) {
    out.effectiveFrom = resolveFrom({ type: row.type, config: settings, fromAddress: row.fromAddress }).address;
    const reason = adapter?.notReadyReason?.(settings) || null;
    out.ready = !reason;
    out.notReadyReason = reason;
  } else {
    out.ready = false;
    out.notReadyReason = out.pendingImport ? 'SMTP settings are being imported' : 'Settings could not be read';
  }
  if (row.type === 'google' && settings) {
    const client = google.resolveOAuthClient(settings);
    out.google = {
      mode: settings.mode,
      connected: settings.mode === 'service_account' ? true : !!settings.refreshToken,
      connectedEmail: settings.connectedEmail || null,
      usingEnvClient: client.fromEnv,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function badRequest(message) {
  return new ApiError(400, message, { code: 'VALIDATION_ERROR' });
}

function validateFor(type, cfg) {
  try {
    return getAdapter(type).validateConfig(cfg);
  } catch (err) {
    if (err instanceof ProviderConfigError) throw badRequest(err.message);
    throw err;
  }
}

/** Remove server-only keys (e.g. Google refreshToken) from API input. */
function stripInternal(type, input) {
  const out = { ...(input || {}) };
  for (const k of getAdapter(type).internalFields || []) delete out[k];
  return out;
}

/**
 * Merge submitted config over the stored one. Secrets omitted (undefined or
 * '') keep their stored value; an explicit null clears them.
 */
export function mergeConfig(type, stored, input) {
  const adapter = getAdapter(type);
  const merged = { ...(stored || {}) };
  for (const [k, v] of Object.entries(stripInternal(type, input))) {
    if (adapter.secretFields.includes(k) && (v === undefined || v === '')) continue;
    merged[k] = v;
  }
  return merged;
}

function checkFromAddress(type, fromAddress) {
  if (getAdapter(type).requiresFromAddress && !fromAddress) {
    throw badRequest(`fromAddress is required for ${getAdapter(type).label}`);
  }
}

async function findScoped(orgId, id) {
  const row = await prisma.emailProvider.findFirst({ where: { id, orgId } });
  if (!row) throw new ApiError(404, 'Email provider not found');
  return row;
}

function audit(ctx, action, row, metadata = {}) {
  return auditLog({
    orgId: row.orgId,
    actorId: ctx?.userId || null,
    action,
    resourceType: RESOURCE,
    resourceId: row.id,
    metadata: { name: row.name, type: row.type, ...metadata },
    ipAddress: ctx?.ip,
    userAgent: ctx?.userAgent,
  });
}

// ---------------------------------------------------------------------------
// Legacy smtp_configs import (see migration 20260921000000_email_providers)
// ---------------------------------------------------------------------------

/** smtp_configs row → smtp provider config (password decrypted). */
export function legacySmtpToConfig(legacy) {
  const port = legacy.port || 587;
  let security;
  if (!legacy.useTls) security = 'none';
  else security = defaultSecurityForPort(port);
  return {
    host: legacy.host,
    port,
    security,
    username: legacy.username || null,
    password: legacy.passwordEncrypted ? decrypt(legacy.passwordEncrypted) : null,
  };
}

async function importLegacyRow(row) {
  const legacy = await prisma.smtpConfig.findFirst({
    where: { id: row.legacySmtpConfigId, orgId: row.orgId },
  });
  if (!legacy) {
    logger.warn('emailProviderService: legacy SMTP row missing, cannot import', { orgId: row.orgId, providerId: row.id });
    return null;
  }
  const cfg = legacySmtpToConfig(legacy);
  // Only fill a row that is still un-imported (idempotent, race-safe).
  const res = await prisma.emailProvider.updateMany({
    where: { id: row.id, orgId: row.orgId, configEncrypted: null },
    data: { configEncrypted: encryptConfig(cfg) },
  });
  if (res.count === 0) {
    const fresh = await prisma.emailProvider.findFirst({ where: { id: row.id, orgId: row.orgId } });
    return fresh;
  }
  logger.info('emailProviderService: imported legacy SMTP settings', { orgId: row.orgId, providerId: row.id });
  return prisma.emailProvider.findFirst({ where: { id: row.id, orgId: row.orgId } });
}

/**
 * Boot-time, idempotent: encrypt the settings of every provider the
 * migration copied from smtp_configs. Never throws.
 */
export async function importLegacySmtpConfigs() {
  let imported = 0;
  try {
    const pending = await prisma.emailProvider.findMany({
      where: { configEncrypted: null, legacySmtpConfigId: { not: null } },
    });
    for (const row of pending) {
      try {
        if (await importLegacyRow(row)) imported += 1;
      } catch (err) {
        logger.error('emailProviderService: legacy SMTP import failed', { orgId: row.orgId, providerId: row.id, error: err.message });
      }
    }
  } catch (err) {
    logger.error('emailProviderService: legacy SMTP import scan failed', { error: err.message });
  }
  return imported;
}

async function ensureImported(row) {
  if (row && !row.configEncrypted && row.legacySmtpConfigId) {
    return (await importLegacyRow(row)) || row;
  }
  return row;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function googleRedirectUri() {
  return `${config.publicBaseUrl.replace(/\/$/, '')}/api/settings/email/google/callback`;
}

export async function list(orgId) {
  const rows = await prisma.emailProvider.findMany({
    where: { orgId },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
  });
  const providers = [];
  for (const row of rows) providers.push(toPublic(await ensureImported(row)));
  const active = providers.find((p) => p.isActive) || null;
  return {
    providers,
    meta: {
      activeProviderId: active?.id || null,
      // Booleans only — the env values themselves are never exposed.
      envSmtpConfigured: envSmtpConfigured(),
      googleEnvClientConfigured: !!(process.env.SSO_GOOGLE_CLIENT_ID && process.env.SSO_GOOGLE_CLIENT_SECRET),
      googleRedirectUri: googleRedirectUri(),
      types: PROVIDER_TYPES.map((t) => ({ type: t, label: ADAPTERS[t].label })),
    },
  };
}

export async function get(orgId, id) {
  return toPublic(await ensureImported(await findScoped(orgId, id)));
}

/** Active provider with decrypted config, for sending. null when none. */
export async function getActiveForSend(orgId) {
  if (!orgId) return null;
  let row = await prisma.emailProvider.findFirst({ where: { orgId, isActive: true } });
  if (!row) return null;
  row = await ensureImported(row);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    config: decryptConfig(row),
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function create(orgId, input, ctx = {}) {
  const { name, type, fromAddress = null, fromName = null, config: cfgInput = {}, isActive = false } = input;
  if (!PROVIDER_TYPES.includes(type)) throw badRequest(`Unknown provider type: ${type}`);
  const cfg = validateFor(type, stripInternal(type, cfgInput));
  checkFromAddress(type, fromAddress);
  if (isActive) {
    // Refuse up front rather than create a provider and then fail to activate it.
    const reason = getAdapter(type).notReadyReason?.(cfg);
    if (reason) throw badRequest(`Can't make this provider active yet: ${reason}`);
  }

  const row = await prisma.emailProvider.create({
    data: {
      orgId,
      name,
      type,
      fromAddress: fromAddress || null,
      fromName: fromName || null,
      configEncrypted: encryptConfig(cfg),
      isActive: false,
      createdById: ctx.userId || null,
    },
  });
  await audit(ctx, AUDIT.created, row);
  if (isActive) return activate(orgId, row.id, ctx);
  return toPublic(row, cfg);
}

export async function update(orgId, id, input, ctx = {}) {
  const row = await ensureImported(await findScoped(orgId, id));
  if (input.type && input.type !== row.type) {
    throw badRequest('The provider type cannot be changed — create a new provider instead');
  }
  const stored = decryptConfig(row) || {};
  const merged = input.config ? mergeConfig(row.type, stored, input.config) : stored;
  const cfg = validateFor(row.type, merged);

  const data = { configEncrypted: encryptConfig(cfg) };
  if (input.name !== undefined) data.name = input.name;
  if (input.fromAddress !== undefined) data.fromAddress = input.fromAddress || null;
  if (input.fromName !== undefined) data.fromName = input.fromName || null;
  checkFromAddress(row.type, data.fromAddress !== undefined ? data.fromAddress : row.fromAddress);

  // Credentials changed → the previous test result no longer applies.
  const changed = Object.keys(input.config || {}).filter((k) => {
    const v = input.config[k];
    return !(getAdapter(row.type).secretFields.includes(k) && (v === undefined || v === '')) && JSON.stringify(stored[k]) !== JSON.stringify(cfg[k]);
  });
  if (changed.length > 0) {
    data.lastTestAt = null;
    data.lastTestOk = null;
    data.lastTestError = null;
  }

  const updated = await prisma.emailProvider.update({ where: { id: row.id }, data });
  await audit(ctx, AUDIT.updated, updated, {
    // Field NAMES only (secrets included by name, never by value).
    changedFields: [
      ...['name', 'fromAddress', 'fromName'].filter((k) => input[k] !== undefined && input[k] !== row[k]),
      ...changed.map((k) => `config.${k}`),
    ],
  });
  return toPublic(updated, cfg);
}

export async function remove(orgId, id, ctx = {}) {
  const row = await findScoped(orgId, id);
  await prisma.emailProvider.deleteMany({ where: { id: row.id, orgId } });
  await audit(ctx, AUDIT.deleted, row, { wasActive: row.isActive });
  return { deleted: true, wasActive: row.isActive };
}

export async function activate(orgId, id, ctx = {}) {
  const row = await ensureImported(await findScoped(orgId, id));
  const cfg = decryptConfig(row);
  if (!cfg) throw badRequest('This provider has no settings yet');
  const reason = getAdapter(row.type).notReadyReason?.(cfg);
  if (reason) throw badRequest(reason);

  const previous = await prisma.emailProvider.findFirst({ where: { orgId, isActive: true, NOT: { id: row.id } } });
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.emailProvider.updateMany({ where: { orgId, isActive: true, NOT: { id: row.id } }, data: { isActive: false } });
      return tx.emailProvider.update({ where: { id: row.id }, data: { isActive: true } });
    });
  } catch (err) {
    // email_providers_one_active_per_org: a concurrent activation won.
    if (err?.code === 'P2002') {
      throw new ApiError(409, 'Another provider was activated at the same time — reload and try again', { code: 'CONFLICT' });
    }
    throw err;
  }
  if (!row.isActive) {
    await audit(ctx, AUDIT.activated, updated, previous ? { previousProviderId: previous.id, previousName: previous.name } : {});
  }
  return toPublic(updated, cfg);
}

export async function deactivate(orgId, id, ctx = {}) {
  const row = await findScoped(orgId, id);
  const updated = await prisma.emailProvider.update({ where: { id: row.id }, data: { isActive: false } });
  if (row.isActive) await audit(ctx, AUDIT.deactivated, updated);
  return toPublic(updated);
}

/**
 * Send a test email through a provider (active or not) and record the result.
 * Returns { ok, sentTo, error } — provider errors are returned, not thrown.
 */
export async function test(orgId, id, { to, recipientName, orgName } = {}, ctx = {}) {
  const row = await ensureImported(await findScoped(orgId, id));
  const cfg = decryptConfig(row);
  if (!cfg) throw badRequest('This provider has no settings yet');
  const adapter = getAdapter(row.type);
  const when = new Date();

  let ok = false;
  let error = null;
  const reason = adapter.notReadyReason?.(cfg);
  if (reason) {
    error = reason;
  } else {
    const from = resolveFrom({ type: row.type, config: cfg, fromAddress: row.fromAddress, fromName: row.fromName });
    const tpl = renderTemplate('emailTest', {
      recipientName,
      orgName,
      providerName: row.name,
      providerLabel: adapter.label,
      fromAddress: from.address,
      when: when.toISOString(),
    });
    try {
      await sendWith({ type: row.type, config: cfg, fromAddress: row.fromAddress, fromName: row.fromName }, { to, ...tpl });
      ok = true;
    } catch (err) {
      error = err?.message || 'Delivery failed';
      logger.warn('emailProviderService: test email failed', { orgId, providerId: row.id, provider: row.name, type: row.type, error });
    }
  }

  const updated = await prisma.emailProvider.update({
    where: { id: row.id },
    data: { lastTestAt: when, lastTestOk: ok, lastTestError: ok ? null : String(error).slice(0, 1000) },
  });
  await audit(ctx, AUDIT.tested, updated, { ok, to, ...(ok ? {} : { error: String(error).slice(0, 300) }) });
  return { ok, sentTo: to, error, provider: toPublic(updated, cfg) };
}

// ---------------------------------------------------------------------------
// Google "Connect account" OAuth flow
// ---------------------------------------------------------------------------

// State store: Redis in production (one-time, 10-minute keys). Swappable for
// tests via _setStateStore().
let stateStore = null;

async function defaultStateStore() {
  const { default: redis } = await import('../config/redis.js');
  return {
    async put(key, value, ttlSeconds) {
      await redis.set(key, value, 'EX', ttlSeconds);
    },
    async take(key) {
      return redis.getdel(key);
    },
  };
}

async function getStateStore() {
  if (!stateStore) stateStore = await defaultStateStore();
  return stateStore;
}

export function _setStateStore(store) {
  stateStore = store;
}

/** Start the Google consent flow; returns { authUrl, redirectUri }. */
export async function startGoogleConnect(orgId, id, ctx = {}) {
  const row = await findScoped(orgId, id);
  if (row.type !== 'google') throw badRequest('Only Google providers can connect a Google account');
  const cfg = decryptConfig(row) || {};
  if (cfg.mode === 'service_account') throw badRequest('This provider uses a service account — there is no account to connect');
  const { clientId, clientSecret } = google.resolveOAuthClient(cfg);
  if (!clientId || !clientSecret) {
    throw badRequest('Set the Google OAuth client ID and secret first (or SSO_GOOGLE_CLIENT_ID / SSO_GOOGLE_CLIENT_SECRET)');
  }
  const state = crypto.randomBytes(32).toString('hex');
  const store = await getStateStore();
  await store.put(
    GOOGLE_STATE_PREFIX + state,
    JSON.stringify({ orgId, providerId: row.id, userId: ctx.userId }),
    GOOGLE_STATE_TTL_SECONDS
  );
  const redirectUri = googleRedirectUri();
  return {
    authUrl: google.buildAuthUrl({ clientId, redirectUri, state, loginHint: row.fromAddress || undefined }),
    redirectUri,
  };
}

/**
 * OAuth callback. Validates the one-time state (bound to org + provider +
 * user), re-checks that user still may manage email settings, exchanges the
 * code and stores the refresh token encrypted.
 *
 * Returns { ok: true } or { ok: false, error: <short code> } — the route
 * turns that into a redirect to /admin/email.
 */
export async function completeGoogleConnect({ state, code, error, ip, userAgent } = {}) {
  if (!state || typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) {
    return { ok: false, error: 'invalid_state' };
  }
  const store = await getStateStore();
  const raw = await store.take(GOOGLE_STATE_PREFIX + state);
  if (!raw) return { ok: false, error: 'invalid_state' };
  let bound;
  try {
    bound = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_state' };
  }
  if (error) return { ok: false, error: error === 'access_denied' ? 'access_denied' : 'google_error' };
  if (!code || typeof code !== 'string') return { ok: false, error: 'missing_code' };

  const user = await prisma.user.findFirst({
    where: { id: bound.userId, orgId: bound.orgId },
    select: {
      id: true,
      orgId: true,
      role: true,
      status: true,
      assignedRole: { select: { id: true, key: true, isSystem: true, baseRole: true, permissions: true } },
    },
  });
  if (!user || user.status !== 'active' || !permissionsForUser(user).includes('settings.smtp')) {
    return { ok: false, error: 'forbidden' };
  }

  const row = await prisma.emailProvider.findFirst({ where: { id: bound.providerId, orgId: bound.orgId } });
  if (!row || row.type !== 'google') return { ok: false, error: 'provider_not_found' };
  const cfg = decryptConfig(row) || {};
  const { clientId, clientSecret } = google.resolveOAuthClient(cfg);
  if (!clientId || !clientSecret) return { ok: false, error: 'client_not_configured' };

  let result;
  try {
    result = await google.exchangeCode({ clientId, clientSecret, code, redirectUri: googleRedirectUri() });
  } catch (err) {
    logger.warn('emailProviderService: Google connect failed', { orgId: row.orgId, providerId: row.id, error: err.message });
    await prisma.emailProvider.update({
      where: { id: row.id },
      data: { lastTestAt: new Date(), lastTestOk: false, lastTestError: String(err.message).slice(0, 1000) },
    });
    return { ok: false, error: err.code === 'SCOPE_MISSING' ? 'scope_missing' : 'exchange_failed' };
  }

  const next = { ...cfg, mode: 'oauth', refreshToken: result.refreshToken, connectedEmail: result.email || cfg.connectedEmail || null };
  const updated = await prisma.emailProvider.update({
    where: { id: row.id },
    data: { configEncrypted: encryptConfig(next), lastTestAt: null, lastTestOk: null, lastTestError: null },
  });
  await audit({ userId: user.id, ip, userAgent }, AUDIT.googleConnected, updated, { connectedEmail: next.connectedEmail });
  return { ok: true };
}

export default {
  PROVIDER_TYPES,
  AUDIT,
  toPublic,
  mergeConfig,
  list,
  get,
  getActiveForSend,
  create,
  update,
  remove,
  activate,
  deactivate,
  test,
  startGoogleConnect,
  completeGoogleConnect,
  importLegacySmtpConfigs,
  legacySmtpToConfig,
  googleRedirectUri,
};
