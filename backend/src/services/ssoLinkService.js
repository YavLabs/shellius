/**
 * ssoLinkService — everything that attaches an SSO identity to an EXISTING
 * Shellius account, or removes one (docs/auth-hardening.md "Linking SSO
 * accounts").
 *
 *   - Pending links: an SSO sign-in that matched an account by email but may
 *     not be linked silently (the account has a password, or is privileged
 *     and has none). Stored in Redis, single-use, short-lived:
 *       mode 'password'        — confirm on /sso/link with the account's
 *                                password (+ MFA code if enrolled), then the
 *                                user is signed in.
 *       mode 'email_approval'  — an approve link is emailed to the account;
 *                                opening it links the identity.
 *   - Connect: a signed-in user links another provider from Profile. The
 *     callback links to THAT user only — never by email.
 *   - Admin: list / unlink another user's identities (users.manage_identities
 *     + the no-escalation rule + the last-sign-in-method rule).
 *   - Set password: an SSO-only user adds a password, with a recent-auth
 *     proof (MFA code if enrolled, else an emailed one-time code).
 *
 * Tokens are 32 random bytes; only their sha256 is used as the Redis key, and
 * they are never logged.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../config/db.js';
import redis from '../config/redis.js';
import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { sendMail } from './mailer.js';
import { renderTemplate } from '../email/index.js';
import { log as auditLog, ACTIONS } from './auditService.js';
import * as mfaService from './mfaService.js';
import * as authService from './authService.js';
import { linkIdentityToUser, deleteUserIdentity, listUserIdentities, ssoError } from './ssoService.js';
import { assertCanManageUser } from './userService.js';
import { passwordSignInBlocked } from './orgService.js';

export const PENDING_LINK_TTL_SEC = 10 * 60;
export const APPROVAL_LINK_TTL_SEC = 30 * 60;
const MAX_CONFIRM_ATTEMPTS = 5;
const APPROVAL_MAILS_PER_HOUR = 5;
const DISABLED_STATUSES = ['deleted', 'suspended', 'deactivated'];

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const linkKey = (token) => `sso:link:${sha256(token)}`;
const attemptsKey = (token) => `sso:link:attempts:${sha256(token)}`;

function maskEmail(email) {
  const [u, d] = String(email || '').split('@');
  if (!d) return email || '';
  return `${u.slice(0, 2)}***@${d}`;
}

function linkExpired() {
  return new ApiError(400, 'This link request has expired or was already used — sign in again', {
    code: 'LINK_EXPIRED',
  });
}

async function readPending(token) {
  if (!token) return null;
  const raw = await redis.get(linkKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writePending(token, data) {
  // KEEPTTL: updating the record (e.g. "password verified") never extends it.
  await redis.set(linkKey(token), JSON.stringify(data), 'KEEPTTL');
}

/** Atomically consume a pending link. True only for the one caller that wins. */
async function consumePending(token) {
  const removed = await redis.del(linkKey(token));
  await redis.del(attemptsKey(token));
  return removed === 1;
}

// ---------------------------------------------------------------------------
// Notifications (fire-and-forget; a mail failure never fails the action)
// ---------------------------------------------------------------------------

