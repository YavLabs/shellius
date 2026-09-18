import express from 'express';
import Joi from 'joi';

import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as quickConnectService from '../services/quickConnectService.js';

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

router.use(authenticate, tenant);

const settingsSchema = Joi.object({
  enabled: Joi.boolean().required(),
  minRole: Joi.string().valid('super_admin', 'admin', 'manager', 'member').required(),
});

const ticketAuthSchema = Joi.alternatives().try(
  Joi.object({ type: Joi.string().valid('password').required(), password: Joi.string().required() }),
  Joi.object({
    type: Joi.string().valid('key').required(),
    privateKey: Joi.string().required(),
    passphrase: Joi.string().allow('', null),
    // Optional — covers hosts requiring BOTH a key and a password
    // (AuthenticationMethods publickey,password).
    password: Joi.string().allow('', null),
  }),
  Joi.object({ type: Joi.string().valid('credential').required(), credentialId: Joi.string().required() })
);

const ticketSchema = Joi.object({
  host: Joi.string().required(),
  port: Joi.number().integer().min(1).max(65535).default(22),
  username: Joi.string().allow('', null),
  auth: ticketAuthSchema.required(),
  expectedHostKey: Joi.string().allow('', null),
});

const newIdentityAuthSchema = Joi.alternatives().try(
  Joi.object({ type: Joi.string().valid('password').required(), password: Joi.string().required() }),
  Joi.object({
    type: Joi.string().valid('key').required(),
    privateKey: Joi.string().required(),
    passphrase: Joi.string().allow('', null),
    password: Joi.string().allow('', null),
  })
);

const identitySchema = Joi.alternatives().try(
  Joi.object({ mode: Joi.string().valid('existing').required(), credentialId: Joi.string().required() }),
  Joi.object({
    mode: Joi.string().valid('new').required(),
    name: Joi.string().required(),
    auth: newIdentityAuthSchema.required(),
  }),
  Joi.object({ mode: Joi.string().valid('none').required() })
);

const saveSchema = Joi.object({
  host: Joi.string().required(),
  port: Joi.number().integer().min(1).max(65535).default(22),
  username: Joi.string().required(),
  hostname: Joi.string().allow('', null),
  displayName: Joi.string().allow('', null),
  customerId: Joi.string().required(),
  environment: Joi.string().valid('demo', 'dev', 'staging', 'prod').default('dev'),
  description: Joi.string().allow('', null),
  hostKeyFingerprint: Joi.string().allow('', null),
  hostKeyAlgorithm: Joi.string().allow('', null),
  identity: identitySchema.required(),
});

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const result = await quickConnectService.getSettings(req.orgId, req.user.role);
    res.json({ success: true, data: result });
  })
);

router.put(
  '/settings',
  requireRole('super_admin', 'admin'),
  audit('quick_connect.settings.update', 'Organization'),
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    const result = await quickConnectService.updateSettings(req.orgId, req.body, req.user.userId);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/tickets',
  audit('quick_connect.ticket', 'QuickConnect'),
  validate(ticketSchema),
  asyncHandler(async (req, res) => {
    const result = await quickConnectService.createTicket(
      req.orgId,
      { id: req.user.userId, role: req.user.role },
      req.body
    );
    res.status(201).json({ success: true, data: result });
  })
);

router.post(
  '/save',
  requireRole('super_admin', 'admin', 'manager'),
  audit('quick_connect.save', 'Server'),
  validate(saveSchema),
  asyncHandler(async (req, res) => {
    const result = await quickConnectService.saveAsServer(
      req.orgId,
      { id: req.user.userId, role: req.user.role },
      req.body
    );
    res.status(201).json({ success: true, data: result });
  })
);

export default router;
