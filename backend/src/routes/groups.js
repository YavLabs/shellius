import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission } from '../middleware/rbac.js';
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
  requirePermission('groups.view'),
  asyncHandler(async (req, res) => {
    const groups = await groupService.listGroups(req.orgId);
    res.json({ success: true, data: { groups } });
  })
);

router.get(
  '/:id',
  requirePermission('groups.view'),
  asyncHandler(async (req, res) => {
    const group = await groupService.getGroup(req.orgId, req.params.id);
    res.json({ success: true, data: { group } });
  })
);

router.post(
  '/',
  requirePermission('groups.manage'),
  audit('group.create', 'Group'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const group = await groupService.createGroup(req.orgId, req.body);
    res.status(201).json({ success: true, data: { group } });
  })
);

router.put(
  '/:id',
  requirePermission('groups.manage'),
  audit('group.update', 'Group'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const group = await groupService.updateGroup(req.orgId, req.params.id, req.body);
    res.json({ success: true, data: { group } });
  })
);

router.get(
  '/:id/delete-impact',
  requirePermission('groups.manage'),
  asyncHandler(async (req, res) => {
    const impact = await groupService.getGroupDeleteImpact(req.orgId, req.params.id);
    res.json({ success: true, data: impact });
  })
);

router.delete(
  '/:id',
  requirePermission('groups.manage'),
  audit('group.delete', 'Group'),
  asyncHandler(async (req, res) => {
    await groupService.deleteGroup(req.orgId, req.params.id);
    res.json({ success: true, data: { success: true } });
  })
);

router.post(
  '/:id/members',
  requirePermission('groups.manage'),
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
  requirePermission('groups.manage'),
  audit('group.member.removed', 'Group'),
  asyncHandler(async (req, res) => {
    await groupService.removeMember(req.orgId, req.params.id, req.params.userId);
    res.json({ success: true, data: { success: true } });
  })
);

export default router;
