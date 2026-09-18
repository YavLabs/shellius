import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as orgService from '../services/orgService.js';

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

// Joi schema for PUT /api/org
// At least one field must be present; slug and id are never allowed.
const updateOrgSchema = Joi.object({
  name: Joi.string().min(1).max(255),
  domain: Joi.string().hostname().allow(null, ''),
  logoUrl: Joi.string().uri().allow(null, ''),
  settings: Joi.object(),
}).min(1);

router.use(authenticate, tenant);

// GET /api/org — any authenticated user
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const organization = await orgService.getOrg(req.orgId);
    res.json({ success: true, data: { organization } });
  })
);

// PUT /api/org — admin+
router.put(
  '/',
  requireRole('admin'),
  audit('org.update', 'Organization'),
  validate(updateOrgSchema),
  asyncHandler(async (req, res) => {
    const organization = await orgService.updateOrg(req.orgId, req.body);
    res.json({ success: true, data: { organization } });
  })
);

// Joi schema for PUT /api/org/access-settings
const updateAccessSettingsSchema = Joi.object({
  prodApprovalBypassMinRole: Joi.string().valid('admin', 'super_admin', 'none').required(),
});

// GET /api/org/access-settings — admin+
router.get(
  '/access-settings',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const settings = await orgService.getAccessSettings(req.orgId);
    res.json({ success: true, data: settings });
  })
);

// PUT /api/org/access-settings — super_admin only
router.put(
  '/access-settings',
  requireRole('super_admin'),
  audit('org.access_settings.update', 'Organization'),
  validate(updateAccessSettingsSchema),
  asyncHandler(async (req, res) => {
    const settings = await orgService.updateAccessSettings(req.orgId, req.body);
    res.json({ success: true, data: settings });
  })
);

export default router;
