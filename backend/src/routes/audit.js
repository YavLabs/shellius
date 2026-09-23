import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission } from '../middleware/rbac.js';
import * as auditService from '../services/auditService.js';
import * as retentionService from '../services/audit/retentionService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const validateQuery = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.query, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.query = value;
  next();
};

const listQuerySchema = Joi.object({
  action: Joi.string().max(100),
  actorId: Joi.string(),
  resourceType: Joi.string().max(100),
  resourceId: Joi.string(),
  ip: Joi.string().trim().max(64),
  startDate: Joi.string().isoDate(),
  endDate: Joi.string().isoDate(),
  search: Joi.string().max(200),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
});

const exportQuerySchema = Joi.object({
  action: Joi.string().max(100),
  actorId: Joi.string(),
  resourceType: Joi.string().max(100),
  resourceId: Joi.string(),
  ip: Joi.string().trim().max(64),
  startDate: Joi.string().isoDate(),
  endDate: Joi.string().isoDate(),
  search: Joi.string().max(200),
  format: Joi.string().valid('csv', 'json').default('json'),
});

// ---------------------------------------------------------------------------
// All audit routes require auth + tenant
// ---------------------------------------------------------------------------

router.use(authenticate, tenant);

// ---------------------------------------------------------------------------
// GET /api/audit — admin+; paginated list with filters
// ---------------------------------------------------------------------------

router.get(
  '/',
  requirePermission('audit.view'),
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, limit, ...filters } = req.query;

    const result = await auditService.list({
      orgId: req.orgId,
      filters,
      page,
      limit,
    });

    res.json({
      success: true,
      data: { items: result.items },
      meta: { page: result.page, limit: result.limit, total: result.total },
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/audit/facets — admin+; distinct action/resourceType values
// actually present for the org, so the frontend's pickers never drift from
// what the backend really writes (the old hard-coded lists had a stale
// 'Policy' — the model is `AccessPolicy` — and were missing ~13 real types).
// MUST be registered before /:id-shaped routes if any are added later.
// ---------------------------------------------------------------------------

router.get(
  '/facets',
  requirePermission('audit.view'),
  asyncHandler(async (req, res) => {
    const result = await auditService.facets({ orgId: req.orgId });
    res.json({ success: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// GET /api/audit/export — super_admin only; CSV or JSON download
// ---------------------------------------------------------------------------

router.get(
  '/export',
  requirePermission('audit.export'),
  validateQuery(exportQuerySchema),
  asyncHandler(async (req, res) => {
    const { format, ...filters } = req.query;

    const { buffer, contentType, filename } = await auditService.exportAll({
      orgId: req.orgId,
      filters,
      format,
    });

    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Content-Length', buffer.length);
    res.end(buffer);
  })
);

// ---------------------------------------------------------------------------
// Retention and archives.
//
// `audit.retention` is separate from `audit.view` and `audit.export` on
// purpose: reading the log, taking a copy of it, and deciding how long it
// survives are three different powers.
// ---------------------------------------------------------------------------

const retentionSchema = Joi.object({
  // null means keep everything, which stays the default.
  retentionDays: Joi.number().integer().min(retentionService.MIN_RETENTION_DAYS).allow(null),
  archiveEnabled: Joi.boolean(),
  archiveEncrypt: Joi.boolean(),
  archiveBucket: Joi.string().trim().max(200).allow('', null),
  archivePrefix: Joi.string().trim().max(200),
  deleteWithoutArchive: Joi.boolean(),
}).min(1);

router.get(
  '/retention',
  requirePermission('audit.retention'),
  asyncHandler(async (req, res) => {
    const settings = await retentionService.getSettings(req.orgId);
    // Surface the sink floor: retention and sinks are configured on
    // different screens, and "why has nothing been deleted?" is otherwise
    // very hard to answer.
    const floor = await retentionService.sinkFloor(req.orgId);
    res.json({ success: true, data: { ...settings, heldBySinkUntil: floor } });
  })
);

router.put(
  '/retention',
  requirePermission('audit.retention'),
  asyncHandler(async (req, res) => {
    const { error, value } = retentionSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.details[0].message);
    const data = await retentionService.updateSettings(req.orgId, value, { userId: req.user.userId });
    res.json({ success: true, data });
  })
);

router.get(
  '/archives',
  requirePermission('audit.retention'),
  asyncHandler(async (req, res) => {
    const data = await retentionService.listArchives(req.orgId, { limit: req.query.limit });
    res.json({ success: true, data });
  })
);

export default router;
