import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import prisma from '../config/db.js';
import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  hashToken,
} from '../utils/jwt.js';
import * as mfaService from './mfaService.js';
import { log as auditLog, ACTIONS } from './auditService.js';
import * as terminalService from './terminalService.js';
import logger from '../utils/logger.js';
import { permissionsForUser } from './roleService.js';
import { isVaultEnabled } from './orgService.js';

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// A fixed, precomputed bcrypt hash compared against on every "unknown
// account" login attempt so the request takes roughly the same amount of
// time as a real password check — defends against email-enumeration via
// response timing. Computed once at module load (bcrypt is intentionally
// slow; doing this per-request would be wasteful).
const DUMMY_HASH = bcrypt.hashSync('shellius-dummy-password-for-timing-safety', config.bcryptRounds);
async function dummyCompare(password) {
  try {
    await bcrypt.compare(String(password || ''), DUMMY_HASH);
  } catch {
    /* ignore */
  }
}

function stripUser(user) {
  if (!user) return user;
  const { passwordHash, mfaTotpSecretEnc, mfaTotpPendingEnc, mfaBackupCodes, ssoSub, ...rest } = user;
  return rest;
}

function maskEmail(email) {
  const [u, d] = String(email).split('@');
  if (!d) return email;
  return `${u.slice(0, 2)}***@${d}`;
}

function invalidCredentials() {
  return new ApiError(401, 'Invalid email or password', { code: 'INVALID_CREDENTIALS' });
}

/**
 * Role + effective permissions for the client (docs/rbac): the UI gates on
 * `permissions`, never on the role name. `role` stays the base tier for
 * older clients (the CLI).
 */
async function accessOf(user) {
  const assigned =
    user.assignedRole !== undefined
      ? user.assignedRole
      : user.roleId
        ? await prisma.role.findFirst({ where: { id: user.roleId, orgId: user.orgId } })
        : null;
  return {
    roleInfo: assigned
      ? { id: assigned.id, key: assigned.key, name: assigned.name, isSystem: assigned.isSystem, baseRole: assigned.baseRole }
      : null,
    permissions: permissionsForUser({ ...user, assignedRole: assigned }),
    // Org switches the UI needs alongside permissions.
    features: { personalVault: await isVaultEnabled(user.orgId) },
  };
}

async function userDto(user) {
  const safe = stripUser(user);
  const { assignedRole: _r, ...rest } = safe;
  return {
    id: rest.id,
    email: rest.email,
    name: rest.name,
    role: rest.role,
    status: rest.status,
    orgId: rest.orgId,
    organization: rest.organization,
    avatarUrl: rest.avatarUrl,
    ...(await accessOf(user)),
  };
}

// ---------------------------------------------------------------------------
// Lockout helpers
// ---------------------------------------------------------------------------

async function recordFailedLogin(user, ipAddress, userAgent) {
  const threshold = config.auth.lockoutThreshold;
  const newCount = (user.failedLoginCount || 0) + 1;
  const data = { failedLoginCount: newCount, lastFailedLoginAt: new Date() };
  let locked = false;
  if (newCount >= threshold) {
    data.lockedUntil = new Date(Date.now() + config.auth.lockoutMinutes * 60 * 1000);
    data.failedLoginCount = 0;
    locked = true;
  }
  await prisma.user.update({ where: { id: user.id }, data });
  if (locked) {
    await auditLog({
      orgId: user.orgId,
      actorId: user.id,
      action: ACTIONS.auth.account_locked,
      resourceType: 'User',
      resourceId: user.id,
      ipAddress,
      userAgent,
    });
  }
}

async function resetFailedLogin(user) {
  if (user.failedLoginCount || user.lockedUntil) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
  }
}

// ---------------------------------------------------------------------------
// Refresh-token family helpers
// ---------------------------------------------------------------------------

/** Revoke every non-revoked refresh token row belonging to a family. */
export async function revokeFamily(familyId) {
  if (!familyId) return;
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revoke ALL refresh-token families for a user (does not touch sessionsValidFrom). */
export async function revokeAllFamiliesForUser(userId) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revoke every family for a user except the one supplied (self-service "sign out other devices"). */
export async function revokeOtherFamilies(userId, keepFamilyId) {
  const rows = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null },
    select: { familyId: true },
    distinct: ['familyId'],
  });
  const families = [...new Set(rows.map((r) => r.familyId).filter((f) => f && f !== keepFamilyId))];
  for (const fid of families) {
    await revokeFamily(fid);
  }
  return families.length;
}

/**
 * Bump sessionsValidFrom — every access token issued before "now" becomes
 * invalid immediately.
 *
 * Truncated to whole seconds because JWT `iat` is second-precision: a token
 * minted right after the bump (e.g. the fresh pair returned by password
 * change/reset) shares the same second and must stay valid. Tokens from the
 * same second *before* the bump survive too — an accepted sub-second window.
 */
