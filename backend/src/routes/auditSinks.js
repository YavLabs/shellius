/**
 * /api/settings/audit-sinks — where this organization's audit log is copied to.
 *
 * Gated on `audit.sinks` throughout. That permission is super-admin by
 * default and non-delegable: an API token must never be able to point the
 * audit trail somewhere else, or switch it off.
 *
 * Secrets are write-only, as with email providers — responses carry
 * `{ set: true|false }` in their place, and an update that omits a secret
 * keeps the stored one.
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
import { actorFromReq } from '../services/roleService.js';
import * as sinkService from '../services/audit/sinkService.js';
import { SINK_TYPES, describeAdapters } from '../services/audit/sinks/index.js';

const router = express.Router();

router.use(authenticate, tenant, requirePermission('audit.sinks'));

const filtersSchema = Joi.object({
  actions: Joi.array().items(Joi.string().trim().max(100)).max(200),
  resourceTypes: Joi.array().items(Joi.string().trim().max(100)).max(200),
});

const createSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  type: Joi.string().valid(...SINK_TYPES).required(),
  config: Joi.object().unknown(true).default({}),
  filters: filtersSchema.default({}),
  isActive: Joi.boolean().default(false),
  batchSize: Joi.number().integer().min(10).max(2000),
  // Ship history from this instant instead of starting at "now". Left out,
  // a new sink starts from its creation time, so enabling one never replays
  // the whole log into somebody's SIEM by surprise.
  backfillFrom: Joi.date().iso(),
});

const updateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100),
  config: Joi.object().unknown(true),
  filters: filtersSchema,
  isActive: Joi.boolean(),
  batchSize: Joi.number().integer().min(10).max(2000),
}).min(1);

// A test reaches out to a third party, so it is rate-limited per user.
const testLimiter = userRateLimiter({ keyPrefix: 'rl:audit-sink-test', windowSeconds: 60, max: 10 });

/** GET /types — what can be configured, for the form. */
router.get(
  '/types',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: describeAdapters() });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await sinkService.list(req.orgId) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { error, value } = createSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.details[0].message);
    const data = await sinkService.create(req.orgId, value, actorFromReq(req));
    res.status(201).json({ success: true, data });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await sinkService.get(req.orgId, req.params.id) });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { error, value } = updateSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.details[0].message);
    const data = await sinkService.update(req.orgId, req.params.id, value, actorFromReq(req));
    res.json({ success: true, data });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = await sinkService.remove(req.orgId, req.params.id, actorFromReq(req));
    res.json({ success: true, data });
  })
);

router.post(
  '/:id/test',
  testLimiter,
  asyncHandler(async (req, res) => {
    const data = await sinkService.test(req.orgId, req.params.id, actorFromReq(req));
    res.json({ success: true, data });
  })
);

/** Recent attempts — "did those entries actually ship?" without leaving here. */
router.get(
  '/:id/deliveries',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    // Scoped through the sink so one org can't read another's deliveries.
    const sink = await prisma.auditSink.findFirst({ where: { id: req.params.id, orgId: req.orgId }, select: { id: true } });
    if (!sink) throw new ApiError(404, 'Audit sink not found');

    const rows = await prisma.auditSinkDelivery.findMany({
      where: { sinkId: sink.id },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    res.json({ success: true, data: rows });
  })
);

export default router;
