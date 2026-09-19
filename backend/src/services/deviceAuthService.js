import crypto from 'crypto';
import prisma from '../config/db.js';
import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import * as authService from './authService.js';

const SAFE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEVICE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL = 5;
const FRONTEND_URL = config.frontendUrl;

// deviceCode is a bearer-style credential (whoever holds it can complete the
// login), so it is stored hashed — the raw UUID is only ever returned to the
// polling client, never persisted. Lookups hash the incoming value and match
// against the stored hash. SHA-256 (not bcrypt) is appropriate here: the
// input is a high-entropy random UUID, not a low-entropy human secret, so
// there's nothing for an offline dictionary attack to exploit.
function hashDeviceCode(deviceCode) {
  return crypto.createHash('sha256').update(deviceCode).digest('hex');
}

export function generateUserCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += SAFE_ALPHABET[bytes[i] % SAFE_ALPHABET.length];
  }
  return out;
}

export async function createDeviceRequest(orgSlug, clientId, scope) {
  const org = await prisma.organization.findUnique({ where: { slug: orgSlug } });
  if (!org) throw new ApiError(404, 'Organization not found');

  const deviceCode = crypto.randomUUID();

  // Retry user-code generation on (extremely rare) collision
  let userCode;
  for (let i = 0; i < 5; i++) {
    const candidate = generateUserCode();
    const existing = await prisma.deviceAuthRequest.findUnique({ where: { userCode: candidate } });
    if (!existing) {
      userCode = candidate;
      break;
    }
  }
  if (!userCode) throw new ApiError(500, 'Failed to generate unique user code');

  const expiresAt = new Date(Date.now() + DEVICE_TTL_MS);

  await prisma.deviceAuthRequest.create({
    data: {
      deviceCode: hashDeviceCode(deviceCode),
      userCode,
      clientId: clientId || 'shellius-tui',
      scope: scope || '',
      orgId: org.id,
      status: 'pending',
      interval: DEFAULT_INTERVAL,
      expiresAt,
    },
  });

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${FRONTEND_URL}/device`,
    verification_uri_complete: `${FRONTEND_URL}/device?user_code=${userCode}`,
    expires_in: Math.floor(DEVICE_TTL_MS / 1000),
    interval: DEFAULT_INTERVAL,
  };
}

export async function pollDeviceRequest(deviceCode, ipAddress, userAgent) {
  const req = await prisma.deviceAuthRequest.findUnique({
    where: { deviceCode: hashDeviceCode(deviceCode) },
  });
  if (!req) throw new ApiError(400, 'invalid_grant');

  const now = new Date();
  if (req.status === 'expired' || req.expiresAt < now) {
    if (req.status !== 'expired') {
      await prisma.deviceAuthRequest.update({
        where: { id: req.id },
        data: { status: 'expired' },
      });
    }
    throw new ApiError(410, 'expired_token');
  }

  if (req.lastPollAt) {
    const diffSec = (now.getTime() - req.lastPollAt.getTime()) / 1000;
    if (diffSec < req.interval) {
      throw new ApiError(429, 'slow_down');
    }
  }

  await prisma.deviceAuthRequest.update({
    where: { id: req.id },
    data: { lastPollAt: now },
  });

  if (req.status === 'denied') throw new ApiError(403, 'access_denied');
  if (req.status === 'pending') throw new ApiError(428, 'authorization_pending');

  if (req.status === 'approved') {
    if (!req.userId) throw new ApiError(500, 'approved request missing user');
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || user.status !== 'active') throw new ApiError(403, 'access_denied');

    // Device-auth issued tokens get their own refresh-token family, same as
    // password/SSO/MFA logins, so they participate in rotation/reuse
    // detection and show up in GET /api/auth/sessions.
    const session = await authService.issueSession(user, ipAddress, userAgent, 'tui');

    await prisma.deviceAuthRequest.delete({ where: { id: req.id } });

    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: user.orgId,
        // Role name and permissions (e.g. access.prod_bypass) so the CLI can
        // show the right access status instead of guessing from the role.
        roleName: session.user.roleInfo?.name || null,
        permissions: session.user.permissions,
      },
    };
  }

  throw new ApiError(400, 'invalid_grant');
}

export async function approveDeviceRequest(userCode, userId) {
  const code = String(userCode || '').toUpperCase();
  const req = await prisma.deviceAuthRequest.findUnique({ where: { userCode: code } });
  if (!req) throw new ApiError(404, 'Device request not found');
  if (req.status !== 'pending') throw new ApiError(400, 'Device request is not pending');
  if (req.expiresAt < new Date()) throw new ApiError(410, 'Device request expired');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(401, 'User not found');
  if (user.orgId !== req.orgId) throw new ApiError(403, 'Org mismatch');

  await prisma.deviceAuthRequest.update({
    where: { id: req.id },
    data: { status: 'approved', userId },
  });

  return { success: true };
}

export async function denyDeviceRequest(userCode, userId) {
  const code = String(userCode || '').toUpperCase();
  const req = await prisma.deviceAuthRequest.findUnique({ where: { userCode: code } });
  if (!req) throw new ApiError(404, 'Device request not found');
  if (req.status !== 'pending') throw new ApiError(400, 'Device request is not pending');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.orgId !== req.orgId) throw new ApiError(403, 'Org mismatch');

  await prisma.deviceAuthRequest.update({
    where: { id: req.id },
    data: { status: 'denied', userId },
  });

  return { success: true };
}

export default {
  generateUserCode,
  createDeviceRequest,
  pollDeviceRequest,
  approveDeviceRequest,
  denyDeviceRequest,
};
