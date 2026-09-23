/**
 * /api/chat/identities — a person's own linked chat accounts.
 *
 * Behind `authenticate`, deliberately and importantly: completing a link is
 * the step that proves the Shellius half of the binding. The token proves the
 * chat half; the session proves this half. Neither is sufficient alone, which
 * is what makes this safe without anyone maintaining a mapping by hand.
 *
 * No permission gate — linking your own chat account is like connecting your
 * own SSO identity on the profile page, and the same service enforces that a
 * chat account cannot be bound to two people.
 */

import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { userRateLimiter } from '../middleware/rateLimiter.js';
import { actorFromReq } from '../services/roleService.js';
import * as chatIdentityService from '../services/notify/chatIdentityService.js';

const router = express.Router();

router.use(authenticate, tenant);

const tokenSchema = Joi.object({ token: Joi.string().length(64).hex().required() });

const linkLimiter = userRateLimiter({ keyPrefix: 'rl:chat-link', windowSeconds: 60, max: 10 });

/** What a pending link is offering to connect, so the page can name it. */
router.get(
  '/pending/:token',
  linkLimiter,
  asyncHandler(async (req, res) => {
    const { error } = tokenSchema.validate({ token: req.params.token });
    if (error) throw new ApiError(400, 'That is not a valid link token');

    const pending = await chatIdentityService.peekLink(req.params.token);
    if (!pending) throw new ApiError(410, 'That link request has expired. Press the button in chat again.');
    // Never echo the org id back; the caller's session decides the org.
    res.json({
      success: true,
      data: { platform: pending.platform, workspaceId: pending.workspaceId, displayName: pending.displayName },
    });
  })
);

router.post(
  '/link',
  linkLimiter,
  asyncHandler(async (req, res) => {
    const { error, value } = tokenSchema.validate(req.body, { stripUnknown: true });
    if (error) throw new ApiError(400, 'That is not a valid link token');

    const identity = await chatIdentityService.completeLink(value.token, {
      userId: req.user.userId,
      orgId: req.user.orgId,
      ipAddress: req.ip,
    });
    res.json({
      success: true,
      data: { id: identity.id, platform: identity.platform, linkedAt: identity.linkedAt },
    });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await chatIdentityService.listForUser(req.user.userId) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = await chatIdentityService.unlink(req.user.orgId, req.user.userId, req.params.id, actorFromReq(req));
    res.json({ success: true, data });
  })
);

export default router;
