import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  hashToken,
} from '../utils/jwt.js';

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function stripUser(user) {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
}

export async function login(email, password, ipAddress, userAgent) {
  const user = await prisma.user.findFirst({
    where: { email },
    include: { organization: true },
  });

  if (!user) {
    throw new ApiError(401, 'Invalid email or password');
  }

  if (!user.passwordHash) {
    throw new ApiError(401, 'Invalid email or password');
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    throw new ApiError(401, 'Invalid email or password');
  }

  if (user.status !== 'active') {
    throw new ApiError(403, 'Account is not active');
  }

  const accessToken = generateAccessToken({
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
    email: user.email,
  });

  const tokenId = crypto.randomUUID();
  const refreshToken = generateRefreshToken({ userId: user.id, tokenId });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      clientType: 'web',
      ipAddress,
      userAgent,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const safe = stripUser(user);
  return {
    accessToken,
    refreshToken,
    user: {
      id: safe.id,
      email: safe.email,
      name: safe.name,
      role: safe.role,
      status: safe.status,
      orgId: safe.orgId,
      organization: safe.organization,
    },
  };
}

export async function refresh(refreshTokenString, ipAddress, userAgent) {
  let decoded;
  try {
    decoded = verifyRefreshToken(refreshTokenString);
  } catch (err) {
    throw new ApiError(401, 'Invalid or expired refresh token');
  }

  const tokenHash = hashToken(refreshTokenString);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!stored) {
    // Possible token reuse — revoke all tokens for this user
    if (decoded?.userId) {
      await prisma.refreshToken.deleteMany({ where: { userId: decoded.userId } });
    }
    throw new ApiError(401, 'Invalid refresh token');
  }

  if (stored.expiresAt < new Date()) {
    await prisma.refreshToken.delete({ where: { id: stored.id } });
    throw new ApiError(401, 'Refresh token expired');
  }

  // Rotate: delete the old token
  await prisma.refreshToken.delete({ where: { id: stored.id } });

  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  if (!user || user.status !== 'active') {
    throw new ApiError(401, 'Account is not active');
  }

  const accessToken = generateAccessToken({
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
    email: user.email,
  });

  const tokenId = crypto.randomUUID();
  const newRefreshToken = generateRefreshToken({ userId: user.id, tokenId });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(newRefreshToken),
      clientType: stored.clientType || 'web',
      ipAddress,
      userAgent,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(refreshTokenString) {
  if (!refreshTokenString) return true;
  const tokenHash = hashToken(refreshTokenString);
  await prisma.refreshToken.deleteMany({ where: { tokenHash } });
  return true;
}

export async function getProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { organization: true },
  });
  if (!user) {
    throw new ApiError(404, 'User not found');
  }
  return stripUser(user);
}

export default { login, refresh, logout, getProfile };
