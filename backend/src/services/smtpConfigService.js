/**
 * smtpConfigService.js — DEPRECATED compatibility shim.
 *
 * Email delivery is configured through email providers
 * (emailProviderService, /api/settings/email/providers). The legacy
 * /api/settings/smtp endpoints still work and now read/write the org's
 * active SMTP provider instead of the smtp_configs table (which is kept
 * untouched for rollback — see migration 20260921000000_email_providers).
 */

import prisma from '../config/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { getActiveForSend } from './emailProviderService.js';
import { envSmtpSecurity } from './email/envSmtp.js';
import { validateConfig as validateSmtpConfig, defaultSecurityForPort } from './email/providers/smtp.js';
import { ProviderConfigError } from './email/providers/common.js';

/**
 * Effective SMTP settings for an org in the legacy shape: the org's active
 * provider when it is an SMTP provider (source 'db'), else SMTP_* env vars.
 * Returns { ...effective, configured: false } when there is no SMTP host.
 *
 * @param {string|undefined} orgId
 * @returns {Promise<object>}
 */
export async function getEffective(orgId) {
  let db = null;
  if (orgId) {
    const active = await getActiveForSend(orgId);
    if (active?.type === 'smtp' && active.config) db = { ...active.config, fromAddress: active.fromAddress };
  }

  const envPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
  const effective = {
    host: db?.host || process.env.SMTP_HOST || null,
    port: db?.port ?? envPort,
    username: db ? db.username || null : process.env.SMTP_USER || null,
    password: db ? db.password || null : process.env.SMTP_PASS || null,
    fromAddress: db ? db.fromAddress || null : process.env.SMTP_FROM || null,
    security: db ? db.security : envSmtpSecurity(envPort),
    useTls: db ? db.security !== 'none' : process.env.SMTP_SECURE !== 'false',
    isActive: true,
    source: {
      host: db?.host ? 'db' : process.env.SMTP_HOST ? 'env' : null,
      port: db ? 'db' : process.env.SMTP_PORT ? 'env' : 'default',
      username: db ? (db.username ? 'db' : null) : process.env.SMTP_USER ? 'env' : null,
      password: db ? (db.password ? 'db' : null) : process.env.SMTP_PASS ? 'env' : null,
      fromAddress: db ? (db.fromAddress ? 'db' : null) : process.env.SMTP_FROM ? 'env' : null,
    },
  };

  if (!effective.host) return { ...effective, configured: false };
  return { ...effective, configured: true };
}

/**
 * Legacy upsert: updates the org's active SMTP provider, or creates an
 * active one named "SMTP". Password omitted → kept.
 *
 * @param {string} orgId
 * @param {object} data - { host, port, username, password, fromAddress, useTls }
 * @returns {Promise<object>} masked legacy-shaped row
 */
export async function upsert(orgId, data) {
  const { host, port, username, password, fromAddress, useTls } = data;
  if (!host) throw new ApiError(400, 'host is required');

  const existing = await prisma.emailProvider.findFirst({ where: { orgId, isActive: true, type: 'smtp' } });
  const stored = existing?.configEncrypted ? JSON.parse(decrypt(existing.configEncrypted)) : {};
  const p = port ?? 587;
  let cfg;
  try {
    cfg = validateSmtpConfig({
      host,
      port: p,
      security: useTls === false ? 'none' : defaultSecurityForPort(p),
      username: username || null,
      password: password || stored.password || null,
    });
  } catch (err) {
    if (err instanceof ProviderConfigError) throw new ApiError(400, err.message);
    throw err;
  }

  const configEncrypted = encrypt(JSON.stringify(cfg));
  let row;
  if (existing) {
    row = await prisma.emailProvider.update({
      where: { id: existing.id },
      data: { configEncrypted, fromAddress: fromAddress || null },
    });
  } else {
    row = await prisma.$transaction(async (tx) => {
      await tx.emailProvider.updateMany({ where: { orgId, isActive: true }, data: { isActive: false } });
      return tx.emailProvider.create({
        data: { orgId, name: 'SMTP', type: 'smtp', fromAddress: fromAddress || null, configEncrypted, isActive: true },
      });
    });
  }

  logger.info('smtpConfigService.upsert: SMTP provider saved (legacy API)', { orgId, providerId: row.id });
  return {
    id: row.id,
    orgId,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    fromAddress: row.fromAddress,
    useTls: cfg.security !== 'none',
    isActive: row.isActive,
    hasPassword: !!cfg.password,
  };
}

/**
 * Legacy delete: removes the org's active SMTP provider so delivery falls
 * back to the SMTP_* env vars.
 *
 * @param {string} orgId
 */
export async function remove(orgId) {
  await prisma.emailProvider.deleteMany({ where: { orgId, isActive: true, type: 'smtp' } });
  logger.info('smtpConfigService.remove: active SMTP provider deleted (legacy API)', { orgId });
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
