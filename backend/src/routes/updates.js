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
import * as updateCheckService from '../services/updateCheckService.js';
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

export default router;
