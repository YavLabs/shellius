/**
 * mfaService — TOTP (authenticator app) + Email OTP second factor, backup
 * codes, and the short-lived MFA challenge token used during login.
 *
 * Secrets are AES-256-GCM encrypted at rest; backup codes are stored as sha256
 * hashes. Email OTPs are stored hashed in user_tokens with a short TTL.
 *
 * The login-time challenge token (`typ: 'mfa_challenge'`) is signed with an
 * HKDF-derived key distinct from the access-token signing key (see
 * utils/jwt.js) and rate-limited via Redis: 5 verification attempts per
 * challenge, then it is burned.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { getMfaChallengeKey } from '../utils/jwt.js';
import { sendMail } from './mailer.js';
import { renderTemplate } from '../email/index.js';
import redis from '../config/redis.js';

const ISSUER = process.env.MFA_ISSUER || 'Shellius';
const EMAIL_OTP_TYPE = 'mfa_email_otp';
const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_SEC = 5 * 60;
const MFA_MAX_ATTEMPTS = 5;
const EMAIL_OTP_MAX_SENDS_PER_CHALLENGE = 3;
const USER_THROTTLE_MAX = 15;
const USER_THROTTLE_WINDOW_SEC = 15 * 60;

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

// --- status -----------------------------------------------------------------

export function userMfaStatus(user) {
  const enrolled = !!(user.mfaTotpEnabled || user.mfaEmailEnabled);
  return {
    enrolled,
    totpEnabled: !!user.mfaTotpEnabled,
    emailEnabled: !!user.mfaEmailEnabled,
    totpPending: !!user.mfaTotpPendingEnc,
    backupCodesRemaining: (user.mfaBackupCodes || []).length,
    enrolledAt: user.mfaEnrolledAt || null,
  };
}

export function availableMethods(user) {
  const m = [];
  if (user.mfaTotpEnabled) m.push('totp');
  if (user.mfaEmailEnabled) m.push('email');
  if ((user.mfaBackupCodes || []).length > 0) m.push('backup');
  return m;
}

/** True when the user has ANY second factor enrolled (used to gate MFA
 * regardless of the org's `enabled` flag — see mfaGate in authService). */
export function hasFactor(user) {
  return !!user.mfaTotpEnabled || !!user.mfaEmailEnabled || (user.mfaBackupCodes || []).length > 0;
}

// --- TOTP enrollment ---------------------------------------------------------

/**
 * Begin (or restart) TOTP enrollment. Stores the new secret as *pending* —
 * an existing active/confirmed secret (mfaTotpSecretEnc) is left untouched
 * until confirmTotpEnroll succeeds, so a re-enrollment attempt can never
 * break a working authenticator mid-flow.
 */
export async function beginTotpEnroll(user) {
  const secret = authenticator.generateSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaTotpPendingEnc: encrypt(secret) },
  });
  const otpauth = authenticator.keyuri(user.email, ISSUER, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  return { secret, otpauthUrl: otpauth, qrDataUrl };
}

export async function confirmTotpEnroll(user, code) {
  if (!user.mfaTotpPendingEnc) throw new ApiError(400, 'Start TOTP setup first');
  const secret = decrypt(user.mfaTotpPendingEnc);
  if (!authenticator.check(String(code || '').trim(), secret)) {
    throw new ApiError(400, 'Invalid authenticator code');
  }

  const data = {
    mfaTotpSecretEnc: encrypt(secret),
    mfaTotpEnabled: true,
    mfaTotpPendingEnc: null,
    mfaEnrolledAt: user.mfaEnrolledAt || new Date(),
  };

  // Only mint new backup codes the first time a factor is enrolled — a
  // re-enrollment (already had codes) must not silently invalidate unused
  // ones the user may have saved.
  let backupCodes = null;
  if (!user.mfaBackupCodes || user.mfaBackupCodes.length === 0) {
    backupCodes = generateBackupCodes();
    data.mfaBackupCodes = backupCodes.map(hashBackupCode);
  }

  await prisma.user.update({ where: { id: user.id }, data });
  return { backupCodes }; // shown once, or null when codes already existed
}