export async function bumpSessionsValidFrom(userId) {
  const nowSec = new Date(Math.floor(Date.now() / 1000) * 1000);
  await prisma.user.update({ where: { id: userId }, data: { sessionsValidFrom: nowSec } });
}

/**
 * Full "sign out everywhere" — revokes every session and invalidates every
 * outstanding access token. Used by password change/reset, role change,
 * suspend/deactivate/delete, and admin-triggered revoke-sessions.
 *
 * Also ends any live terminal (SSH/RDP) sessions for the user immediately —
 * otherwise a revoked user could keep using an already-open shell until it
 * happened to close (B-3 hardening). `orgId` is optional only for legacy
 * call sites; omitting it skips the live-session kill, so pass it whenever
 * available.
 */
export async function revokeAllSessions(userId, orgId, reason = 'session_revoked') {
  await revokeAllFamiliesForUser(userId);
  await bumpSessionsValidFrom(userId);
  if (orgId) {
    try {
      await terminalService.endAllSessionsForUser(orgId, userId, reason);
    } catch (err) {
      logger.warn('authService.revokeAllSessions: failed to end live terminal sessions', {
        userId,
        orgId,
        error: err.message,
      });
    }
  }
}

async function cleanupOldRevoked(familyId) {
  if (!familyId) return;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    await prisma.refreshToken.deleteMany({ where: { familyId, revokedAt: { lt: cutoff } } });
  } catch {
    /* best-effort cleanup only */
  }
}

// ---------------------------------------------------------------------------
// Session issuance
// ---------------------------------------------------------------------------

/**
 * Issue a full session (access + refresh tokens) for an authenticated user,
 * starting a brand-new refresh-token family. Shared by password login, MFA
 * verify, SSO exchange, device auth, password reset and invite accept.
 */
export async function issueSession(user, ipAddress, userAgent, clientType = 'web') {
  const fid = crypto.randomUUID();
  const accessToken = generateAccessToken({
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
    email: user.email,
    fid,
  });
  const tokenId = crypto.randomUUID();
  const refreshToken = generateRefreshToken({ userId: user.id, tokenId, fid });
  const now = new Date();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      clientType,
      ipAddress,
      userAgent,
      familyId: fid,
      sessionStartedAt: now,
      lastUsedAt: now,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
  return {
    accessToken,
    refreshToken,
    user: await userDto(user),
  };
}

// ---------------------------------------------------------------------------
// MFA gate — shared by password login, SSO, password-reset and invite-accept
// ---------------------------------------------------------------------------

/**
 * Decide whether MFA gates this login. Returns a challenge response, or null
 * to proceed with a normal session. MFA is required whenever the USER has a
 * factor enrolled, regardless of the org's `enabled` flag.
 */
export async function mfaGate(user) {
  const methods = mfaService.availableMethods(user);
  if (methods.length === 0) return null;
  return {
    mfaRequired: true,
    mfaToken: mfaService.issueMfaToken(user),
    methods,
    emailHint: maskEmail(user.email),
  };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function login(email, password, ipAddress, userAgent) {
  const normalizedEmail = String(email || '').trim().toLowerCase();

  // Email is unique PER ORG, not globally — the same address may belong to
  // more than one organization. Gather every non-deleted candidate and check
  // the password against each one that has a local password set.
  const candidates = await prisma.user.findMany({
    where: { email: normalizedEmail, status: { not: 'deleted' } },
    include: { organization: true },
  });

  if (candidates.length === 0) {
    await dummyCompare(password);
    throw invalidCredentials();
  }

  const withPassword = candidates.filter((c) => !!c.passwordHash);
  if (withPassword.length === 0) {
    await dummyCompare(password);
    throw invalidCredentials();
  }

  let matched = null;
  let lockedCandidate = null;
  for (const candidate of withPassword) {
    if (candidate.lockedUntil && candidate.lockedUntil > new Date()) {
      if (!lockedCandidate) lockedCandidate = candidate;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const ok = await bcrypt.compare(password, candidate.passwordHash);
    if (ok) {
      matched = candidate;
      break;
    }
  }

  if (!matched) {
    if (lockedCandidate) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((lockedCandidate.lockedUntil.getTime() - Date.now()) / 1000)
      );
      throw new ApiError(423, 'Account is locked due to too many failed sign-in attempts', {
        code: 'ACCOUNT_LOCKED',
        details: { retryAfterSeconds },
      });
    }

    await Promise.all(withPassword.map((c) => recordFailedLogin(c, ipAddress, userAgent)));
    const primary = withPassword[0];
    await auditLog({
      orgId: primary.orgId,
      actorId: null,
      action: ACTIONS.auth.login_failed,
      resourceType: 'User',
      resourceId: primary.id,
      metadata: { email: normalizedEmail },
      ipAddress,
      userAgent,
    });
    throw invalidCredentials();
  }

  if (matched.status !== 'active') {
    throw new ApiError(403, 'Account is disabled', { code: 'ACCOUNT_DISABLED' });
  }

  await resetFailedLogin(matched);
  await auditLog({
    orgId: matched.orgId,
    actorId: matched.id,
    action: ACTIONS.auth.login,
    resourceType: 'User',
    resourceId: matched.id,
    ipAddress,
    userAgent,
  });

  const gate = await mfaGate(matched);
  if (gate) return gate;

  return issueSession(matched, ipAddress, userAgent, 'web');
}

