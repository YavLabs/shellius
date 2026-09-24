/**
 * routes/updates.js — what version is running, what version exists, and what
 * the fleet's collectors are on.
 *
 * Read-only by design. Nothing here downloads, installs or restarts
 * anything: applying an update is still `./update-shellius.sh <tag>`, run by
 * a person on the host. Phase one of the OTA work is "tell somebody", and
 * keeping the endpoint incapable of more than that is what makes it safe to
 * expose at all.
 *
 * Gated on `settings.updates` (super admin by default, non-delegable): the
 * answer is about the whole installation rather than one organization, and an
 * API token must not be able to ask an external service anything on the
 * install's behalf.
 */

import express from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission } from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import rateLimit from 'express-rate-limit';
import Joi from 'joi';
import ApiError from '../utils/ApiError.js';
import * as updateCheckService from '../services/updateCheckService.js';
import * as instanceUpdateService from '../services/instanceUpdateService.js';
import { fleetCollectorVersions } from '../services/collectorFleetService.js';

const router = express.Router();

router.use(authenticate, tenant);

// GET /api/updates — cached; safe to poll from a banner on every page load.
router.get(
  '/',
  requirePermission('settings.updates'),
  asyncHandler(async (req, res) => {
    const status = await updateCheckService.getStatus();
    res.json({ success: true, data: status });
  })
);

/**
 * POST /api/updates/check — bypass the cache.
 *
 * Rate limited hard and separately from the GET. The cache is what keeps this
 * install inside the release API's 60-requests-an-hour allowance; a "check
 * now" button that ignored the cache and had no limit of its own would let
 * one impatient administrator spend the whole budget and leave the banner
 * stuck on "could not check" for an hour.
 */
const checkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many update checks. Try again shortly.' } },
});

router.post(
  '/check',
  requirePermission('settings.updates'),
  checkLimiter,
  audit('updates.check', 'Organization'),
  asyncHandler(async (req, res) => {
    const status = await updateCheckService.getStatus({ force: true });
    res.json({ success: true, data: status });
  })
);

// GET /api/updates/collectors — collector version spread across the fleet.
router.get(
  '/collectors',
  requirePermission('settings.updates'),
  asyncHandler(async (req, res) => {
    const data = await fleetCollectorVersions(req.orgId, req.scope);
    res.json({ success: true, data });
  })
);

// ---------------------------------------------------------------------------
// Self-update: requesting an upgrade, and the helper that performs it
// ---------------------------------------------------------------------------
//
// Nothing in this section upgrades anything. It records an intent and reports
// what the host-side helper did with it — see
// services/instanceUpdateService.js for why the application deliberately has
// no capability to upgrade itself, and docs/instance-updates.md for how to
// install the helper.

const requestSchema = Joi.object({
  version: Joi.string().max(64).required(),
});

// GET /api/updates/self — status, pending request, whether a helper exists.
router.get(
  '/self',
  requirePermission('settings.updates'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await instanceUpdateService.status() });
  })
);

router.post(
  '/self/request',
  requirePermission('settings.updates'),
  audit('instance_update.requested', 'Organization'),
  asyncHandler(async (req, res) => {
    const { error, value } = requestSchema.validate(req.body || {}, { stripUnknown: true });
    if (error) throw new ApiError(400, error.message);
    const row = await instanceUpdateService.request(value.version, req.user.userId);
    res.status(201).json({ success: true, data: { request: row } });
  })
);

router.delete(
  '/self/request/:id',
  requirePermission('settings.updates'),
  audit('instance_update.cancelled', 'Organization'),
  asyncHandler(async (req, res) => {
    const row = await instanceUpdateService.cancel(req.params.id);
    res.json({ success: true, data: { request: row } });
  })
);

// --- the helper's own endpoints ---------------------------------------------
//
// The helper authenticates as a service account holding `settings.updates`,
// exactly like any other API client. It gets no special credential type and no
// bypass: if its token is revoked it stops working, and everything it does is
// in the audit log under that identity.

const helperPollSchema = Joi.object({
  helperVersion: Joi.string().max(64).allow('', null),
  hostname: Joi.string().max(255).allow('', null),
});

router.post(
  '/self/poll',
  requirePermission('settings.updates'),
  asyncHandler(async (req, res) => {
    const { error, value } = helperPollSchema.validate(req.body || {}, { stripUnknown: true });
    if (error) throw new ApiError(400, error.message);
    await instanceUpdateService.touchHelper({
      helperVersion: value.helperVersion || null,
      hostname: value.hostname || null,
    });
    const row = await instanceUpdateService.pending();
    // Only a request nobody has picked up is handed out. A 'claimed' or
    // 'running' row belongs to a run already under way.
    res.json({
      success: true,
      data: { request: row && row.status === 'requested' ? row : null },
    });
  })
);

router.post(
  '/self/claim/:id',
  requirePermission('settings.updates'),
  audit('instance_update.claimed', 'Organization'),
  asyncHandler(async (req, res) => {
    const row = await instanceUpdateService.claim(req.params.id);
    if (!row) throw new ApiError(409, 'That request is no longer available to claim');
    res.json({ success: true, data: { request: row } });
  })
);

const statusSchema = Joi.object({
  status: Joi.string().valid('running', 'succeeded', 'failed').required(),
  detail: Joi.string().max(4000).allow('', null),
});

router.post(
  '/self/status/:id',
  requirePermission('settings.updates'),
  audit('instance_update.status', 'Organization'),
  asyncHandler(async (req, res) => {
    const { error, value } = statusSchema.validate(req.body || {}, { stripUnknown: true });
    if (error) throw new ApiError(400, error.message);
    const row = await instanceUpdateService.reportStatus(req.params.id, value.status, value.detail);
    res.json({ success: true, data: { request: row } });
  })
);

export default router;
