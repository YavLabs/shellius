import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission } from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as smtpConfigService from '../services/smtpConfigService.js';
import * as emailProviderService from '../services/emailProviderService.js';
import { sendWith, resolveFrom } from '../services/email/providers/index.js';
import { envSmtpProvider } from '../services/email/envSmtp.js';
import prisma from '../config/db.js';
import { renderTemplate } from '../email/index.js';

// DEPRECATED — superseded by /api/settings/email/providers
// (routes/emailProviders.js). Kept so existing API clients keep working; it
// reads/writes the org's active SMTP email provider through the
// smtpConfigService compatibility shim.
const router = express.Router();
router.use(authenticate, tenant);

const smtpSchema = Joi.object({
  host: Joi.string().min(1).max(255).required(),
  port: Joi.number().integer().min(1).max(65535),
  username: Joi.string().max(255).allow('', null),
  password: Joi.string().max(1000).allow('', null),
  fromAddress: Joi.string().email({ tlds: { allow: false } }).allow('', null),
  useTls: Joi.boolean(),
  isActive: Joi.boolean(),
});

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { stripUnknown: true });
  if (error) return next(new ApiError(400, error.message));
  req.body = value;
  next();
};

// GET /api/settings/smtp — admin+; returns effective config with password masked
router.get(
  '/',
  requirePermission('settings.smtp'),
  asyncHandler(async (req, res) => {
    const effective = await smtpConfigService.getEffective(req.orgId);
    const { password, ...rest } = effective;
    res.json({
      success: true,
      data: {
        config: {
          ...rest,
          hasPassword: !!password,
        },
      },
    });
  })
);

// PUT /api/settings/smtp — admin+; Joi validate, upsert, encrypt password
router.put(
  '/',
  requirePermission('settings.smtp'),
  audit('smtp.config.updated', 'SmtpConfig'),
  validate(smtpSchema),
  asyncHandler(async (req, res) => {
    const row = await smtpConfigService.upsert(req.orgId, req.body);
    res.json({ success: true, data: { config: row } });
  })
);

// DELETE /api/settings/smtp — admin+; drops the DB row, falls back to env defaults
router.delete(
  '/',
  requirePermission('settings.smtp'),
  audit('smtp.config.deleted', 'SmtpConfig'),
  asyncHandler(async (req, res) => {
    await smtpConfigService.remove(req.orgId);
    res.json({ success: true, data: { success: true } });
  })
);

// POST /api/settings/smtp/test — admin+; sends a test email to the caller's own address
router.post(
  '/test',
  requirePermission('settings.smtp'),
  audit('smtp.config.test', 'SmtpConfig'),
  asyncHandler(async (req, res) => {
    const effective = await smtpConfigService.getEffective(req.orgId);
    if (!effective.configured) {
      throw new ApiError(400, 'No SMTP configuration — set host in env or UI');
    }

    // Pull caller's email + name; never send test mail to an arbitrary address
    const user = await prisma.user.findFirst({
      where: { id: req.user.userId, orgId: req.orgId },
      select: { email: true, name: true },
    });
    if (!user?.email) throw new ApiError(400, 'Caller has no email on record');

    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: { name: true },
    });

    // The active SMTP provider records its test result like the new API does.
    const active = await emailProviderService.getActiveForSend(req.orgId);
    if (active?.type === 'smtp') {
      const result = await emailProviderService.test(
        req.orgId,
        active.id,
        { to: user.email, recipientName: user.name, orgName: org?.name },
        { userId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] }
      );
      if (!result.ok) throw new ApiError(400, `SMTP test failed: ${result.error}`);
      return res.json({ success: true, data: { ok: true, sentTo: user.email } });
    }

    const provider = envSmtpProvider();
    const tpl = renderTemplate('smtpTest', {
      recipientName: user.name,
      orgName: org?.name,
      host: effective.host,
      port: effective.port,
      useTls: effective.security !== 'none',
      when: new Date().toISOString(),
    });
    try {
      await sendWith(provider, { to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    } catch (err) {
      throw new ApiError(400, `SMTP test failed: ${err.message}`);
    }
    res.json({ success: true, data: { ok: true, sentTo: user.email, from: resolveFrom(provider).address } });
  })
);

export default router;
