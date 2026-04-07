import express from 'express';
import Joi from 'joi';
import nodemailer from 'nodemailer';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as smtpConfigService from '../services/smtpConfigService.js';
import prisma from '../config/db.js';
import { renderTemplate } from '../email/index.js';

const router = express.Router();
router.use(authenticate, tenant);

const smtpSchema = Joi.object({
  host: Joi.string().min(1).max(255).required(),
  port: Joi.number().integer().min(1).max(65535),
  username: Joi.string().max(255).allow('', null),
  password: Joi.string().max(1000).allow('', null),
  fromAddress: Joi.string().email().allow('', null),
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
  requireRole('admin'),
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
  requireRole('admin'),
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
  requireRole('admin'),
  audit('smtp.config.deleted', 'SmtpConfig'),
  asyncHandler(async (req, res) => {
    await smtpConfigService.remove(req.orgId);
    res.json({ success: true, data: { success: true } });
  })
);

// POST /api/settings/smtp/test — admin+; sends a test email to the caller's own address
router.post(
  '/test',
  requireRole('admin'),
  audit('smtp.config.test', 'SmtpConfig'),
  asyncHandler(async (req, res) => {
    const effective = await smtpConfigService.getEffective(req.orgId);
    if (!effective.configured) {
      throw new ApiError(400, 'No SMTP configuration — set host in env or UI');
    }

    // Pull caller's email + name; never send test mail to an arbitrary address
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { email: true, name: true },
    });
    if (!user?.email) throw new ApiError(400, 'Caller has no email on record');

    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: { name: true },
    });

    const transport = nodemailer.createTransport({
      host: effective.host,
      port: effective.port,
      secure: effective.useTls && effective.port === 465,
      auth: effective.username && effective.password
        ? { user: effective.username, pass: effective.password }
        : undefined,
    });

    try {
      await transport.verify();
      const tpl = renderTemplate('smtpTest', {
        recipientName: user.name,
        orgName: org?.name,
        host: effective.host,
        port: effective.port,
        useTls: effective.useTls,
        when: new Date().toISOString(),
      });
      await transport.sendMail({
        from: effective.fromAddress || effective.username || 'noreply@shellius.local',
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      res.json({ success: true, data: { ok: true, sentTo: user.email } });
    } catch (err) {
      throw new ApiError(400, `SMTP test failed: ${err.message}`);
    } finally {
      transport.close();
    }
  })
);

export default router;
