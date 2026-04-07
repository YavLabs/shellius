/**
 * inviteService.js
 *
 * Manages one-time tokens for user invites and password resets.
 *
 * Security model:
 *   - 32 random bytes → hex string → raw token (returned to caller once)
 *   - sha256(rawToken) → stored in user_tokens.token_hash (never the raw value)
 *   - Tokens are single-use (usedAt is set on first successful consume)
 *   - Tokens auto-expire (expiresAt checked on consume)
 *   - Public URL helper reads TRAEFIK_HOST / PUBLIC_API_URL / VITE_API_URL
 *     so callers do not have to pass a request object into the service.
 */

import crypto from 'crypto';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

export const TOKEN_TYPES = {
  INVITE: 'invite',
  PASSWORD_RESET: 'password_reset',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Derive the public-facing base URL using the same env-var priority as
 * bootstrap.js so all generated links are consistent.
 *
 * @param {import('express').Request|null} req - Optional; falls back to env vars.
 * @returns {string}
 */
export function getPublicBaseUrl(req = null) {
  const strip = (u) => String(u).replace(/\/$/, '').replace(/\/api$/, '');

  if (process.env.TRAEFIK_HOST) return `https://${process.env.TRAEFIK_HOST}`;
  if (process.env.PUBLIC_API_URL) return strip(process.env.PUBLIC_API_URL);
  if (process.env.VITE_API_URL) return strip(process.env.VITE_API_URL);

  if (req) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}`;
  }

  return 'http://localhost:3000';
}

/**
 * Build the frontend URL for an invite or password-reset token.
 * The path is on the *frontend* app, not the API.
 *
 * @param {'invite'|'password_reset'} type
 * @param {string} rawToken
 * @param {import('express').Request|null} req
 * @returns {string}
 */
export function buildTokenUrl(type, rawToken, req = null) {
  const base = getPublicBaseUrl(req);
  const path = type === TOKEN_TYPES.INVITE ? 'invite' : 'password-reset';
  return `${base}/${path}/${rawToken}`;
}

// ---------------------------------------------------------------------------
// createInvite
// ---------------------------------------------------------------------------

/**
 * Generate a new one-time token and persist its sha256 hash.
 * Any previous unused tokens of the same type for this user are revoked first.
 *
 * @param {string} userId
 * @param {'invite'|'password_reset'} type
 * @param {number} ttlHours
 * @returns {Promise<{ rawToken: string, expiresAt: Date }>}
 */
export async function createInvite(userId, type, ttlHours) {
  // Revoke previous unused tokens of the same type for this user
  await revokeAllForUser(userId, type);

  const rawToken = crypto.randomBytes(32).toString('hex'); // 64 hex chars
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  await prisma.userToken.create({
    data: {
      userId,
      type,
      tokenHash,
      expiresAt,
    },
  });

  return { rawToken, expiresAt };
}

// ---------------------------------------------------------------------------
// verifyAndConsume
// ---------------------------------------------------------------------------

/**
 * Validate a raw token (by its sha256 hash), check expiry and single-use,
 * mark it as used, and return the associated user.
 *
 * Throws ApiError(400) for any invalid / expired / already-used state so that
 * the caller can surface a clear error without leaking which check failed.
 *
 * @param {string} rawToken  - The 64-char hex token from the URL
 * @param {'invite'|'password_reset'} type
 * @returns {Promise<import('@prisma/client').User>}
 */
export async function verifyAndConsume(rawToken, type) {
  if (!rawToken || rawToken.length !== 64) {
    throw new ApiError(400, 'Invalid or expired token');
  }

  const tokenHash = sha256(rawToken);

  const record = await prisma.userToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: { organization: true },
      },
    },
  });

  if (!record || record.type !== type) {
    throw new ApiError(400, 'Invalid or expired token');
  }

  if (record.usedAt !== null) {
    throw new ApiError(400, 'Token has already been used');
  }

  if (record.expiresAt < new Date()) {
    throw new ApiError(400, 'Token has expired');
  }

  // Mark as used — single-use enforcement
  await prisma.userToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  return record.user;
}

/**
 * Peek at a token without consuming it. Used for the GET endpoints that render
 * a confirmation page before the user submits the form.
 *
 * @param {string} rawToken
 * @param {'invite'|'password_reset'} type
 * @returns {Promise<import('@prisma/client').User>}
 */
export async function verifyWithoutConsuming(rawToken, type) {
  if (!rawToken || rawToken.length !== 64) {
    throw new ApiError(400, 'Invalid or expired token');
  }

  const tokenHash = sha256(rawToken);

  const record = await prisma.userToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: { organization: true },
      },
    },
  });

  if (!record || record.type !== type) {
    throw new ApiError(400, 'Invalid or expired token');
  }

  if (record.usedAt !== null) {
    throw new ApiError(400, 'Token has already been used');
  }

  if (record.expiresAt < new Date()) {
    throw new ApiError(400, 'Token has expired');
  }

  return record.user;
}

// ---------------------------------------------------------------------------
// revokeAllForUser
// ---------------------------------------------------------------------------

/**
 * Soft-invalidate all unused tokens of a given type for a user by setting
 * expiresAt to now (so verifyAndConsume will reject them).
 *
 * @param {string} userId
 * @param {'invite'|'password_reset'} type
 */
export async function revokeAllForUser(userId, type) {
  await prisma.userToken.updateMany({
    where: {
      userId,
      type,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { expiresAt: new Date() },
  });
}

export default { TOKEN_TYPES, createInvite, verifyAndConsume, verifyWithoutConsuming, revokeAllForUser, buildTokenUrl, getPublicBaseUrl };
