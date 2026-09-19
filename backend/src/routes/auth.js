import express from 'express';
import Joi from 'joi';
import bcrypt from 'bcryptjs';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import { authLimiter, tokenActionLimiter } from '../middleware/rateLimiter.js';
import * as authService from '../services/authService.js';
import * as inviteService from '../services/inviteService.js';
import * as userService from '../services/userService.js';
import * as ssoService from '../services/ssoService.js';
import * as mfaService from '../services/mfaService.js';
import { sendMail } from '../services/mailer.js';
import { renderTemplate } from '../email/index.js';
import { log as auditLog } from '../services/auditService.js';
import prisma from '../config/db.js';
import config from '../config/index.js';

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  }
  req.body = value;
  next();
};

// ---------------------------------------------------------------------------
// Joi schemas
// ---------------------------------------------------------------------------

const loginSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required(),
  password: Joi.string().min(1).required(),
});

const refreshSchema = Joi.object({
  refreshToken: Joi.string().required(),
});

const logoutSchema = Joi.object({
  refreshToken: Joi.string().required(),
});

/**
 * Password policy: min 12 chars, at least 1 letter AND 1 digit.
 */
const strongPasswordSchema = Joi.string()
  .min(12)
  .max(200)
  .pattern(/[a-zA-Z]/, 'letter')
  .pattern(/[0-9]/, 'digit')
  .required()
  .messages({
    'string.min': 'Password must be at least 12 characters',
    'string.pattern.name': 'Password must contain at least one {#name}',
  });

/**
 * 64-char hex string (32 random bytes encoded as hex).
 */
const tokenParamSchema = Joi.string().length(64).hex().required();

const acceptInviteSchema = Joi.object({
  password: strongPasswordSchema,
});

const passwordResetSchema = Joi.object({
  password: strongPasswordSchema,
});

const selfServiceResetSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required(),
});

const registerSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required(),
  name: Joi.string().min(1).max(120).required(),
  password: strongPasswordSchema,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the tenant org for public (unauthenticated) endpoints.
 *
 * Resolution priority:
 *   1. Hostname-based: find org whose `domain` matches req.hostname
 *   2. Single-tenant fallback: return the first org (ordered by createdAt ASC)
 *
 * Returns null when no org exists at all (fresh install before seed).
 *
 * @param {import('express').Request} req
 * @returns {Promise<object|null>}
 */
async function resolvePublicOrg(req) {
  const hostname = req.hostname || req.get('host') || '';

  // Attempt hostname-based resolution for multi-tenant deploys
  if (hostname) {
    const byDomain = await prisma.organization.findFirst({
      where: { domain: hostname },
    });
    if (byDomain) return byDomain;
  }

  // Single-tenant fallback: first org
  return prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
}

// ---------------------------------------------------------------------------
// Existing routes
// ---------------------------------------------------------------------------

router.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const ip = req.ip;
    const ua = req.get('user-agent') || '';
    const result = await authService.login(email, password, ip, ua);
    res.json({ success: true, data: result });
  })
);

// POST /login-options — public; drives the email-first login UI. Given an
// email, tells the frontend whether to show a password field, start SSO, or
// offer a set-password (invite) path. Returns a small, low-enumeration shape.
const loginOptionsSchema = Joi.object({ email: Joi.string().email({ tlds: { allow: false } }).required() });
router.post(
  '/login-options',
  authLimiter,
  validate(loginOptionsSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    const org = await resolvePublicOrg(req);
    const sso = org ? await ssoService.getPublicSsoSummary(org.id) : { enabled: false, presetId: null, providers: [] };
    const state = await authService.getLoginState(email);
    res.json({
      success: true,
      data: {
        hasPassword: state.hasPassword,
        ssoEnabled: !!sso.enabled,
        ssoPresetId: sso.presetId || null,
        providers: sso.providers || [],
        orgSlug: org?.slug || null,
      },
    });
  })
);

