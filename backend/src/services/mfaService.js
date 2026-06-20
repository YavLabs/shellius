/**
 * mfaService — TOTP (authenticator app) + Email OTP second factor, backup
 * codes, and the short-lived MFA challenge token used during login.
 *
 * Secrets are AES-256-GCM encrypted at rest; backup codes are stored as sha256
 * hashes. Email OTPs are stored hashed in user_tokens with a short TTL.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import prisma from '../config/db.js';
import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { sendMail } from './mailer.js';
import { renderTemplate } from '../email/index.js';

const ISSUER = process.env.MFA_ISSUER || 'Shellius';
const EMAIL_OTP_TYPE = 'mfa_email_otp';
const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_SEC = 5 * 60;

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

// --- status -----------------------------------------------------------------

export function userMfaStatus(user) {
  const enrolled = !!(user.mfaTotpEnabled || user.mfaEmailEnabled);
  return {
    enrolled,
    totpEnabled: !!user.mfaTotpEnabled,
    emailEnabled: !!user.mfaEmailEnabled,
    backupCodesRemaining: (user.mfaBackupCodes || []).length,
    enrolledAt: user.mfaEnrolledAt || null,
  };
}

export function availableMethods(user) {
  const m = [];
  if (user.mfaTotpEnabled) m.push('totp');
  if (user.mfaEmailEnabled) m.push('email');
  return m;
}

// --- TOTP enrollment ---------------------------------------------------------

export async function beginTotpEnroll(user) {
  const secret = authenticator.generateSecret();
  await prisma.user.update({
    where: { id: user.id },
    // Store as pending (not yet enabled) until the user confirms a code.
    data: { mfaTotpSecretEnc: encrypt(secret) },
  });
  const otpauth = authenticator.keyuri(user.email, ISSUER, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  return { secret, otpauthUrl: otpauth, qrDataUrl };
}

export async function confirmTotpEnroll(user, code) {
  if (!user.mfaTotpSecretEnc) throw new ApiError(400, 'Start TOTP setup first');
  const secret = decrypt(user.mfaTotpSecretEnc);
  if (!authenticator.check(String(code || '').trim(), secret)) {
    throw new ApiError(400, 'Invalid authenticator code');
  }
  const backupCodes = generateBackupCodes();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaTotpEnabled: true,
      mfaBackupCodes: backupCodes.map(sha256),
      mfaEnrolledAt: user.mfaEnrolledAt || new Date(),
    },
  });
  return { backupCodes }; // shown once
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

export async function sendEmailOtp(user) {
  // 6-digit code, stored hashed + bound to the user.
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
  return true;
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

function generateBackupCodes(n = 10) {
  return Array.from({ length: n }, () => crypto.randomBytes(5).toString('hex'));
}

export async function regenerateBackupCodes(user) {
  const codes = generateBackupCodes();
  await prisma.user.update({ where: { id: user.id }, data: { mfaBackupCodes: codes.map(sha256) } });
  return codes;
}

export async function verifyBackupCode(user, code) {
  const hash = sha256(String(code || '').trim());
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
      mfaBackupCodes: [],
      mfaEnrolledAt: null,
    },
  });
}

// --- challenge token (login second-factor) -----------------------------------

export function issueMfaToken(user) {
  return jwt.sign({ purpose: 'mfa', userId: user.id, orgId: user.orgId }, config.jwt.secret, {
    expiresIn: CHALLENGE_TTL_SEC,
  });
}

export function verifyMfaToken(token) {
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    if (payload.purpose !== 'mfa') return null;
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

export default {
  userMfaStatus,
  availableMethods,
  beginTotpEnroll,
  confirmTotpEnroll,
  verifyTotp,
  enableEmailOtp,
  sendEmailOtp,
  verifyEmailOtp,
  regenerateBackupCodes,
  verifyBackupCode,
  disableMfa,
  issueMfaToken,
  verifyMfaToken,
  verifyFactor,
};
