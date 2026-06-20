import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as groupService from '../services/groupService.js';

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

const createSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  description: Joi.string().max(2000).allow('', null),
});

const updateSchema = Joi.object({
  name: Joi.string().min(1).max(200),
  description: Joi.string().max(2000).allow('', null),
}).min(1);

const memberSchema = Joi.object({
  userId: Joi.string().required(),
});

router.use(authenticate, tenant);

router.get(
  '/',
  requireRole('super_admin', 'admin', 'manager'),
  asyncHandler(async (req, res) => {
    const groups = await groupService.listGroups(req.orgId);
    res.json({ success: true, data: { groups } });
  })
);

router.get(
  '/:id',
  requireRole('super_admin', 'admin', 'manager'),
  asyncHandler(async (req, res) => {
    const group = await groupService.getGroup(req.orgId, req.params.id);
    res.json({ success: true, data: { group } });
  })
);

router.post(
  '/',
  requireRole('super_admin', 'admin'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const group = await groupService.createGroup(req.orgId, req.body);
    res.status(201).json({ success: true, data: { group } });
  })
);

router.put(
  '/:id',
  requireRole('super_admin', 'admin'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const group = await groupService.updateGroup(req.orgId, req.params.id, req.body);
    res.json({ success: true, data: { group } });
  })
);

router.delete(
  '/:id',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    await groupService.deleteGroup(req.orgId, req.params.id);
    res.json({ success: true, data: { success: true } });
  })
);

router.post(
  '/:id/members',
  requireRole('super_admin', 'admin'),
  audit('group.member.added', 'Group'),
  validate(memberSchema),
  asyncHandler(async (req, res) => {
    const membership = await groupService.addMember(
      req.orgId,
      req.params.id,
      req.body.userId,
      req.user.userId
    );
    res.status(201).json({ success: true, data: { membership } });
  })
);

router.delete(
  '/:id/members/:userId',
  requireRole('super_admin', 'admin'),
  audit('group.member.removed', 'Group'),
  asyncHandler(async (req, res) => {
    await groupService.removeMember(req.orgId, req.params.id, req.params.userId);
    res.json({ success: true, data: { success: true } });
  })
);

export default router;