/**
 * Complete a login's MFA challenge: verify the second factor and issue a
 * full session. Used by POST /auth/mfa/verify (and internally for
 * SSO/password-reset/invite flows that also gate on MFA).
 */
export async function completeMfaLogin({ mfaToken, method, code, ipAddress, userAgent }) {
  const payload = mfaService.verifyMfaToken(mfaToken);
  if (!payload) {
    throw new ApiError(401, 'MFA session expired — sign in again', { code: 'MFA_CHALLENGE_EXPIRED' });
  }

  const burned = await mfaService.isChallengeBurned(payload.jti);
  if (burned) {
    throw new ApiError(429, 'Too many attempts — sign in again', { code: 'MFA_TOO_MANY_ATTEMPTS' });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    include: { organization: true },
  });
  if (!user || user.status !== 'active' || user.orgId !== payload.orgId) {
    throw new ApiError(401, 'MFA session expired — sign in again', { code: 'MFA_CHALLENGE_EXPIRED' });
  }

  const throttled = await mfaService.isUserThrottled(user.id);
  if (throttled) {
    throw new ApiError(429, 'Too many attempts — sign in again', { code: 'MFA_TOO_MANY_ATTEMPTS' });
  }

  const ok = await mfaService.verifyFactor(user, method, code);
  if (!ok) {
    const { burned: nowBurned, attemptsRemaining } = await mfaService.recordChallengeFailure(payload.jti);
    await auditLog({
      orgId: user.orgId,
      actorId: user.id,
      action: ACTIONS.auth.mfa_failed,
      resourceType: 'User',
      resourceId: user.id,
      metadata: { method },
      ipAddress,
      userAgent,
    });
    if (nowBurned) {
      throw new ApiError(429, 'Too many attempts — sign in again', { code: 'MFA_TOO_MANY_ATTEMPTS' });
    }
    throw new ApiError(401, 'Invalid verification code', { code: 'MFA_INVALID', details: { attemptsRemaining } });
  }

  await mfaService.clearChallengeAttempts(payload.jti);
  return issueSession(user, ipAddress, userAgent, 'web');
}

/**
 * Inspect an email's login state so the UI can branch the email-first login
 * flow (password field vs SSO vs invite). Returns a deliberately small shape
 * and never reveals whether the account exists for non-password states.
 *
 * @param {string} email
 * @returns {Promise<{ hasPassword: boolean, ssoLinked: boolean }>}
 */