async function sendTemplate(user, name, vars, what) {
  try {
    const tpl = renderTemplate(name, { recipientName: user.name, ...vars });
    await sendMail({ orgId: user.orgId, to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  } catch (err) {
    logger.warn(`ssoLinkService: failed to send ${what} email`, { userId: user.id, error: err.message });
  }
}

export function notifyIdentityLinked(user, { providerName, identityEmail, ipAddress }) {
  return sendTemplate(
    user,
    'identityLinked',
    { providerName, identityEmail, ipAddress, when: new Date().toISOString() },
    'identity-linked'
  );
}

export function notifyIdentityUnlinked(user, { providerName, identityEmail, byAdmin }) {
  return sendTemplate(
    user,
    'identityUnlinked',
    { providerName, identityEmail, byAdmin: !!byAdmin, when: new Date().toISOString() },
    'identity-unlinked'
  );
}

/** Audit + email for a freshly linked identity — every link path calls this. */
export async function recordIdentityLinked({ user, actorId, method, providerName, providerId, identityEmail, ipAddress, userAgent }) {
  await auditLog({
    orgId: user.orgId,
    actorId: actorId === undefined ? user.id : actorId,
    action: ACTIONS.auth.identity_linked,
    resourceType: 'User',
    resourceId: user.id,
    metadata: { method, provider: providerName, providerId },
    ipAddress,
    userAgent,
  });
  await notifyIdentityLinked(user, { providerName, identityEmail, ipAddress });
}

// ---------------------------------------------------------------------------
// Pending links (email-match sign-in that needs confirmation)
// ---------------------------------------------------------------------------

async function approvalMailAllowed(userId) {
  const key = `sso:link:approvalmail:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60 * 60);
  return count <= APPROVAL_MAILS_PER_HOUR;
}

/**
 * Persist a pending link and return its token. Internal building block of
 * createPendingLink (exported for tests — callers must never hand an
 * email_approval token to the browser).
 */
export async function storePendingLink(pending, { ipAddress } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = pending.mode === 'email_approval' ? APPROVAL_LINK_TTL_SEC : PENDING_LINK_TTL_SEC;
  await redis.set(
    linkKey(token),
    JSON.stringify({ ...pending, createdAt: Date.now(), requestIp: ipAddress || null }),
    'EX',
    ttl
  );
  return { token };
}

/**
 * Store a pending link from reconcileSsoUser's `pendingLink` and, for
 * email_approval, send the approval email.
 *
 * @returns {Promise<{ mode: string, token?: string, emailSent?: boolean }>}
 *   `token` is only returned for mode 'password' (the browser needs it for
 *   /sso/link). For 'email_approval' the token only ever travels by email.
 */
export async function createPendingLink(pending, { ipAddress, userAgent } = {}) {
  const { token } = await storePendingLink(pending, { ipAddress });

  await auditLog({
    orgId: pending.orgId,
    actorId: null,
    action: ACTIONS.auth.identity_link_pending,
    resourceType: 'User',
    resourceId: pending.userId,
    metadata: { provider: pending.providerName, providerId: pending.ssoConfigId, mode: pending.mode },
    ipAddress,
    userAgent,
  });

  if (pending.mode !== 'email_approval') return { mode: pending.mode, token };

  let emailSent = false;
  if (await approvalMailAllowed(pending.userId)) {
    const approveUrl = `${config.frontendUrl}/sso/link/approve?${new URLSearchParams({ token }).toString()}`;
    try {
      const tpl = renderTemplate('ssoLinkApproval', {
        recipientName: pending.userName,
        providerName: pending.providerName,
        identityEmail: pending.email,
        approveUrl,
        expiresInMinutes: Math.round(APPROVAL_LINK_TTL_SEC / 60),
        ipAddress,
      });
      const result = await sendMail({
        orgId: pending.orgId,
        to: pending.userEmail,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      emailSent = !!result?.delivered;
    } catch (err) {
      logger.warn('ssoLinkService: failed to send link-approval email', { userId: pending.userId, error: err.message });
    }
    if (!emailSent) {
      // Nothing can approve it — don't leave a live token behind.
      await consumePending(token);
    }
  } else {
    logger.warn('ssoLinkService: link-approval email rate-limited', { userId: pending.userId });
    await consumePending(token);
  }
  return { mode: pending.mode, emailSent };
}

async function loadLinkUser(pending) {
  const user = await prisma.user.findFirst({
    where: { id: pending.userId, orgId: pending.orgId },
    include: { organization: true },
  });
  if (!user || DISABLED_STATUSES.includes(user.status)) {
    throw new ApiError(403, 'Account is disabled', { code: 'ACCOUNT_DISABLED' });
  }
  return user;
}

/** Public description of a pending link for the /sso/link pages. */
export async function describePendingLink(token, expectedMode) {
  const pending = await readPending(token);
  if (!pending || (expectedMode && pending.mode !== expectedMode)) throw linkExpired();
  const user = await loadLinkUser(pending);
  const methods = mfaService.availableMethods(user);
  return {
    mode: pending.mode,
    providerName: pending.providerName,
    presetId: pending.presetId,
    identityEmail: pending.email,
    accountEmail: maskEmail(user.email),
    passwordVerified: !!pending.passwordVerified,
    mfaRequired: pending.mode === 'password' && methods.length > 0,
    methods: pending.mode === 'password' ? methods : [],
  };
}

/** Cancel (the user said "no") — the token is burned. */
export async function cancelPendingLink(token, { ipAddress, userAgent } = {}) {
  const pending = await readPending(token);
  if (!pending) return { cancelled: true };
  await consumePending(token);
  await auditLog({
    orgId: pending.orgId,
    actorId: null,
    action: ACTIONS.auth.identity_link_failed,
    resourceType: 'User',
    resourceId: pending.userId,
    metadata: { provider: pending.providerName, providerId: pending.ssoConfigId, reason: 'cancelled' },
    ipAddress,
    userAgent,
  });
  return { cancelled: true };
}

async function countAttempt(token) {
  const key = attemptsKey(token);
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, PENDING_LINK_TTL_SEC);
  return n;
}

async function linkFailed(pending, reason, { ipAddress, userAgent }) {
  await auditLog({
    orgId: pending.orgId,
    actorId: null,
    action: ACTIONS.auth.identity_link_failed,
    resourceType: 'User',
    resourceId: pending.userId,
    metadata: { provider: pending.providerName, providerId: pending.ssoConfigId, reason },
    ipAddress,
    userAgent,
  });
}

/** Link the pending identity, audit, notify. Consumes the token exactly once. */
async function finalizePendingLink(token, pending, user, method, meta) {
  if (!(await consumePending(token))) throw linkExpired();
  const cfg = { id: pending.ssoConfigId, provider: pending.provider, name: pending.providerName };
  const ssoConfig = await prisma.ssoConfig.findFirst({ where: { id: pending.ssoConfigId, orgId: pending.orgId } });
  if (!ssoConfig || !ssoConfig.isActive) {
    throw new ApiError(409, 'This sign-in provider is no longer available', { code: 'PROVIDER_UNAVAILABLE' });
  }
  try {
    await linkIdentityToUser({
      orgId: pending.orgId,
      cfg,
      userId: user.id,
      subject: pending.subject,
      email: pending.email,
      name: pending.name,
      picture: pending.picture,
      activate: true,
    });
  } catch (err) {
    if (err.errorCode) {
      throw new ApiError(409, err.message, { code: err.errorCode.toUpperCase() });
    }
    throw err;
  }
  await recordIdentityLinked({
    user,
    method,
    providerName: pending.providerName,
    providerId: pending.ssoConfigId,
    identityEmail: pending.email,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
}

/**
 * POST /api/auth/sso/confirm-link — step 1 `{ token, password }`, and when
 * the account has MFA, step 2 `{ token, method, code }`.
 *
 * Wrong passwords count against the account's lockout counter (same as
 * password login) and against the token (5 tries, then it is burned). The
 * MFA step is verified here — the user is never asked for MFA a second time.
 *
 * @returns {Promise<object>} `{ linkMfaRequired, methods, emailHint }` after a
 *   correct password on an MFA account, else a session (issueSession shape).
 */
export async function confirmPendingLink({ token, password, method, code, ipAddress, userAgent }) {
  const meta = { ipAddress, userAgent };
  const pending = await readPending(token);
  if (!pending || pending.mode !== 'password') throw linkExpired();
  const user = await loadLinkUser(pending);

  if (password !== undefined) {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000));
      throw new ApiError(423, 'Account is locked due to too many failed sign-in attempts', {
        code: 'ACCOUNT_LOCKED',
        details: { retryAfterSeconds },
      });
    }
    if ((await countAttempt(token)) > MAX_CONFIRM_ATTEMPTS) {
      await consumePending(token);
      await linkFailed(pending, 'too_many_attempts', meta);
      throw new ApiError(429, 'Too many attempts — sign in again', { code: 'LINK_TOO_MANY_ATTEMPTS' });
    }
    const ok = user.passwordHash ? await bcrypt.compare(String(password), user.passwordHash) : false;
    if (!ok) {
      await authService.recordFailedLogin(user, ipAddress, userAgent);
      await auditLog({
        orgId: user.orgId,
        actorId: null,
        action: ACTIONS.auth.login_failed,
        resourceType: 'User',
        resourceId: user.id,
        metadata: { context: 'sso_link_confirm' },
        ipAddress,
        userAgent,
      });
      throw new ApiError(401, 'Incorrect password', { code: 'INVALID_CREDENTIALS' });
    }
    await authService.resetFailedLogin(user);

    const methods = mfaService.availableMethods(user);
    if (methods.length > 0) {
      await writePending(token, { ...pending, passwordVerified: true });
      return { linkMfaRequired: true, methods, emailHint: maskEmail(user.email) };
    }
  } else {
    // Step 2 — second factor, only after the password step succeeded.
    if (!pending.passwordVerified) throw new ApiError(400, 'Enter your password first', { code: 'PASSWORD_REQUIRED' });
    if ((await countAttempt(token)) > MAX_CONFIRM_ATTEMPTS) {
      await consumePending(token);
      await linkFailed(pending, 'too_many_attempts', meta);
      throw new ApiError(429, 'Too many attempts — sign in again', { code: 'MFA_TOO_MANY_ATTEMPTS' });
    }
    if (await mfaService.isUserThrottled(user.id)) {
      throw new ApiError(429, 'Too many attempts — try again later', { code: 'MFA_TOO_MANY_ATTEMPTS' });
    }
    const ok = mfaService.availableMethods(user).includes(method) && (await mfaService.verifyFactor(user, method, code));
    if (!ok) {
      await auditLog({
        orgId: user.orgId,
        actorId: user.id,
        action: ACTIONS.auth.mfa_failed,
        resourceType: 'User',
        resourceId: user.id,
        metadata: { method, context: 'sso_link_confirm' },
        ipAddress,
        userAgent,
      });
      throw new ApiError(401, 'Invalid verification code', { code: 'MFA_INVALID' });
    }
  }

  await finalizePendingLink(token, pending, user, 'confirmed', meta);
  await auditLog({
    orgId: user.orgId,
    actorId: user.id,
    action: ACTIONS.auth.sso_login,
    resourceType: 'User',
    resourceId: user.id,
    metadata: { provider: pending.provider, providerId: pending.ssoConfigId, linked: true },
    ipAddress,
    userAgent,
  });
  const fresh = await prisma.user.findUnique({ where: { id: user.id }, include: { organization: true } });
  // Password (+ MFA when enrolled) was verified above — this IS the MFA gate.
  return authService.issueSession(fresh, ipAddress, userAgent || '', 'web');
}

/** Email the MFA code for the confirm-link step (after the password step). */
export async function sendConfirmLinkCode(token) {
  const pending = await readPending(token);
  if (!pending || pending.mode !== 'password') throw linkExpired();
  if (!pending.passwordVerified) throw new ApiError(400, 'Enter your password first', { code: 'PASSWORD_REQUIRED' });
  const user = await loadLinkUser(pending);
  if (!user.mfaEmailEnabled) throw new ApiError(400, 'Email codes are not enabled for this account');
  const sent = await mfaService.sendEmailOtp(user, `sso-link:${sha256(token)}`);
  if (!sent) {
    throw new ApiError(429, 'Too many code requests — please wait and try again', { code: 'MFA_TOO_MANY_ATTEMPTS' });
  }
  return { sent: true };
}

/**
 * POST /api/auth/sso/link/approve — the emailed approval link. Links the
 * identity; does NOT sign anyone in (the person then signs in with SSO).
 */
export async function approvePendingLink(token, { ipAddress, userAgent } = {}) {
  const pending = await readPending(token);
  if (!pending || pending.mode !== 'email_approval') throw linkExpired();
  const user = await loadLinkUser(pending);
  await finalizePendingLink(token, pending, user, 'email_approved', { ipAddress, userAgent });
  return { linked: true, providerName: pending.providerName };
}

// ---------------------------------------------------------------------------
// Connect from Profile (session-bound)
// ---------------------------------------------------------------------------

/** Validate a connect/start request. Returns the provider row. */
export async function assertCanStartConnect({ orgId, userId, providerId }) {
  const row = await prisma.ssoConfig.findFirst({ where: { id: providerId, orgId, isActive: true } });
  if (!row) throw new ApiError(404, 'Sign-in provider not found');
  const existing = await prisma.userIdentity.findFirst({ where: { userId, orgId, ssoConfigId: row.id } });
  if (existing) {
    throw new ApiError(409, `You already have a ${row.name} account connected`, { code: 'ALREADY_CONNECTED' });
  }
  return row;
}

/**
 * Callback tail for mode 'connect': link (cfg, subject) to the signed-in user
 * who started the flow. Never matches by email.
 */
export async function completeConnect({ orgId, userId, cfg, subject, email, name, picture, ipAddress, userAgent }) {
  if (!subject) throw ssoError('sso_failed', 'Provider response is missing a subject');
  const allowedDomains = cfg.allowedDomains || [];
  if (allowedDomains.length > 0) {
    const domain = String(email || '').split('@')[1]?.toLowerCase();
    if (!domain || !allowedDomains.includes(domain)) {
      throw ssoError('domain_not_allowed', 'This email domain is not permitted for this organization');
    }
  }
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user || user.status !== 'active') throw ssoError('account_disabled', 'Account is not active');

  await linkIdentityToUser({ orgId, cfg, userId, subject, email: email ? String(email).toLowerCase() : null, name, picture });
  await recordIdentityLinked({
    user,
    method: 'connect',
    providerName: cfg.name || cfg.provider,
    providerId: cfg.id,
    identityEmail: email,
    ipAddress,
    userAgent,
  });
  return { linked: true, providerName: cfg.name || cfg.provider };
}

// ---------------------------------------------------------------------------
// Self-service unlink + admin view / unlink
// ---------------------------------------------------------------------------

export async function unlinkOwnIdentity({ orgId, userId, identityId, ipAddress, userAgent }) {
  const result = await deleteUserIdentity(userId, identityId, { orgId });
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  await auditLog({
    orgId,
    actorId: userId,
    action: ACTIONS.auth.identity_unlinked,
    resourceType: 'User',
    resourceId: userId,
    metadata: { method: 'self', identityId, provider: result.identity.providerName, providerId: result.identity.providerId },
    ipAddress,
    userAgent,
  });
  if (user) await notifyIdentityUnlinked(user, { ...identityMailVars(result.identity), byAdmin: false });
  return { deleted: true };
}

function identityMailVars(identity) {
  return { providerName: identity.providerName, identityEmail: identity.email };
}

async function loadManagedTarget(orgId, actor, userId, what) {
  const target = await prisma.user.findFirst({
    where: { id: userId, orgId, deletedAt: null },
    include: { assignedRole: true },
  });
  if (!target) throw new ApiError(404, 'User not found');
  await assertCanManageUser(orgId, actor, target, what);
  return target;
}

/** GET /api/users/:id/identities */
export async function listIdentitiesForAdmin({ orgId, actor, userId }) {
  const target = await loadManagedTarget(orgId, actor, userId, "view this user's sign-in methods");
  const identities = await listUserIdentities(target.id, orgId);
  const blocked = target.passwordHash ? await passwordSignInBlocked(target) : false;
  return {
    hasPassword: !!target.passwordHash,
    // False when the org requires SSO and this user isn't exempt.
    passwordUsable: !!target.passwordHash && !blocked,
    identities,
  };
}

/** DELETE /api/users/:id/identities/:identityId */
export async function adminUnlinkIdentity({ orgId, actor, userId, identityId, ipAddress, userAgent }) {
  const target = await loadManagedTarget(orgId, actor, userId, "change this user's sign-in methods");
  const result = await deleteUserIdentity(target.id, identityId, { orgId, byAdmin: target.id !== actor.userId });
  await auditLog({
    orgId,
    actorId: actor.userId,
    action: ACTIONS.auth.identity_unlinked,
    resourceType: 'User',
    resourceId: target.id,
    metadata: {
      method: target.id === actor.userId ? 'self' : 'admin',
      identityId,
      provider: result.identity.providerName,
      providerId: result.identity.providerId,
    },
    ipAddress,
    userAgent,
  });
  await notifyIdentityUnlinked(target, { ...identityMailVars(result.identity), byAdmin: target.id !== actor.userId });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Set a password (SSO-only accounts)
// ---------------------------------------------------------------------------

/** Email the one-time code used as recent-auth proof for set-password. */
export async function sendSetPasswordCode({ orgId, userId }) {
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.passwordHash) throw new ApiError(409, 'You already have a password', { code: 'PASSWORD_ALREADY_SET' });
  // Throws 503 EMAIL_NOT_DELIVERED when the mail can't be sent.
  const { sent } = await mfaService.sendSelfServiceEmailOtp(user);
  if (!sent) {
    throw new ApiError(429, 'Please wait a moment before requesting another code', { code: 'MFA_TOO_MANY_ATTEMPTS' });
  }
  return { sent: true, emailHint: maskEmail(user.email) };
}

/**
 * POST /api/auth/password/set — add a password to an account that has none.
 * Proof: `{ method, code }` — an MFA factor when enrolled, otherwise an
 * emailed one-time code (method 'email').
 */
export async function setInitialPassword({ orgId, userId, newPassword, method, code, ipAddress, userAgent }) {
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.passwordHash) throw new ApiError(409, 'You already have a password', { code: 'PASSWORD_ALREADY_SET' });
  if (await passwordSignInBlocked(user)) {
    throw new ApiError(403, "Your organization signs in with single sign-on, so passwords can't be added", {
      code: 'SSO_REQUIRED',
    });
  }

  if (await mfaService.isUserThrottled(user.id)) {
    throw new ApiError(429, 'Too many attempts — try again later', { code: 'MFA_TOO_MANY_ATTEMPTS' });
  }
  const enrolled = mfaService.hasFactor(user);
  let ok = false;
  if (enrolled) {
    ok = mfaService.availableMethods(user).includes(method) && (await mfaService.verifyFactor(user, method, code));
  } else if (method === 'email') {
    ok = await mfaService.verifyEmailOtp(user, code);
  }
  if (!ok) {
    await auditLog({
      orgId,
      actorId: user.id,
      action: ACTIONS.auth.mfa_failed,
      resourceType: 'User',
      resourceId: user.id,
      metadata: { method, context: 'password_set' },
      ipAddress,
      userAgent,
    });
    throw new ApiError(401, 'Invalid verification code', { code: 'MFA_INVALID' });
  }

  const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
  // Only set it if it is still unset (two tabs racing can't overwrite).
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, orgId, passwordHash: null },
    data: { passwordHash, passwordChangedAt: new Date() },
  });
  if (count === 0) throw new ApiError(409, 'You already have a password', { code: 'PASSWORD_ALREADY_SET' });

  await auditLog({
    orgId,
    actorId: user.id,
    action: ACTIONS.auth.password_set,
    resourceType: 'User',
    resourceId: user.id,
    metadata: { proof: enrolled ? method : 'email_code' },
    ipAddress,
    userAgent,
  });
  await sendTemplate(
    user,
    'passwordChanged',
    { ipAddress, userAgent: userAgent || 'unknown', when: new Date().toISOString(), added: true },
    'password-added'
  );
  return { passwordSet: true };
}

export default {
  PENDING_LINK_TTL_SEC,
  APPROVAL_LINK_TTL_SEC,
  createPendingLink,
  storePendingLink,
  describePendingLink,
  cancelPendingLink,
  confirmPendingLink,
  sendConfirmLinkCode,
  approvePendingLink,
  assertCanStartConnect,
  completeConnect,
  unlinkOwnIdentity,
  listIdentitiesForAdmin,
  adminUnlinkIdentity,
  sendSetPasswordCode,
  setInitialPassword,
  recordIdentityLinked,
  notifyIdentityLinked,
  notifyIdentityUnlinked,
};
