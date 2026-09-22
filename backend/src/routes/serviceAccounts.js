/**
 * /api/service-accounts — machine identities and their tokens.
 *
 * Reading needs `service_accounts.view`; every change needs
 * `service_accounts.manage`, and on top of that the no-escalation rule from
 * roleService: you can only give a service account a role whose permissions
 * you already hold, so this can't be used to build a robot more powerful
 * than yourself and then borrow it.
 *
 * On the API-token deny-list — a token must not be able to create identities.
 */

import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission } from '../middleware/rbac.js';
import { userRateLimiter } from '../middleware/rateLimiter.js';
import audit from '../middleware/audit.js';
import { actorFromReq } from '../services/roleService.js';
import * as serviceAccountService from '../services/serviceAccountService.js';
import * as apiTokenService from '../services/apiTokenService.js';

const router = express.Router();

router.use(authenticate, tenant);

const createSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  description: Joi.string().trim().max(500).allow('', null),
  roleId: Joi.string().trim().required(),
  accessScope: Joi.string().valid('ALL', 'CUSTOMERS').default('ALL'),
  customerIds: Joi.array().items(Joi.string().trim()).max(500).default([]),
});

const updateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100),
  description: Joi.string().trim().max(500).allow('', null),
  roleId: Joi.string().trim(),
  status: Joi.string().valid('active', 'deactivated'),
  accessScope: Joi.string().valid('ALL', 'CUSTOMERS'),
  customerIds: Joi.array().items(Joi.string().trim()).max(500),
}).min(1);

const tokenSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  description: Joi.string().trim().max(500).allow('', null),
  scopes: Joi.array().items(Joi.string().trim().max(80)).max(200).default([]),
  expiresInDays: Joi.number().integer().min(1).max(apiTokenService.MAX_EXPIRY_DAYS),
});

const mintLimiter = userRateLimiter({ keyPrefix: 'rl:svc-token-mint', windowSeconds: 60, max: 10 });

router.get(
  '/',
  requirePermission('service_accounts.view'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await serviceAccountService.list(req.orgId) });
  })
);

router.post(
  '/',
  requirePermission('service_accounts.manage'),
  asyncHandler(async (req, res) => {
    const { error, value } = createSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.details[0].message);
    const data = await serviceAccountService.create(req.orgId, value, actorFromReq(req));
    res.status(201).json({ success: true, data });
  })
);

router.get(
  '/:id',
  requirePermission('service_accounts.view'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await serviceAccountService.get(req.orgId, req.params.id) });
  })
);

router.put(
  '/:id',
  requirePermission('service_accounts.manage'),
  asyncHandler(async (req, res) => {
    const { error, value } = updateSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.details[0].message);
    const data = await serviceAccountService.update(req.orgId, req.params.id, value, actorFromReq(req));
    res.json({ success: true, data });
  })
);

router.delete(
  '/:id',
  requirePermission('service_accounts.manage'),
  audit('service_account.delete', 'User'),
  asyncHandler(async (req, res) => {
    const data = await serviceAccountService.remove(req.orgId, req.params.id, actorFromReq(req));
    res.json({ success: true, data });
  })
);

/** POST /api/service-accounts/:id/tokens — plaintext returned once. */
router.post(
  '/:id/tokens',
  requirePermission('service_accounts.manage'),
  mintLimiter,
  asyncHandler(async (req, res) => {
    const { error, value } = tokenSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.details[0].message);
    const data = await serviceAccountService.issueToken(req.orgId, req.params.id, value, actorFromReq(req));
    res.status(201).json({ success: true, data });
  })
);

router.delete(
  '/:id/tokens/:tokenId',
  requirePermission('service_accounts.manage'),
  asyncHandler(async (req, res) => {
    await serviceAccountService.revokeToken(req.orgId, req.params.id, req.params.tokenId, actorFromReq(req));
    res.json({ success: true, data: { revoked: true } });
  })
);

export default router;
