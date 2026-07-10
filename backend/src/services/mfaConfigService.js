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

export async function getEffective(orgId) {
  let row = null;
  if (orgId) {
    try {
      row = await prisma.mfaConfig.findUnique({ where: { orgId } });
    } catch (err) {
      logger.debug?.('mfaConfigService: lookup failed, using env', { error: err.message });
    }
  }
  return {
    enabled: row ? row.enabled : envBool('MFA_ENABLED', false),
    enforced: row ? row.enforced : envBool('MFA_ENFORCED', false),
    allowTotp: row ? row.allowTotp : envBool('MFA_ALLOW_TOTP', true),
    allowEmailOtp: row ? row.allowEmailOtp : envBool('MFA_ALLOW_EMAIL_OTP', true),
    source: row ? 'db' : 'env',
  };
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
  logger.info('mfaConfigService.upsert: saved', { orgId });
  return row;
}

export async function remove(orgId) {
  await prisma.mfaConfig.deleteMany({ where: { orgId } });
}

export default { getEffective, upsert, remove };