// POST /mfa/verify — complete a password login's second factor
const mfaVerifySchema = Joi.object({
  mfaToken: Joi.string().required(),
  method: Joi.string().valid('totp', 'email', 'backup').required(),
  code: Joi.string().required(),
});
router.post(
  '/mfa/verify',
  authLimiter,
  validate(mfaVerifySchema),
  asyncHandler(async (req, res) => {
    const result = await authService.completeMfaLogin({
      mfaToken: req.body.mfaToken,
      method: req.body.method,
      code: req.body.code,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    res.json({ success: true, data: result });
  })
);

// POST /mfa/send-otp — email an OTP during a login challenge
const mfaSendOtpSchema = Joi.object({ mfaToken: Joi.string().required() });
router.post(
  '/mfa/send-otp',
  authLimiter,
  validate(mfaSendOtpSchema),
  asyncHandler(async (req, res) => {
    const payload = mfaService.verifyMfaToken(req.body.mfaToken);
    if (!payload) {
      throw new ApiError(401, 'MFA session expired — sign in again', { code: 'MFA_CHALLENGE_EXPIRED' });
    }
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (user && user.mfaEmailEnabled) await mfaService.sendEmailOtp(user, payload.jti);
    res.json({ success: true, data: { sent: true } });
  })
);

router.post(
  '/refresh',
  authLimiter,
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    const ip = req.ip;
    const ua = req.get('user-agent') || '';
    const result = await authService.refresh(refreshToken, ip, ua);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/logout',
  authenticate,
  validate(logoutSchema),
  asyncHandler(async (req, res) => {
    await authService.logout(req.body.refreshToken);
    res.status(204).send();
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await authService.getProfile(req.user.userId);
    const identities = await ssoService.listUserIdentities(req.user.userId);
    res.json({ success: true, data: { user: { ...user, identities } } });
  })
);

// ---------------------------------------------------------------------------
// DELETE /identities/:id — unlink one of the caller's SSO identities
// ---------------------------------------------------------------------------

router.delete(
  '/identities/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    await ssoService.deleteUserIdentity(req.user.userId, req.params.id);
    await auditLog({
      orgId: req.user.orgId,
      actorId: req.user.userId,
      action: 'auth.identity.unlinked',
      resourceType: 'User',
      resourceId: req.user.userId,
      metadata: { identityId: req.params.id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(204).send();
  })
);

// ---------------------------------------------------------------------------
// Sessions — self-service listing/revocation of refresh-token families
// ---------------------------------------------------------------------------

router.get(
  '/sessions',
  authenticate,
  asyncHandler(async (req, res) => {
    const sessions = await authService.listSessions(req.user.userId, req.user.fid);
    res.json({ success: true, data: { sessions } });
  })
);

router.delete(
  '/sessions/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    await authService.revokeSessionForUser(req.user.userId, req.params.id);
    await auditLog({
      orgId: req.user.orgId,
      actorId: req.user.userId,
      action: 'auth.session.revoked',
      resourceType: 'User',
      resourceId: req.user.userId,
      metadata: { familyId: req.params.id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(204).send();
  })
);

router.post(
  '/sessions/revoke-others',
  authenticate,
  asyncHandler(async (req, res) => {
    const revoked = await authService.revokeOtherSessionsForUser(req.user.userId, req.user.fid);
    await auditLog({
      orgId: req.user.orgId,
      actorId: req.user.userId,
      action: 'auth.sessions.revoke_others',
      resourceType: 'User',
      resourceId: req.user.userId,
      metadata: { revoked },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data: { revoked } });
  })
);

// ---------------------------------------------------------------------------
// GET /invite/:token — public; peek at token without consuming
// ---------------------------------------------------------------------------

router.get(
  '/invite/:token',
  asyncHandler(async (req, res) => {
    const { error } = tokenParamSchema.validate(req.params.token);
    if (error) throw new ApiError(400, 'Invalid token format');

    const user = await inviteService.verifyWithoutConsuming(
      req.params.token,
      inviteService.TOKEN_TYPES.INVITE
    );

    res.json({
      success: true,
      data: {
        user: { email: user.email, name: user.name },
        org: { name: user.organization?.name ?? '' },
      },
    });
  })
);

// ---------------------------------------------------------------------------
// POST /invite/:token/accept — public; consume token, set password, log in
// ---------------------------------------------------------------------------

router.post(
  '/invite/:token/accept',
  tokenActionLimiter,
  validate(acceptInviteSchema),
  asyncHandler(async (req, res) => {
    const { error } = tokenParamSchema.validate(req.params.token);
    if (error) throw new ApiError(400, 'Invalid token format');

    const user = await inviteService.verifyAndConsume(
      req.params.token,
      inviteService.TOKEN_TYPES.INVITE
    );
    // An invite activates a *pending* account only — it must never bring a
    // suspended/deactivated user back or overwrite an active user's password
    // (docs/rbac F-02 / F-11).
    if (user.status !== 'invited') {
      throw new ApiError(410, 'This invitation is no longer valid — ask your administrator for help', {
        code: 'INVITE_NOT_PENDING',
      });
    }

    const passwordHash = await bcrypt.hash(req.body.password, config.bcryptRounds);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, status: 'active', passwordChangedAt: new Date() },
      include: { organization: true },
    });

    await auditLog({
      orgId: updatedUser.orgId,
      actorId: updatedUser.id,
      action: 'user.invite.accepted',
      resourceType: 'User',
      resourceId: updatedUser.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // MFA gate — an invited user who already has a factor enrolled from a
    // prior account (rare, but possible for re-invites) must still verify it.
    const gate = await authService.mfaGate(updatedUser);
    if (gate) {
      return res.json({ success: true, data: gate });
    }

    const session = await authService.issueSession(updatedUser, req.ip, req.get('user-agent') || '', 'web');
    res.json({ success: true, data: session });
  })
);

// ---------------------------------------------------------------------------
// GET /password-reset/:token — public; peek at token without consuming
// ---------------------------------------------------------------------------

router.get(
  '/password-reset/:token',
  asyncHandler(async (req, res) => {
    const { error } = tokenParamSchema.validate(req.params.token);
    if (error) throw new ApiError(400, 'Invalid token format');

    const user = await inviteService.verifyWithoutConsuming(
      req.params.token,
      inviteService.TOKEN_TYPES.PASSWORD_RESET
    );

    res.json({
      success: true,
      data: {
        user: { email: user.email, name: user.name },
        org: { name: user.organization?.name ?? '' },
      },
    });
  })
);

// ---------------------------------------------------------------------------
// POST /password-reset/:token/reset — public; consume token, set new password
// ---------------------------------------------------------------------------

router.post(
  '/password-reset/:token/reset',
  tokenActionLimiter,
  validate(passwordResetSchema),
  asyncHandler(async (req, res) => {
    const { error } = tokenParamSchema.validate(req.params.token);
    if (error) throw new ApiError(400, 'Invalid token format');

    const user = await inviteService.verifyAndConsume(
      req.params.token,
      inviteService.TOKEN_TYPES.PASSWORD_RESET
    );

    // A reset token can outlive a status change (suspend/deactivate/delete)
    // that happened after it was issued. Never let consuming it resurrect a
    // disabled account — only invited/pending_verification are eligible to
    // flip to 'active' here, matching the invite-accept flow.
    if (['suspended', 'deactivated', 'deleted'].includes(user.status)) {
      throw new ApiError(403, 'Account is disabled', { code: 'ACCOUNT_DISABLED' });
    }

    const passwordHash = await bcrypt.hash(req.body.password, config.bcryptRounds);
    const updateData = { passwordHash, passwordChangedAt: new Date() };
    if (['invited', 'pending_verification'].includes(user.status)) {
      updateData.status = 'active';
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: updateData,
      include: { organization: true },
    });

    // A password reset is a credential-compromise-recovery action — kill
    // every other outstanding session (and any live terminal sessions).
    await authService.revokeAllSessions(updatedUser.id, updatedUser.orgId, 'password_reset');

    await auditLog({
      orgId: updatedUser.orgId,
      actorId: updatedUser.id,
      action: 'user.password.reset_completed',
      resourceType: 'User',
      resourceId: updatedUser.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const gate = await authService.mfaGate(updatedUser);
    if (gate) {
      return res.json({ success: true, data: gate });
    }

    const session = await authService.issueSession(updatedUser, req.ip, req.get('user-agent') || '', 'web');
    res.json({ success: true, data: session });
  })
);

// ---------------------------------------------------------------------------
// POST /password-reset — public self-service; ALWAYS returns 204 (no enum)
// ---------------------------------------------------------------------------

router.post(
  '/password-reset',
  tokenActionLimiter,
  validate(selfServiceResetSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body;

    // Always return 204 — never reveal whether the email exists
    res.status(204).send();

    // Fire-and-forget after response is sent so timing does not leak user existence.
    // Any errors here are swallowed; they are logged inside the helpers.
    setImmediate(async () => {
      try {
        const user = await prisma.user.findFirst({
          where: { email },
          include: { organization: true },
        });

        if (!user || user.status === 'deactivated') return;

        const { rawToken } = await inviteService.createInvite(
          user.id,
          inviteService.TOKEN_TYPES.PASSWORD_RESET,
          1
        );
        const resetUrl = inviteService.buildTokenUrl(
          inviteService.TOKEN_TYPES.PASSWORD_RESET,
          rawToken,
          null // no req available post-response; use env-var base URL
        );

        const tpl = renderTemplate('passwordReset', {
          recipientName: user.name,
          resetUrl,
          expiresInHours: 1,
        });
        await sendMail({
          orgId: user.orgId,
          to: user.email,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
        });

        await auditLog({
          orgId: user.orgId,
          actorId: null,
          action: 'user.password.reset_requested',
          resourceType: 'User',
          resourceId: user.id,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        });
      } catch (err) {
        // Swallow — response already sent; log for observability only
        const logger = (await import('../utils/logger.js')).default;
        logger.error('password-reset self-service: background processing failed', {
          error: err.message,
        });
      }
    });
  })
);

// ---------------------------------------------------------------------------
// GET /registration-status — public; returns { enabled: bool }
// ---------------------------------------------------------------------------

router.get(
  '/registration-status',
  asyncHandler(async (req, res) => {
    const org = await resolvePublicOrg(req);
    const enabled = org ? org.selfServiceRegistrationEnabled : false;
    res.json({ success: true, data: { enabled } });
  })
);

// ---------------------------------------------------------------------------
// POST /register — public self-service registration
// ---------------------------------------------------------------------------

router.post(
  '/register',
  tokenActionLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { email, name, password } = req.body;

    const org = await resolvePublicOrg(req);

    if (!org || !org.selfServiceRegistrationEnabled) {
      // Generic response — same message whether disabled or no org found
      return res.json({
        success: true,
        data: { message: 'If your email is eligible, a verification link has been sent' },
      });
    }

    // Check for existing user — use the generic response to prevent enumeration
    const existing = await prisma.user.findFirst({
      where: { orgId: org.id, email },
    });
    if (existing) {
      return res.json({
        success: true,
        data: { message: 'If your email is eligible, a verification link has been sent' },
      });
    }

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    const user = await userService.createPendingUser(org.id, { email, name, passwordHash });

    // Mint an EMAIL_VERIFY token (24 h TTL)
    const { rawToken } = await inviteService.createInvite(
      user.id,
      inviteService.TOKEN_TYPES.EMAIL_VERIFY,
      24
    );
    const verifyUrl = inviteService.buildTokenUrl(
      inviteService.TOKEN_TYPES.EMAIL_VERIFY,
      rawToken,
      req
    );

    // Send verification email (fire-and-forget after response is queued)
    const tpl = renderTemplate('verifyEmail', {
      recipientName: name,
      verifyUrl,
      expiresInHours: 24,
    });

    // Audit-log with actorId=null (unauthenticated); store email in metadata
    await auditLog({
      orgId: org.id,
      actorId: null,
      action: 'auth.register',
      resourceType: 'User',
      resourceId: user.id,
      metadata: { email },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Send after audit to keep the response fast; errors are swallowed
    sendMail({
      orgId: org.id,
      to: email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    }).catch(async (err) => {
      const logger = (await import('../utils/logger.js')).default;
      logger.error('auth.register: failed to send verification email', {
        userId: user.id,
        error: err.message,
      });
    });

    res.json({
      success: true,
      data: { message: 'If your email is eligible, a verification link has been sent' },
    });
  })
);

// ---------------------------------------------------------------------------
// POST /verify-email/:token — public; consume token, flip status to active
// ---------------------------------------------------------------------------

router.post(
  '/verify-email/:token',
  tokenActionLimiter,
  asyncHandler(async (req, res) => {
    const { error } = tokenParamSchema.validate(req.params.token);
    if (error) throw new ApiError(400, 'Invalid token format');

    const user = await inviteService.verifyAndConsume(
      req.params.token,
      inviteService.TOKEN_TYPES.EMAIL_VERIFY
    );

    await userService.markEmailVerified(user.id);

    await auditLog({
      orgId: user.orgId,
      actorId: user.id,
      action: 'auth.email_verified',
      resourceType: 'User',
      resourceId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ success: true, data: { message: 'Email verified' } });
  })
);

// Legacy template helpers replaced by the shared registry under
// backend/src/email/. See renderTemplate('passwordReset', vars).
// Phase 16D rewrite.

export default router;
