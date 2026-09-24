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

// --- the helper credential -------------------------------------------------
//
// Issued here by a human; used by the helper against routes/updateHelper.js,
// which is mounted OUTSIDE this router's authenticate/tenant chain.

router.post(
  '/self/helper-token',
  requirePermission('settings.updates'),
  audit('instance_update.helper_token_issued', 'Organization'),
  asyncHandler(async (req, res) => {
    // Shown once and never again — nothing stores the plaintext, and issuing
    // a new one invalidates whatever came before.
    const token = await instanceUpdateService.issueHelperToken();
    res.status(201).json({ success: true, data: { token } });
  })
);

router.delete(
  '/self/helper-token',
  requirePermission('settings.updates'),
  audit('instance_update.helper_token_revoked', 'Organization'),
  asyncHandler(async (req, res) => {
    await instanceUpdateService.revokeHelperToken();
    res.json({ success: true, data: { revoked: true } });
  })
);

export default router;
