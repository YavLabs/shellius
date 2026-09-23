/**
 * apiTokenService.js — issuing, listing, rotating and revoking API tokens.
 *
 * The plaintext token exists for exactly one function call: it is returned to
 * the caller by create() and rotate() and never persisted, never logged and
 * never recoverable. Everything else in this file works with the row, which
 * holds only the SHA-256 hash and a display prefix.
 *
 * Scopes here are a *request*, not a grant. What a token can actually do is
 * decided per request in middleware/apiTokenAuth.js by intersecting these
 * keys with the live role, so storing an over-broad scope is harmless — it
 * simply has no effect until (and unless) the role grants it.
 */

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { generateApiToken } from '../utils/apiToken.js';
import { isPermission, NON_DELEGABLE_PERMISSIONS } from '../config/permissions.js';
import { ACTIONS, log as auditLog } from './auditService.js';

export const DEFAULT_EXPIRY_DAYS = 90;
export const MAX_EXPIRY_DAYS = Number(process.env.API_TOKEN_MAX_DAYS || 365);
const MAX_TOKENS_PER_USER = Number(process.env.API_TOKEN_MAX_PER_USER || 50);

const NON_DELEGABLE = new Set(NON_DELEGABLE_PERMISSIONS);

/** The shape returned by the API. Never includes the hash. */
export function toPublic(row) {
  if (!row) return row;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    kind: row.kind,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes ?? [],
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt,
    rotatedAt: row.rotatedAt,
    createdAt: row.createdAt,
    userId: row.userId,
  };
}

/**
 * Validate a requested expiry and turn it into a date.
 * Expiry is mandatory — a credential that never dies is one nobody ever
 * notices leaking.
 */
