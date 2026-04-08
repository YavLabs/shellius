import crypto from 'crypto';
import prisma from '../config/db.js';
import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import { generateAccessToken, generateRefreshToken, hashToken } from '../utils/jwt.js';

const SAFE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEVICE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL = 5;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FRONTEND_URL = config.frontendUrl;

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
      deviceCode,
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
  const req = await prisma.deviceAuthRequest.findUnique({ where: { deviceCode } });
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

    const accessToken = generateAccessToken({
      userId: user.id,
      orgId: user.orgId,
      role: user.role,
      email: user.email,
    });
    const refreshToken = generateRefreshToken({
      userId: user.id,
      tokenId: crypto.randomUUID(),
    });

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        clientType: 'tui',
        ipAddress,
        userAgent,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });

    await prisma.deviceAuthRequest.delete({ where: { id: req.id } });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: user.orgId,
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
