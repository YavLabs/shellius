import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { can } from '../middleware/rbac.js';
import * as lookupService from '../services/lookupService.js';

/**
 * GET /api/lookup/:kind?q=&ids=&limit= — options for filter pickers.
 * Read-only, id + label only; see services/lookupService.js.
 */
const router = express.Router();
router.use(authenticate, tenant);

const querySchema = Joi.object({
  q: Joi.string().trim().max(100).allow(''),
  ids: Joi.string().max(2000).allow(''),
  limit: Joi.number().integer().min(1).max(50).default(25),
});

// Who may list which entity. Users are listed to anyone who can already see
// other people's requests, sessions, certificates or audit entries — the
// pages whose filters need a user picker.
const ACCESS = {
  servers: ['servers.view'],
  customers: ['customers.view'],
  users: ['users.view', 'access_requests.view_all', 'sessions.view_all', 'certificates.view_all', 'audit.view'],
};

router.get(
  '/:kind',
  asyncHandler(async (req, res) => {
    const { kind } = req.params;
    const needs = ACCESS[kind];
    if (!needs) throw new ApiError(404, 'Unknown lookup');
    if (!needs.some((k) => can(req, k))) {
      throw new ApiError(403, 'You don’t have permission to do this', { code: 'PERMISSION_DENIED', details: { missing: needs } });
    }
    const { error, value } = querySchema.validate(req.query, { stripUnknown: true });
    if (error) throw new ApiError(400, error.message);
    const ids = value.ids ? value.ids.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50) : [];
    const opts = { q: value.q || '', ids, limit: value.limit };
    let items;
    if (kind === 'servers') items = await lookupService.lookupServers(req.orgId, req.scope, opts);
    else if (kind === 'customers') items = await lookupService.lookupCustomers(req.orgId, req.scope, opts);
    else items = await lookupService.lookupUsers(req.orgId, opts);
    res.json({ success: true, data: { items } });
  })
);

export default router;
