import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission, requireAnyPermission } from '../middleware/rbac.js';
import * as roleService from '../services/roleService.js';
import { PERMISSIONS, PERMISSION_GROUPS, PERMISSION_KEYS, SYSTEM_ROLES } from '../config/permissions.js';

// ---------------------------------------------------------------------------
// /api/roles — custom roles (docs/rbac/rbac-audit.md "Custom roles: design").
// Reading: roles.view, or users.assign_role (the Users page's role picker).
// Writing: roles.manage, and every escalation rule in roleService.
// ---------------------------------------------------------------------------

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

const permissionList = Joi.array().items(Joi.string().valid(...PERMISSION_KEYS)).unique();
const BASE_ROLES = ['member', 'manager', 'admin'];

const createSchema = Joi.object({
  name: Joi.string().trim().min(1).max(60).required(),
  description: Joi.string().trim().max(300).allow('', null),
  baseRole: Joi.string().valid(...BASE_ROLES),
  permissions: permissionList,
  copyFromRoleId: Joi.string().max(100),
});

const updateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(60),
  description: Joi.string().trim().max(300).allow('', null),
  baseRole: Joi.string().valid(...BASE_ROLES),
  permissions: permissionList,
}).min(1);

const deleteSchema = Joi.object({
  reassignToRoleId: Joi.string().max(100),
});

const meta = (req) => ({ ipAddress: req.ip, userAgent: req.headers['user-agent'] });

router.use(authenticate, tenant);

// GET /api/roles/catalog — permission catalogue for the role editor
router.get(
  '/catalog',
  requireAnyPermission('roles.view', 'users.assign_role'),
  asyncHandler(async (req, res) => {
    const permissions = PERMISSIONS.map(({ key, group, label, description, sensitive }) => ({
      key,
      group,
      label,
      description,
      sensitive,
    }));
    res.json({ success: true, data: { groups: PERMISSION_GROUPS, permissions, systemRoles: SYSTEM_ROLES } });
  })
);

router.get(
  '/',
  requireAnyPermission('roles.view', 'users.assign_role'),
  asyncHandler(async (req, res) => {
    const roles = await roleService.listRoles(req.orgId, roleService.actorFromReq(req));
    res.json({ success: true, data: { roles } });
  })
);

router.get(
  '/:id',
  requirePermission('roles.view'),
  asyncHandler(async (req, res) => {
    const role = await roleService.getRole(req.orgId, req.params.id, roleService.actorFromReq(req));
    res.json({ success: true, data: { role } });
  })
);

router.post(
  '/',
  requirePermission('roles.manage'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const role = await roleService.createRole(req.orgId, roleService.actorFromReq(req), req.body, meta(req));
    res.status(201).json({ success: true, data: { role } });
  })
);

router.put(
  '/:id',
  requirePermission('roles.manage'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const role = await roleService.updateRole(req.orgId, roleService.actorFromReq(req), req.params.id, req.body, meta(req));
    res.json({ success: true, data: { role } });
  })
);

router.post(
  '/:id/reset',
  requirePermission('roles.manage'),
  asyncHandler(async (req, res) => {
    const role = await roleService.resetRole(req.orgId, roleService.actorFromReq(req), req.params.id, meta(req));
    res.json({ success: true, data: { role } });
  })
);

router.delete(
  '/:id',
  requirePermission('roles.manage'),
  validate(deleteSchema),
  asyncHandler(async (req, res) => {
    const result = await roleService.deleteRole(
      req.orgId,
      roleService.actorFromReq(req),
      req.params.id,
      req.body || {},
      meta(req)
    );
    res.json({ success: true, data: result });
  })
);

export default router;
