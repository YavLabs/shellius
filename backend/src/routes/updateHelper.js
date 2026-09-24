/**
 * routes/updateHelper.js — the three endpoints the host-side self-update
 * helper talks to.
 *
 * Mounted at /api/updates/helper, OUTSIDE routes/updates.js's
 * `authenticate, tenant` chain, because the helper is not a user and has no
 * organization. It carries a purpose-built credential — see
 * middleware/updateHelperAuth.js for why it is not an API token.
 *
 * What a holder of this credential can do, in full: learn whether an upgrade
 * has been requested, claim it, and report how it went. It cannot read or
 * write any organization's data, cannot create a request, and cannot choose
 * a version — the version comes from a request a human made through the
 * permission-gated endpoint.
 */

import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import updateHelperAuth from '../middleware/updateHelperAuth.js';
import * as instanceUpdateService from '../services/instanceUpdateService.js';

const router = express.Router();

router.use(updateHelperAuth);

const pollSchema = Joi.object({
  helperVersion: Joi.string().max(64).allow('', null),
  hostname: Joi.string().max(255).allow('', null),
});

router.post(
  '/poll',
  asyncHandler(async (req, res) => {
    const { error, value } = pollSchema.validate(req.body || {}, { stripUnknown: true });
    if (error) throw new ApiError(400, error.message);

    await instanceUpdateService.touchHelper({
      helperVersion: value.helperVersion || null,
      hostname: value.hostname || null,
    });

    const row = await instanceUpdateService.pending();
    // Only a request nobody has picked up is handed out. A 'claimed' or
    // 'running' row belongs to a run already under way — handing it out again
    // is how one host ends up running two upgrades.
    res.json({ success: true, data: { request: row && row.status === 'requested' ? row : null } });
  })
);

router.post(
  '/claim/:id',
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
  '/status/:id',
  asyncHandler(async (req, res) => {
    const { error, value } = statusSchema.validate(req.body || {}, { stripUnknown: true });
    if (error) throw new ApiError(400, error.message);
    const row = await instanceUpdateService.reportStatus(req.params.id, value.status, value.detail);
    res.json({ success: true, data: { request: row } });
  })
);

export default router;
