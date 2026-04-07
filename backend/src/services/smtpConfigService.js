import prisma from '../config/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

/**
 * Returns the effective SMTP config for an org, merging env defaults
 * with any UI override row. DB values win over env vars.
 * Returns { ...effective, configured: false } when neither source has
 * enough info to send mail (no host).
 *
 * @param {string|undefined} orgId
 * @returns {Promise<object>}
 */
export async function getEffective(orgId) {
  let row = null;
  if (orgId) {
    row = await prisma.smtpConfig.findUnique({ where: { orgId } });
  }

  const effective = {
    host: row?.host || process.env.SMTP_HOST || null,
    port: row?.port ?? (process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587),
    username: row?.username || process.env.SMTP_USER || null,
    password: row?.passwordEncrypted
      ? decrypt(row.passwordEncrypted)
      : process.env.SMTP_PASS || null,
    fromAddress: row?.fromAddress || process.env.SMTP_FROM || null,
    useTls: row?.useTls ?? (process.env.SMTP_SECURE !== 'false'),
    isActive: row ? row.isActive : true,
    source: {
      host: row?.host ? 'db' : (process.env.SMTP_HOST ? 'env' : null),
      port: row?.port != null ? 'db' : (process.env.SMTP_PORT ? 'env' : 'default'),
      username: row?.username ? 'db' : (process.env.SMTP_USER ? 'env' : null),
      password: row?.passwordEncrypted ? 'db' : (process.env.SMTP_PASS ? 'env' : null),
      fromAddress: row?.fromAddress ? 'db' : (process.env.SMTP_FROM ? 'env' : null),
    },
  };

  if (!effective.host) return { ...effective, configured: false };
  return { ...effective, configured: true };
}

/**
 * Upsert the SMTP config for an org.
 * Encrypts password when provided; preserves existing encrypted password
 * when omitted on update.
 *
 * @param {string} orgId
 * @param {object} data
 * @returns {Promise<object>} masked row (no passwordEncrypted)
 */
export async function upsert(orgId, data) {
  const { host, port, username, password, fromAddress, useTls, isActive } = data;
  if (!host) throw new ApiError(400, 'host is required');

  const existing = await prisma.smtpConfig.findUnique({ where: { orgId } });

  const payload = {
    host,
    port: port ?? 587,
    username: username || null,
    fromAddress: fromAddress || null,
    useTls: useTls ?? true,
    isActive: isActive ?? true,
  };

  if (password) {
    payload.passwordEncrypted = encrypt(password);
  } else if (!existing) {
    payload.passwordEncrypted = null;
  }
  // On update without a new password: leave passwordEncrypted unchanged (not in payload)

  const row = existing
    ? await prisma.smtpConfig.update({ where: { orgId }, data: payload })
    : await prisma.smtpConfig.create({ data: { orgId, ...payload } });

  logger.info('smtpConfigService.upsert: config saved', { orgId });
  return maskRow(row);
}

/**
 * Delete the SMTP config row for an org (reverts to env defaults).
 *
 * @param {string} orgId
 */
export async function remove(orgId) {
  await prisma.smtpConfig.deleteMany({ where: { orgId } });
  logger.info('smtpConfigService.remove: config deleted', { orgId });
}

/**
 * Strip the encrypted password column and replace with a boolean flag.
 *
 * @param {object|null} row
 * @returns {object|null}
 */
export function maskRow(row) {
  if (!row) return null;
  const { passwordEncrypted, ...rest } = row;
  return { ...rest, hasPassword: !!passwordEncrypted };
}
