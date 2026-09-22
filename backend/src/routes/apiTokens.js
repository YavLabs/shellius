/**
 * /api/tokens — a person's own API tokens.
 *
 * Self-service only: every route here acts on the caller's own tokens and
 * never takes a user id, so `tokens.personal` can't be turned into a way to
 * read or revoke someone else's credential. Managing other people's tokens
 * lives on the users router behind `tokens.view_all` / `tokens.revoke_any`.
 *
 * This whole router is on the API-token deny-list (middleware/apiTokenAuth.js)
 * — a token must never be able to mint another token.
 */

import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission } from '../middleware/rbac.js';
import { userRateLimiter } from '../middleware/rateLimiter.js';
import { actorFromReq } from '../services/roleService.js';
import * as apiTokenService from '../services/apiTokenService.js';

const router = express.Router();

router.use(authenticate, tenant, requirePermission('tokens.personal'));

const createSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  description: Joi.string().trim().max(500).allow('', null),
  scopes: Joi.array().items(Joi.string().trim().max(80)).max(200).default([]),
  expiresInDays: Joi.number().integer().min(1).max(apiTokenService.MAX_EXPIRY_DAYS),
});

// Minting is cheap for us and valuable to an attacker who has a session, so
// it is rate-limited per user rather than per IP.
const mintLimiter = userRateLimiter({ keyPrefix: 'rl:token-mint', windowSeconds: 60, max: 10 });

/** GET /api/tokens — the caller's own tokens. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const data = await apiTokenService.listForUser(req.orgId, req.user.userId);
    res.json({ success: true, data });
  })
);

/** POST /api/tokens — mint one. The plaintext is in this response only. */
router.post(
  '/',
  mintLimiter,
  asyncHandler(async (req, res) => {
    const { error, value } = createSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.details[0].message);

    const result = await apiTokenService.create(
      req.orgId,
      { ...value, userId: req.user.userId, kind: 'personal' },
      actorFromReq(req)
    );
    res.status(201).json({ success: true, data: result });
  })
);

/** POST /api/tokens/:id/rotate — new secret, same token. */
router.post(
  '/:id/rotate',
  mintLimiter,
  asyncHandler(async (req, res) => {
    const result = await apiTokenService.rotate(
      req.orgId,
      req.params.id,
      { userId: req.user.userId },
      actorFromReq(req)
    );
    res.json({ success: true, data: result });
  })
);

/** DELETE /api/tokens/:id — revoke. */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await apiTokenService.revoke(
      req.orgId,
      req.params.id,
      { userId: req.user.userId, reason: 'Revoked by its owner' },
      actorFromReq(req)
    );
    res.json({ success: true, data: { revoked: true } });
  })
);

export default router;
