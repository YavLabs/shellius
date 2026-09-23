/**
 * /api/settings/chat — where notifications are sent.
 *
 * Gated on `settings.notifications` throughout: super-admin by default and
 * non-delegable, because a destination is an outbound path for server names,
 * requesters' names and the reasons people type — and because a Slack app
 * configured here can carry approve buttons.
 *
 * Secrets are write-only. For every chat platform the URL is itself the
 * credential (a Slack webhook URL, a Google Chat URL with its key and token, a
 * Teams workflow URL with its SAS signature), so the URL is among them.
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
import * as chatService from '../services/notify/chatDestinationService.js';
import { PLATFORMS } from '../services/notify/chat/index.js';
import { describeEvents, SEVERITIES, CHAT_SAFE_EVENT_KEYS } from '../config/notificationEvents.js';

const router = express.Router();

router.use(authenticate, tenant, requirePermission('settings.notifications'));

const settingsSchema = {
  name: Joi.string().trim().min(1).max(100),
  isActive: Joi.boolean(),
  events: Joi.array().items(Joi.string().valid(...CHAT_SAFE_EVENT_KEYS)).max(50),
  environments: Joi.array().items(Joi.string().valid('demo', 'dev', 'staging', 'prod')).max(4),
  customerIds: Joi.array().items(Joi.string()).max(200),
  minSeverity: Joi.string().valid(...SEVERITIES).allow(null, ''),
};

const createSchema = Joi.object({
  platform: Joi.string().valid(...PLATFORMS).required(),
  mode: Joi.string().valid('webhook', 'app'),
  config: Joi.object().unknown(true).default({}),
  ...settingsSchema,
});

const updateSchema = Joi.object({
  mode: Joi.string().valid('webhook', 'app'),
  config: Joi.object().unknown(true),
  ...settingsSchema,
}).min(1);

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

/** Posting a test message hits a third party, so it is limited. */
const testLimiter = userRateLimiter({ keyPrefix: 'rl:chat-test', windowSeconds: 60, max: 10 });

// ---------------------------------------------------------------------------

/** The platforms this build supports, and what each can do. */
router.get(
  '/platforms',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: chatService.listAdapters() });
  })
);

/** Every event a destination may subscribe to. */
router.get(
  '/events',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: describeEvents() });
  })
);

router.get(
  '/destinations',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await chatService.list(req.user.orgId) });
  })
);

router.post(
  '/destinations',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const row = await chatService.create(req.user.orgId, req.body, actorFromReq(req));
    res.status(201).json({ success: true, data: chatService.toPublic(row) });
  })
);

router.put(
  '/destinations/:id',
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const row = await chatService.update(req.user.orgId, req.params.id, req.body, actorFromReq(req));
    res.json({ success: true, data: chatService.toPublic(row) });
  })
);

router.delete(
  '/destinations/:id',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await chatService.remove(req.user.orgId, req.params.id, actorFromReq(req)) });
  })
);

router.post(
  '/destinations/:id/test',
  testLimiter,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await chatService.test(req.user.orgId, req.params.id, actorFromReq(req)) });
  })
);

router.get(
  '/destinations/:id/deliveries',
  asyncHandler(async (req, res) => {
    const rows = await chatService.listDeliveries(req.user.orgId, req.params.id, { limit: req.query.limit });
    res.json({ success: true, data: rows });
  })
);

export default router;
