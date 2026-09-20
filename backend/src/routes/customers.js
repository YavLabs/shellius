import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import audit from '../middleware/audit.js';
import { requirePermission } from '../middleware/rbac.js';
import * as customerService from '../services/customerService.js';

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

const createSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  slug: Joi.string().pattern(/^[a-z0-9-]{3,30}$/).optional(),
  description: Joi.string().allow('', null).max(1000),
  metadata: Joi.object().unknown(true),
});

const updateSchema = Joi.object({
  name: Joi.string().min(1).max(200),
  description: Joi.string().allow('', null).max(1000),
  metadata: Joi.object().unknown(true),
  isActive: Joi.boolean(),
}).min(1);

router.use(authenticate, tenant);

router.get(
  '/',
  requirePermission('customers.view'),
  asyncHandler(async (req, res) => {
    const result = await customerService.listCustomers(req.orgId, req.query, req.scope);
    res.json({ success: true, data: result });
  })
);

router.get(
  '/:id',
  requirePermission('customers.view'),
  asyncHandler(async (req, res) => {
    const customer = await customerService.getCustomer(req.orgId, req.params.id, req.scope);
    res.json({ success: true, data: { customer } });
  })
);

router.get(
  '/:id/stats',
  requirePermission('customers.view'),
  asyncHandler(async (req, res) => {
    const stats = await customerService.getCustomerStats(req.orgId, req.params.id, req.scope);
    res.json({ success: true, data: stats });
  })
);

router.post(
  '/',
  requirePermission('customers.create'),
  audit('customer.create', 'Customer'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const customer = await customerService.createCustomer(req.orgId, req.body, req.scope, req.user.userId);
    res.status(201).json({ success: true, data: { customer } });
  })
);

router.put(
  '/:id',
  requirePermission('customers.update'),
  audit('customer.update', 'Customer'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const customer = await customerService.updateCustomer(req.orgId, req.params.id, req.body, req.scope);
    res.json({ success: true, data: { customer } });
  })
);

router.get(
  '/:id/delete-impact',
  requirePermission('customers.delete'),
  asyncHandler(async (req, res) => {
    const impact = await customerService.getDeleteImpact(req.orgId, req.params.id, req.scope);
    res.json({ success: true, data: impact });
  })
);

router.delete(
  '/:id',
  requirePermission('customers.delete'),
  audit('customer.delete', 'Customer'),
  asyncHandler(async (req, res) => {
    await customerService.deleteCustomer(req.orgId, req.params.id, req.body || {}, req.scope);
    res.json({ success: true, data: { success: true } });
  })
);

export default router;