export function expiryFrom(days) {
  const n = days === undefined || days === null ? DEFAULT_EXPIRY_DAYS : Number(days);
  if (!Number.isFinite(n) || n < 1) {
    throw new ApiError(400, 'Expiry must be at least one day');
  }
  if (n > MAX_EXPIRY_DAYS) {
    throw new ApiError(400, `Tokens can last at most ${MAX_EXPIRY_DAYS} days`);
  }
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

/**
 * Clean a requested scope list: known keys only, no duplicates, and nothing
 * non-delegable — asking for one is rejected outright rather than silently
 * dropped, so nobody ships a token believing it can rotate the CA.
 */
export function normalizeScopes(scopes) {
  if (!scopes) return [];
  const list = Array.isArray(scopes) ? scopes : [scopes];
  const out = [];
  for (const raw of list) {
    const key = String(raw || '').trim();
    if (!key) continue;
    if (!isPermission(key)) throw new ApiError(400, `Unknown permission: ${key}`);
    if (NON_DELEGABLE.has(key)) {
      throw new ApiError(400, `'${key}' can't be given to an API token — it stays something a person does`, {
        code: 'PERMISSION_NOT_DELEGABLE',
      });
    }
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

async function assertRoom(userId) {
  const live = await prisma.apiToken.count({ where: { userId, revokedAt: null } });
  if (live >= MAX_TOKENS_PER_USER) {
    throw new ApiError(409, `That identity already has ${MAX_TOKENS_PER_USER} active tokens — revoke one first`);
  }
}

/**
 * Mint a token.
 *
 * @returns {Promise<{token: string, apiToken: object}>} `token` is the
 *   plaintext, returned once and never again.
 */
export async function create(orgId, { userId, kind, name, description, scopes, expiresInDays }, actor = null) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new ApiError(400, 'Name is required');

  const user = await prisma.user.findFirst({ where: { id: userId, orgId }, select: { id: true, kind: true, status: true } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.status !== 'active') throw new ApiError(409, 'That identity is not active');
  if (kind === 'service' && user.kind !== 'service') throw new ApiError(400, 'Not a service account');
  if (kind === 'personal' && user.kind !== 'human') throw new ApiError(400, 'Not a person');

  await assertRoom(userId);

  const { token, hash, prefix } = generateApiToken(kind);
  const row = await prisma.apiToken.create({
    data: {
      orgId,
      userId,
      kind,
      name: trimmed,
      description: description ? String(description).trim() : null,
      tokenHash: hash,
      tokenPrefix: prefix,
      scopes: normalizeScopes(scopes),
      expiresAt: expiryFrom(expiresInDays),
      createdById: actor?.userId ?? null,
    },
  });

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.api_token.create,
    resourceType: 'ApiToken',
    resourceId: row.id,
    metadata: {
      name: row.name,
      kind,
      forUserId: userId,
      scopes: row.scopes,
      // ISO string: a Date lands in the JSON metadata column as {}.
      expiresAt: row.expiresAt.toISOString(),
    },
  });

  logger.info('apiTokenService.create: token issued', { orgId, tokenId: row.id, kind, userId });
  return { token, apiToken: toPublic(row) };
}

/** Tokens belonging to one identity, newest first. Revoked ones are kept. */
export async function listForUser(orgId, userId) {
  const rows = await prisma.apiToken.findMany({
    where: { orgId, userId },
    orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
  });
  return rows.map(toPublic);
}

async function loadOwned(orgId, tokenId, userId = null) {
  const row = await prisma.apiToken.findFirst({
    where: { id: tokenId, orgId, ...(userId ? { userId } : {}) },
  });
  if (!row) throw new ApiError(404, 'Token not found');
  return row;
}

/**
 * Replace a token's secret, keeping its name, scopes and expiry.
 *
 * There is deliberately no grace window where both secrets work: the old one
 * stops the moment this returns. Overlapping validity means a second hash to
 * check on every request and a "which one is live?" question nobody can
 * answer — create a second token and delete the first if you need to hand
 * over without downtime.
 */
export async function rotate(orgId, tokenId, { userId = null } = {}, actor = null) {
  const existing = await loadOwned(orgId, tokenId, userId);
  if (existing.revokedAt) throw new ApiError(409, 'That token has been revoked');

  const { token, hash, prefix } = generateApiToken(existing.kind);
  const row = await prisma.apiToken.update({
    where: { id: existing.id },
    data: { tokenHash: hash, tokenPrefix: prefix, rotatedAt: new Date(), lastUsedAt: null, lastUsedIp: null },
  });

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.api_token.rotate,
    resourceType: 'ApiToken',
    resourceId: row.id,
    metadata: { name: row.name, kind: row.kind, forUserId: row.userId },
  });

  logger.info('apiTokenService.rotate: token rotated', { orgId, tokenId: row.id });
  return { token, apiToken: toPublic(row) };
}

/**
 * Revoke a token. The row stays so the audit trail keeps its name — a
 * deleted row would leave "which credential did this?" unanswerable.
 */
export async function revoke(orgId, tokenId, { userId = null, reason = null } = {}, actor = null) {
  const existing = await loadOwned(orgId, tokenId, userId);
  if (existing.revokedAt) return toPublic(existing);

  const row = await prisma.apiToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date(), revokedById: actor?.userId ?? null, revokedReason: reason },
  });

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.api_token.revoke,
    resourceType: 'ApiToken',
    resourceId: row.id,
    metadata: { name: row.name, kind: row.kind, forUserId: row.userId, reason },
  });

  logger.info('apiTokenService.revoke: token revoked', { orgId, tokenId: row.id });
  return toPublic(row);
}

/** Revoke every live token of an identity. Used when one is disabled. */
export async function revokeAllForUser(orgId, userId, reason, actor = null) {
  const { count } = await prisma.apiToken.updateMany({
    where: { orgId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: actor?.userId ?? null, revokedReason: reason },
  });
  if (count) logger.info('apiTokenService.revokeAllForUser', { orgId, userId, count, reason });
  return count;
}

export default {
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  toPublic,
  expiryFrom,
  normalizeScopes,
  create,
  listForUser,
  rotate,
  revoke,
  revokeAllForUser,
};
