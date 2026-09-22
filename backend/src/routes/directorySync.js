/**
 * /api/settings/directory-sync — reconciling accounts against the IdP.
 *
 * Gated on `settings.sso` throughout, because this is a property of a
 * sign-in provider: whoever may configure how people get in may configure how
 * their leaving is noticed. That permission is already super-admin by default
 * and non-delegable, so an API token cannot arm a deprovisioning job.
 *
 * Secrets are write-only, as with audit sinks and email providers: responses
 * carry `{ set: true|false }` in their place, and an update that omits a
 * secret keeps the stored one.
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
import * as directorySyncService from '../services/directory/directorySyncService.js';
import { ADAPTER_TYPES } from '../services/directory/adapters/index.js';

const router = express.Router();

router.use(authenticate, tenant, requirePermission('settings.sso'));

const settingsSchema = {
  isActive: Joi.boolean(),
  action: Joi.string().valid('flag', 'suspend'),
  dryRun: Joi.boolean(),
  intervalHours: Joi.number().integer().min(1).max(168),
  maxSuspendPercent: Joi.number().integer().min(1).max(100),
  maxSuspendCount: Joi.number().integer().min(1).max(10000),
  graceHours: Joi.number().integer().min(0).max(720),
};

const createSchema = Joi.object({
  ssoConfigId: Joi.string().required(),
  adapter: Joi.string().valid(...ADAPTER_TYPES),
  config: Joi.object().unknown(true).default({}),
  ...settingsSchema,
});

const updateSchema = Joi.object({
  config: Joi.object().unknown(true),
  ...settingsSchema,
}).min(1);

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

/** Reading a directory hits a third party, so the manual buttons are limited. */
const runLimiter = userRateLimiter({ keyPrefix: 'rl:dirsync-run', windowSeconds: 60, max: 5 });

// ---------------------------------------------------------------------------

/** The adapters this build knows about, for the settings form. */
router.get(
  '/adapters',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: directorySyncService.listAdapters() });
  })
);

/**
 * One entry per sign-in provider, whether or not it has a sync — including
 * the ones that cannot have one, with the reason.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await directorySyncService.listForOrg(req.user.orgId) });
  })
);

router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const row = await directorySyncService.create(req.user.orgId, req.body, actorFromReq(req));
    res.status(201).json({ success: true, data: directorySyncService.toPublic(row) });
  })
);

router.put(
  '/:id',
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const row = await directorySyncService.update(req.user.orgId, req.params.id, req.body, actorFromReq(req));
    res.json({ success: true, data: directorySyncService.toPublic(row) });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await directorySyncService.remove(req.user.orgId, req.params.id, actorFromReq(req)) });
  })
);

/** Prove the credential before trusting anything it returns. */
router.post(
  '/:id/test',
  runLimiter,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await directorySyncService.test(req.user.orgId, req.params.id, actorFromReq(req)) });
  })
);

/** Run now. Honours dryRun and every safety valve — it only skips the clock. */
router.post(
  '/:id/run',
  runLimiter,
  asyncHandler(async (req, res) => {
    const run = await directorySyncService.runNow(req.user.orgId, req.params.id, actorFromReq(req));
    res.json({ success: true, data: run });
  })
);

router.get(
  '/:id/runs',
  asyncHandler(async (req, res) => {
    const runs = await directorySyncService.listRuns(req.user.orgId, req.params.id, { limit: req.query.limit });
    res.json({ success: true, data: runs });
  })
);

router.get(
  '/:id/findings',
  asyncHandler(async (req, res) => {
    const findings = await directorySyncService.listFindings(req.user.orgId, req.params.id, {
      status: req.query.status || 'open',
      limit: req.query.limit,
    });
    res.json({ success: true, data: findings });
  })
);

export default router;
