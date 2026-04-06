import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import * as userService from '../services/userService.js';

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

const ROLES = ['super_admin', 'admin', 'operator', 'viewer'];
const STATUSES = ['active', 'invited', 'suspended', 'deactivated'];

const createSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required(),
  name: Joi.string().min(1).max(200).required(),
  password: Joi.string().min(8).max(200).required(),
  role: Joi.string().valid(...ROLES).default('viewer'),
  managerId: Joi.string().allow(null),
});

const updateSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }),
  name: Joi.string().min(1).max(200),
  password: Joi.string().min(8).max(200),
  role: Joi.string().valid(...ROLES),
  status: Joi.string().valid(...STATUSES),
  managerId: Joi.string().allow(null),
  avatarUrl: Joi.string().uri().allow(null, ''),
}).min(1);

const sshKeySchema = Joi.object({
  publicKey: Joi.string().required(),
});

router.use(authenticate, tenant);

router.get(
  '/',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const result = await userService.listUsers(req.orgId, req.query);
    res.json({ success: true, data: result });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (id !== req.user.userId && !['super_admin', 'admin'].includes(req.user.role)) {
      throw new ApiError(403, 'Insufficient permissions');
    }
    const user = await userService.getUser(req.orgId, id);
    res.json({ success: true, data: { user } });
  })
);

router.post(
  '/',
  requireRole('super_admin', 'admin'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const user = await userService.createUser(req.orgId, req.body, req.user.role);
    res.status(201).json({ success: true, data: { user } });
  })
);

router.put(
  '/:id',
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const isSelf = id === req.user.userId;
    const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
    if (!isSelf && !isAdmin) throw new ApiError(403, 'Insufficient permissions');

    if (isSelf && !isAdmin) {
      const allowed = ['name', 'password', 'avatarUrl'];
      for (const key of Object.keys(req.body)) {
        if (!allowed.includes(key)) {
          throw new ApiError(403, `You cannot change '${key}' on your own account`);
        }
      }
    }

    const user = await userService.updateUser(
      req.orgId,
      id,
      req.body,
      req.user.userId,
      req.user.role
    );
    res.json({ success: true, data: { user } });
  })
);

router.delete(
  '/:id',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    await userService.deleteUser(req.orgId, req.params.id);
    res.json({ success: true, data: { success: true } });
  })
);

router.put(
  '/:id/ssh-key',
  validate(sshKeySchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (id !== req.user.userId && !['super_admin', 'admin'].includes(req.user.role)) {
      throw new ApiError(403, 'Insufficient permissions');
    }
    await userService.uploadSshKey(req.orgId, id, req.body.publicKey);
    res.json({ success: true, data: { success: true } });
  })
);

router.delete(
  '/:id/ssh-key',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (id !== req.user.userId && !['super_admin', 'admin'].includes(req.user.role)) {
      throw new ApiError(403, 'Insufficient permissions');
    }
    await userService.removeSshKey(req.orgId, id);
    res.json({ success: true, data: { success: true } });
  })
);

router.get(
  '/:id/reports',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const reports = await userService.getDirectReports(req.orgId, req.params.id);
    res.json({ success: true, data: { reports } });
  })
);

export default router;
