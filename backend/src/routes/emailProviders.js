/**
 * /api/settings/email — outbound email providers (docs/email-delivery.md).
 *
 * All provider routes require `settings.smtp` ("Email delivery"). Secrets are
 * write-only: responses show { set: true|false } in their place, and PUT
 * keeps a stored secret when the field is omitted or empty.
 *
 * The Google OAuth callback is the one unauthenticated route (it is a browser
 * redirect from Google); it is bound to org + provider + user through a
 * one-time, 10-minute state value.
 */

import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission } from '../middleware/rbac.js';
import { userRateLimiter } from '../middleware/rateLimiter.js';
import prisma from '../config/db.js';
import config from '../config/index.js';
import * as emailProviderService from '../services/emailProviderService.js';

const router = express.Router();

// No CR/LF — these end up in email headers.
const headerSafe = /^[^\r\n]*$/;

const createSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).pattern(headerSafe).required(),
  type: Joi.string().valid(...emailProviderService.PROVIDER_TYPES).required(),
  fromAddress: Joi.string().trim().email({ tlds: { allow: false } }).max(320).allow('', null),
  fromName: Joi.string().trim().max(100).pattern(headerSafe).allow('', null),
  config: Joi.object().unknown(true).default({}),
  isActive: Joi.boolean().default(false),
});

const updateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).pattern(headerSafe),
  type: Joi.string().valid(...emailProviderService.PROVIDER_TYPES),
  fromAddress: Joi.string().trim().email({ tlds: { allow: false } }).max(320).allow('', null),
  fromName: Joi.string().trim().max(100).pattern(headerSafe).allow('', null),
  config: Joi.object().unknown(true),
}).min(1);

const testSchema = Joi.object({
  to: Joi.string().trim().email({ tlds: { allow: false } }).max(320).allow('', null),
});

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body || {}, { stripUnknown: true });
  if (error) return next(new ApiError(400, error.message, { code: 'VALIDATION_ERROR' }));
  req.body = value;
  next();
};

const ctxOf = (req) => ({ userId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] });

// ---------------------------------------------------------------------------
// Google OAuth callback (unauthenticated browser redirect — see header)
// ---------------------------------------------------------------------------

function adminEmailRedirect(params) {
  const qs = new URLSearchParams(params);
  return `${config.publicBaseUrl.replace(/\/$/, '')}/admin/email?${qs.toString()}`;
}

router.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const pick = (v) => (typeof v === 'string' ? v : undefined);
    let result;
    try {
      result = await emailProviderService.completeGoogleConnect({
        state: pick(req.query.state),
        code: pick(req.query.code),
        error: pick(req.query.error),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    } catch {
      result = { ok: false, error: 'server_error' };
    }
    res.redirect(302, adminEmailRedirect(result.ok ? { connected: '1' } : { error: result.error }));
  })
);

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const providers = express.Router();
providers.use(authenticate, tenant, requirePermission('settings.smtp'));

providers.get(
  '/',
  asyncHandler(async (req, res) => {
    const { providers: items, meta } = await emailProviderService.list(req.orgId);
    res.json({ success: true, data: { providers: items }, meta });
  })
);

providers.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const provider = await emailProviderService.create(req.orgId, req.body, ctxOf(req));
    res.status(201).json({ success: true, data: { provider } });
  })
);

providers.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const provider = await emailProviderService.get(req.orgId, req.params.id);
    res.json({ success: true, data: { provider } });
  })
);

providers.put(
  '/:id',
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const provider = await emailProviderService.update(req.orgId, req.params.id, req.body, ctxOf(req));
    res.json({ success: true, data: { provider } });
  })
);

providers.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const result = await emailProviderService.remove(req.orgId, req.params.id, ctxOf(req));
    res.json({ success: true, data: result });
  })
);

providers.post(
  '/:id/activate',
  asyncHandler(async (req, res) => {
    const provider = await emailProviderService.activate(req.orgId, req.params.id, ctxOf(req));
    res.json({ success: true, data: { provider } });
  })
);

providers.post(
  '/:id/deactivate',
  asyncHandler(async (req, res) => {
    const provider = await emailProviderService.deactivate(req.orgId, req.params.id, ctxOf(req));
    res.json({ success: true, data: { provider } });
  })
);

// Test sends are real emails to an arbitrary address — keep them bounded.
const testLimiter = userRateLimiter({ keyPrefix: 'rl:email-provider-test', windowSeconds: 60, max: 10 });

providers.post(
  '/:id/test',
  testLimiter,
  validate(testSchema),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findFirst({
      where: { id: req.user.userId, orgId: req.orgId },
      select: { email: true, name: true },
    });
    const to = req.body.to || user?.email;
    if (!to) throw new ApiError(400, 'Enter an address to send the test email to', { code: 'VALIDATION_ERROR' });
    const org = await prisma.organization.findUnique({ where: { id: req.orgId }, select: { name: true } });

    const result = await emailProviderService.test(
      req.orgId,
      req.params.id,
      { to, recipientName: to === user?.email ? user?.name : null, orgName: org?.name },
      ctxOf(req)
    );
    // A delivery failure is a normal outcome of a test, not an API error:
    // return it with the provider's own message so the UI can show it.
    res.json({ success: true, data: result });
  })
);

providers.post(
  '/:id/google/connect',
  asyncHandler(async (req, res) => {
    const data = await emailProviderService.startGoogleConnect(req.orgId, req.params.id, ctxOf(req));
    res.json({ success: true, data });
  })
);

router.use('/providers', providers);

export default router;
