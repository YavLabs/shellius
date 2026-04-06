import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import * as auditService from '../services/auditService.js';

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
  startDate: Joi.string().isoDate(),
  endDate: Joi.string().isoDate(),
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
  requireRole('super_admin', 'admin'),
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
// GET /api/audit/export — super_admin only; CSV or JSON download
// ---------------------------------------------------------------------------

router.get(
  '/export',
  requireRole('super_admin'),
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

export default router;