export async function getLoginState(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const users = await prisma.user.findMany({
    where: { email: normalizedEmail, status: { not: 'deleted' } },
    select: { passwordHash: true, ssoProvider: true },
  });
  if (users.length === 0) {
    return { hasPassword: false, ssoLinked: false };
  }
  return {
    hasPassword: users.some((u) => !!u.passwordHash),
    ssoLinked: users.some((u) => !!u.ssoProvider),
  };
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

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
    throw new ApiError(401, 'Invalid refresh token');
  }

  const now = new Date();

  if (stored.revokedAt) {
    const msSinceRevoke = now.getTime() - stored.revokedAt.getTime();
    if (msSinceRevoke <= config.auth.refreshReuseGraceMs) {
      // Benign race: client fired two refreshes back-to-back. Reject without
      // wiping the session; the client already holds the rotated token.
      throw new ApiError(409, 'Refresh token already rotated; retry');
    }
    // Reuse outside the grace window — treat as theft. Kill the whole family.
    if (stored.familyId) {
      await revokeFamily(stored.familyId);
    } else {
      await prisma.refreshToken.deleteMany({ where: { userId: stored.userId } });
    }
    const owner = await prisma.user.findUnique({ where: { id: stored.userId }, select: { orgId: true } });
    if (owner?.orgId) {
      await auditLog({
        orgId: owner.orgId,
        actorId: stored.userId,
        action: ACTIONS.auth.refresh_reuse,
        resourceType: 'User',
        resourceId: stored.userId,
        ipAddress,
        userAgent,
      });
    }
    throw new ApiError(401, 'Invalid refresh token');
  }

  if (stored.expiresAt < now) {
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: now } });
    throw new ApiError(401, 'Refresh token expired');
  }

  if (
    stored.sessionStartedAt &&
    now.getTime() - stored.sessionStartedAt.getTime() > config.auth.sessionAbsoluteTtlMs
  ) {
    if (stored.familyId) await revokeFamily(stored.familyId);
    throw new ApiError(401, 'Session expired — please sign in again');
  }

  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  if (!user || user.status !== 'active') {
    throw new ApiError(401, 'Account is not active');
  }

  if (
    user.sessionsValidFrom &&
    stored.sessionStartedAt &&
    stored.sessionStartedAt.getTime() < user.sessionsValidFrom.getTime()
  ) {
    if (stored.familyId) await revokeFamily(stored.familyId);
    throw new ApiError(401, 'Session has been revoked — please sign in again', { code: 'SESSION_REVOKED' });
  }

  const fid = stored.familyId || crypto.randomUUID();
  const accessToken = generateAccessToken({
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
    email: user.email,
    fid,
  });

  const tokenId = crypto.randomUUID();
  const newRefreshToken = generateRefreshToken({ userId: user.id, tokenId, fid });

  await prisma.$transaction(async (tx) => {
    const row = await tx.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(newRefreshToken),
        clientType: stored.clientType || 'web',
        ipAddress,
        userAgent,
        familyId: fid,
        sessionStartedAt: stored.sessionStartedAt || now,
        lastUsedAt: now,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    await tx.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: now, replacedById: row.id },
    });
  });

  cleanupOldRevoked(fid).catch(() => {});

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(refreshTokenString) {
  if (!refreshTokenString) return true;
  const tokenHash = hashToken(refreshTokenString);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored) return true;
  if (stored.familyId) {
    await revokeFamily(stored.familyId);
  } else {
    await prisma.refreshToken.deleteMany({ where: { tokenHash } });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sessions (refresh-token families) — self-service listing/revocation
// ---------------------------------------------------------------------------

export async function listSessions(userId, currentFamilyId) {
  const rows = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { sessionStartedAt: 'desc' },
  });

  const byFamily = new Map();
  for (const row of rows) {
    const fid = row.familyId || row.id;
    const existing = byFamily.get(fid);
    if (!existing || (row.lastUsedAt || row.createdAt) > (existing.lastUsedAt || existing.createdAt)) {
      byFamily.set(fid, row);
    }
  }

  return [...byFamily.entries()].map(([fid, row]) => ({
    id: fid,
    clientType: row.clientType,
    userAgent: row.userAgent,
    ipAddress: row.ipAddress,
    createdAt: row.sessionStartedAt || row.createdAt,
    lastUsedAt: row.lastUsedAt || row.createdAt,
    expiresAt: row.expiresAt,
    current: fid === currentFamilyId,
  }));
}

export async function revokeSessionForUser(userId, familyId) {
  const owns = await prisma.refreshToken.findFirst({ where: { userId, familyId } });
  if (!owns) throw new ApiError(404, 'Session not found');
  await revokeFamily(familyId);
  return true;
}

export async function revokeOtherSessionsForUser(userId, currentFamilyId) {
  const revoked = await revokeOtherFamilies(userId, currentFamilyId);
  return revoked;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getProfile(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { organization: true },
  });
  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  // getEffective is imported lazily to avoid a circular import at module
  // load time (mfaConfigService has no dependency on authService, but this
  // keeps the import graph obviously acyclic).
  const { getEffective } = await import('./mfaConfigService.js');
  const cfg = await getEffective(user.orgId);
  const enrolled = mfaService.hasFactor(user);

  return {
    ...stripUser(user),
    ...(await accessOf(user)),
    mfaSetupRequired: !!(cfg.enforced && !enrolled),
    mfa: {
      totpEnabled: !!user.mfaTotpEnabled,
      emailEnabled: !!user.mfaEmailEnabled,
      backupCodesRemaining: (user.mfaBackupCodes || []).length,
    },
    hasPassword: !!user.passwordHash,
    ssoProvider: user.ssoProvider || null,
  };
}

export default {
  login,
  mfaGate,
  completeMfaLogin,
  getLoginState,
  issueSession,
  refresh,
  logout,
  getProfile,
  listSessions,
  revokeSessionForUser,
  revokeOtherSessionsForUser,
  revokeFamily,
  revokeAllFamiliesForUser,
  revokeOtherFamilies,
  revokeAllSessions,
  bumpSessionsValidFrom,
};
