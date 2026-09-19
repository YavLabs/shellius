/**
 * /api/vault — My hosts (docs/personal-vault.md). Every endpoint acts only on
 * the caller's own hosts; permission + org-switch checks live in
 * vaultService (vault.hosts, Organization.settings.vault.enabled).
 */

import express from 'express';
import Joi from 'joi';

import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission } from '../middleware/rbac.js';
import { userRateLimiter } from '../middleware/rateLimiter.js';
import * as vaultService from '../services/vaultService.js';

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

router.use(authenticate, tenant);

const actorOf = (req) => ({ id: req.user.userId, role: req.user.role, permissions: req.user.permissions });

// One-off secret, never stored (same shape as a Quick Connect ticket's auth).
const oneOffAuthSchema = Joi.alternatives().try(
  Joi.object({ type: Joi.string().valid('password').required(), password: Joi.string().max(1000).required() }),
  Joi.object({
    type: Joi.string().valid('key').required(),
    privateKey: Joi.string().max(20000).required(),
    passphrase: Joi.string().allow('', null).max(255),
    password: Joi.string().allow('', null).max(1000),
  })
);

const hostFields = {
  name: Joi.string().trim().min(1).max(100),
  host: Joi.string().trim().max(253),
  port: Joi.number().integer().min(1).max(65535),
  username: Joi.string().trim().allow('', null).max(64),
  credentialId: Joi.string().allow(null, ''),
  description: Joi.string().allow('', null).max(1000),
  tags: Joi.array().items(Joi.string().trim().max(40)).max(20),
};

const createSchema = Joi.object({
  ...hostFields,
  name: hostFields.name.required(),
  host: hostFields.host.required(),
  port: hostFields.port.default(22),
  newIdentity: Joi.object({ name: Joi.string().trim().min(1).max(200).required(), auth: oneOffAuthSchema.required() }),
});

const updateSchema = Joi.object(hostFields).min(1);

const connectSchema = Joi.object({ auth: oneOffAuthSchema });

const connectLimiter = userRateLimiter({ keyPrefix: 'rl:vault-connect', windowSeconds: 60, max: 30 });

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await vaultService.getStatus(req.orgId, actorOf(req)) });
  })
);

router.get(
  '/hosts',
  requirePermission('vault.hosts'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await vaultService.listHosts(req.orgId, actorOf(req)) });
  })
);

// Mutations audit themselves in vaultService (with names/hosts, never secrets).
router.post(
  '/hosts',
  requirePermission('vault.hosts'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const result = await vaultService.createHost(req.orgId, actorOf(req), req.body);
    res.status(201).json({ success: true, data: result });
  })
);

router.patch(
  '/hosts/:id',
  requirePermission('vault.hosts'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await vaultService.updateHost(req.orgId, actorOf(req), req.params.id, req.body) });
  })
);

router.delete(
  '/hosts/:id',
  requirePermission('vault.hosts'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await vaultService.deleteHost(req.orgId, actorOf(req), req.params.id) });
  })
);

router.post(
  '/hosts/:id/host-key/reset',
  requirePermission('vault.hosts'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await vaultService.resetHostKey(req.orgId, actorOf(req), req.params.id) });
  })
);

router.post(
  '/hosts/:id/connect',
  requirePermission('vault.hosts'),
  connectLimiter,
  validate(connectSchema),
  asyncHandler(async (req, res) => {
    const result = await vaultService.connectHost(req.orgId, actorOf(req), req.params.id, req.body);
    res.status(201).json({ success: true, data: result });
  })
);

export default router;