export function verifyTotp(user, code) {
  if (!user.mfaTotpEnabled || !user.mfaTotpSecretEnc) return false;
  try {
    return authenticator.check(String(code || '').trim(), decrypt(user.mfaTotpSecretEnc));
  } catch {
    return false;
  }
}

// --- Email OTP ---------------------------------------------------------------

export async function enableEmailOtp(user) {
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaEmailEnabled: true, mfaEnrolledAt: user.mfaEnrolledAt || new Date() },
  });
}

/** Shared code generation/storage/send — bound to the user, single active code. */
async function dispatchEmailOtp(user) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.userToken.deleteMany({ where: { userId: user.id, type: EMAIL_OTP_TYPE } });
  await prisma.userToken.create({
    data: {
      userId: user.id,
      type: EMAIL_OTP_TYPE,
      tokenHash: sha256(`${user.id}:${code}`),
      expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_MS),
    },
  });
  try {
    const tpl = renderTemplate('mfaOtp', { recipientName: user.name, code, minutes: 10 });
    await sendMail({ orgId: user.orgId, to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  } catch (err) {
    logger.warn('mfaService: failed to send email OTP', { error: err.message });
  }
}

/**
 * Rate-limited per login challenge (jti) — at most
 * EMAIL_OTP_MAX_SENDS_PER_CHALLENGE sends. When `challengeJti` is omitted
 * (self-service, already-authenticated context) no rate limit is applied
 * beyond the natural one-code-at-a-time replace-on-send below.
 */
export async function sendEmailOtp(user, challengeJti = null) {
  if (challengeJti) {
    const key = `mfa:otp:send:${challengeJti}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, CHALLENGE_TTL_SEC);
    if (count > EMAIL_OTP_MAX_SENDS_PER_CHALLENGE) {
      logger.warn('mfaService: email OTP send rate-limited', { userId: user.id });
      return false;
    }
  }

  await dispatchEmailOtp(user);
  return true;
}

const SELF_OTP_COOLDOWN_SEC = 30;
const SELF_OTP_MAX_PER_WINDOW = 5;
const SELF_OTP_WINDOW_SEC = 15 * 60;

/**
 * Self-service email OTP send (POST /api/mfa/email/send-code) — used to
 * obtain a `{ method: 'email', code }` pair for disable/backup-codes
 * endpoints when the caller only has email MFA enrolled. Rate-limited to 1
 * per 30s and 5 per 15 minutes per user.
 *
 * @returns {Promise<{ sent: boolean }>}
 */
export async function sendSelfServiceEmailOtp(user) {
  const cooldownKey = `mfa:otp:selfcooldown:${user.id}`;
  const windowKey = `mfa:otp:selfwindow:${user.id}`;

  const onCooldown = await redis.get(cooldownKey);
  if (onCooldown) return { sent: false };

  const count = await redis.incr(windowKey);
  if (count === 1) await redis.expire(windowKey, SELF_OTP_WINDOW_SEC);
  if (count > SELF_OTP_MAX_PER_WINDOW) return { sent: false };

  await redis.set(cooldownKey, '1', 'EX', SELF_OTP_COOLDOWN_SEC);
  await dispatchEmailOtp(user);
  return { sent: true };
}

export async function verifyEmailOtp(user, code) {
  const hash = sha256(`${user.id}:${String(code || '').trim()}`);
  const rec = await prisma.userToken.findFirst({
    where: { userId: user.id, type: EMAIL_OTP_TYPE, tokenHash: hash, usedAt: null },
  });
  if (!rec || rec.expiresAt < new Date()) return false;
  await prisma.userToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } });
  return true;
}

// --- backup codes ------------------------------------------------------------

// 32-char alphabet (no 0/1/O/I) — 5 bits/char. 12 chars → 60 bits of entropy,
// formatted as XXXX-XXXX-XXXX for readability.
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateBackupCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(12);
    let s = '';
    for (let i = 0; i < 12; i++) s += BACKUP_ALPHABET[bytes[i] % BACKUP_ALPHABET.length];
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
  });
}

function normalizeBackupCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashBackupCode(code) {
  return sha256(normalizeBackupCode(code));
}

export async function regenerateBackupCodes(user) {
  const codes = generateBackupCodes();
  await prisma.user.update({ where: { id: user.id }, data: { mfaBackupCodes: codes.map(hashBackupCode) } });
  return codes;
}

export async function verifyBackupCode(user, code) {
  const hash = hashBackupCode(code);
  const codes = user.mfaBackupCodes || [];
  if (!codes.includes(hash)) return false;
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaBackupCodes: codes.filter((c) => c !== hash) },
  });
  return true;
}

// --- disable -----------------------------------------------------------------

export async function disableMfa(userId) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      mfaTotpEnabled: false,
      mfaEmailEnabled: false,
      mfaTotpSecretEnc: null,
      mfaTotpPendingEnc: null,
      mfaBackupCodes: [],
      mfaEnrolledAt: null,
    },
  });
}

// --- challenge token (login second-factor) -----------------------------------

export function issueMfaToken(user) {
  const jti = crypto.randomUUID();
  return jwt.sign(
    { typ: 'mfa_challenge', userId: user.id, orgId: user.orgId, jti },
    getMfaChallengeKey(),
    { expiresIn: CHALLENGE_TTL_SEC }
  );
}

export function verifyMfaToken(token) {
  try {
    const payload = jwt.verify(token, getMfaChallengeKey());
    if (payload.typ !== 'mfa_challenge') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify a second factor for a user. method ∈ totp | email | backup.
 * @returns {Promise<boolean>}
 */
export async function verifyFactor(user, method, code) {
  if (method === 'totp') return verifyTotp(user, code);
  if (method === 'email') return verifyEmailOtp(user, code);
  if (method === 'backup') return verifyBackupCode(user, code);
  return false;
}

// --- per-challenge / per-user attempt limiting (Redis) -----------------------

/**
 * Record a failed verification attempt against a login challenge (jti).
 * Once MFA_MAX_ATTEMPTS is reached the challenge is considered burned —
 * callers must reject it even if the underlying JWT hasn't expired yet.
 *
 * @returns {Promise<{ burned: boolean, attemptsRemaining: number }>}
 */
export async function recordChallengeFailure(jti) {
  const key = `mfa:attempts:${jti}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, CHALLENGE_TTL_SEC);
  return { burned: count >= MFA_MAX_ATTEMPTS, attemptsRemaining: Math.max(0, MFA_MAX_ATTEMPTS - count) };
}

export async function isChallengeBurned(jti) {
  const count = await redis.get(`mfa:attempts:${jti}`);
  return count != null && Number(count) >= MFA_MAX_ATTEMPTS;
}

export async function clearChallengeAttempts(jti) {
  await redis.del(`mfa:attempts:${jti}`);
}

/**
 * Coarser per-user throttle across challenges, so cycling through fresh
 * logins to reset the per-challenge counter doesn't allow unlimited guesses.
 * @returns {Promise<boolean>} true when the user has exceeded the window.
 */
export async function isUserThrottled(userId) {
  const key = `mfa:userattempts:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, USER_THROTTLE_WINDOW_SEC);
  return count > USER_THROTTLE_MAX;
}

export default {
  userMfaStatus,
  availableMethods,
  hasFactor,
  beginTotpEnroll,
  confirmTotpEnroll,
  verifyTotp,
  enableEmailOtp,
  sendEmailOtp,
  sendSelfServiceEmailOtp,
  verifyEmailOtp,
  regenerateBackupCodes,
  verifyBackupCode,
  disableMfa,
  issueMfaToken,
  verifyMfaToken,
  verifyFactor,
  recordChallengeFailure,
  isChallengeBurned,
  clearChallengeAttempts,
  isUserThrottled,
};
