import express from 'express';
import Joi from 'joi';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import { authLimiter, tokenActionLimiter } from '../middleware/rateLimiter.js';
import * as authService from '../services/authService.js';
import * as inviteService from '../services/inviteService.js';
import { sendMail } from '../services/mailer.js';
import { log as auditLog } from '../services/auditService.js';
import prisma from '../config/db.js';
import config from '../config/index.js';
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
} from '../utils/jwt.js';

const router = express.Router();

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Issue access + refresh tokens for a user and persist the refresh token.
 * Used by both invite-accept and password-reset flows.
 */
async function issueTokenPair(user, req) {
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
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || '',
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return { accessToken, refreshToken };
}

function safeUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
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
    res.json({ success: true, data: { user } });
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

    const passwordHash = await bcrypt.hash(req.body.password, config.bcryptRounds);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, status: 'active' },
      include: { organization: true },
    });

    const { accessToken, refreshToken } = await issueTokenPair(updatedUser, req);

    await auditLog({
      orgId: updatedUser.orgId,
      actorId: updatedUser.id,
      action: 'user.invite.accepted',
      resourceType: 'User',
      resourceId: updatedUser.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      data: {
        user: safeUser(updatedUser),
        accessToken,
        refreshToken,
      },
    });
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

    const passwordHash = await bcrypt.hash(req.body.password, config.bcryptRounds);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, status: 'active' },
      include: { organization: true },
    });

    const { accessToken, refreshToken } = await issueTokenPair(updatedUser, req);

    await auditLog({
      orgId: updatedUser.orgId,
      actorId: updatedUser.id,
      action: 'user.password.reset_completed',
      resourceType: 'User',
      resourceId: updatedUser.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      data: {
        user: safeUser(updatedUser),
        accessToken,
        refreshToken,
      },
    });
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

        const orgName = user.organization?.name ?? 'Shellius';

        await sendMail({
          to: user.email,
          subject: `Reset your ${orgName} password`,
          html: buildResetHtml({ name: user.name, orgName, resetUrl }),
          text: buildResetText({ name: user.name, orgName, resetUrl }),
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
// Email template helpers
// ---------------------------------------------------------------------------

function buildResetHtml({ name, orgName, resetUrl }) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2>Reset your ${orgName} password</h2>
  <p>Hi ${name},</p>
  <p>A password reset was requested for your <strong>${orgName}</strong> account on Shellius.</p>
  <p>Click the link below to set a new password.
     This link expires in 1 hour and can only be used once.</p>
  <p style="margin:24px 0">
    <a href="${resetUrl}" style="background:#0f172a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">
      Reset password
    </a>
  </p>
  <p style="color:#6b7280;font-size:13px">Or copy this URL into your browser:<br>${resetUrl}</p>
  <p style="color:#6b7280;font-size:13px">If you did not request this, you can safely ignore this email.</p>
</body>
</html>
  `.trim();
}

function buildResetText({ name, orgName, resetUrl }) {
  return [
    `Reset your ${orgName} password`,
    '',
    `Hi ${name},`,
    '',
    `A password reset was requested for your ${orgName} account on Shellius.`,
    'Click the link below to set a new password. This link expires in 1 hour.',
    '',
    resetUrl,
    '',
    'If you did not request this, you can safely ignore this email.',
  ].join('\n');
}

export default router;
