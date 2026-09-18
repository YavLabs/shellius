import prisma from '../config/db.js';
import logger from '../utils/logger.js';

/**
 * mfaConfigService — per-org MFA policy, DB row overriding env defaults.
 * Env: MFA_ENABLED, MFA_ENFORCED, MFA_ALLOW_TOTP, MFA_ALLOW_EMAIL_OTP.
 */

function envBool(name, dflt) {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());
}

// Tiny per-process cache — getEffective() is called on nearly every
// authenticated request (authenticate middleware + login/mfa gates), so we
// cache the resolved config for a short window instead of hitting Postgres
// every time. 30s means an admin toggling `enforced` takes effect within
// 30s worst-case, which is an acceptable tradeoff for the read volume here.
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // orgId -> { value, expires }

function cacheGet(orgId) {
  const hit = cache.get(orgId);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (hit) cache.delete(orgId);
  return null;
}

function cacheSet(orgId, value) {
  cache.set(orgId, { value, expires: Date.now() + CACHE_TTL_MS });
}

export async function getEffective(orgId) {
  if (orgId) {
    const cached = cacheGet(orgId);
    if (cached) return cached;
  }

  let row = null;
  if (orgId) {
    try {
      row = await prisma.mfaConfig.findUnique({ where: { orgId } });
    } catch (err) {
      logger.debug?.('mfaConfigService: lookup failed, using env', { error: err.message });
    }
  }
  const result = {
    enabled: row ? row.enabled : envBool('MFA_ENABLED', false),
    enforced: row ? row.enforced : envBool('MFA_ENFORCED', false),
    allowTotp: row ? row.allowTotp : envBool('MFA_ALLOW_TOTP', true),
    allowEmailOtp: row ? row.allowEmailOtp : envBool('MFA_ALLOW_EMAIL_OTP', true),
    source: row ? 'db' : 'env',
  };
  if (orgId) cacheSet(orgId, result);
  return result;
}

export async function upsert(orgId, data) {
  const payload = {
    enabled: !!data.enabled,
    enforced: !!data.enforced,
    allowTotp: data.allowTotp ?? true,
    allowEmailOtp: data.allowEmailOtp ?? true,
  };
  const existing = await prisma.mfaConfig.findUnique({ where: { orgId } });
  const row = existing
    ? await prisma.mfaConfig.update({ where: { orgId }, data: payload })
    : await prisma.mfaConfig.create({ data: { orgId, ...payload } });
  cache.delete(orgId);
  logger.info('mfaConfigService.upsert: saved', { orgId });
  return row;
}

export async function remove(orgId) {
  await prisma.mfaConfig.deleteMany({ where: { orgId } });
  cache.delete(orgId);
}

export default { getEffective, upsert, remove };
