import express from 'express';
import Joi from 'joi';

import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import * as searchService from '../services/searchService.js';

const router = express.Router();

const querySchema = Joi.object({
  q: Joi.string().trim().min(2).max(100).required(),
  limit: Joi.number().integer().min(1).max(20).default(5),
});

const validateQuery = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.query, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.query = value;
  next();
};

// Global command-palette search. Role gating is enforced inside
// searchService (per-type, so lower roles simply get empty arrays for
// gated types rather than a 403 for the whole endpoint).
router.get(
  '/',
  apiLimiter,
  authenticate,
  tenant,
  validateQuery(querySchema),
  asyncHandler(async (req, res) => {
    const { q, limit } = req.query;
    const { results, counts } = await searchService.search({
      orgId: req.orgId,
      role: req.user.role,
      q,
      limit,
    });
    res.json({ success: true, data: { results, counts } });
  }),
);

export default router;
