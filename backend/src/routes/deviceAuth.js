import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import * as deviceAuthService from '../services/deviceAuthService.js';

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  }
  req.body = value;
  next();
};

const authorizeSchema = Joi.object({
  org_slug: Joi.string().required(),
  client_id: Joi.string().optional(),
  scope: Joi.string().allow('').optional(),
});

const pollSchema = Joi.object({
  device_code: Joi.string().required(),
});

const codeSchema = Joi.object({
  user_code: Joi.string().required(),
});

router.post(
  '/authorize',
  validate(authorizeSchema),
  asyncHandler(async (req, res) => {
    const { org_slug, client_id, scope } = req.body;
    const result = await deviceAuthService.createDeviceRequest(org_slug, client_id, scope);
    res.json(result);
  })
);

router.post(
  '/poll',
  validate(pollSchema),
  asyncHandler(async (req, res) => {
    const { device_code } = req.body;
    const ip = req.ip;
    const ua = req.get('user-agent') || '';
    try {
      const result = await deviceAuthService.pollDeviceRequest(device_code, ip, ua);
      res.json({ success: true, data: result });
    } catch (err) {
      if (err instanceof ApiError) {
        return res.status(err.statusCode).json({ success: false, error: err.message });
      }
      throw err;
    }
  })
);

router.post(
  '/approve',
  authenticate,
  validate(codeSchema),
  asyncHandler(async (req, res) => {
    const { user_code } = req.body;
    const result = await deviceAuthService.approveDeviceRequest(user_code, req.user.userId);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/deny',
  authenticate,
  validate(codeSchema),
  asyncHandler(async (req, res) => {
    const { user_code } = req.body;
    const result = await deviceAuthService.denyDeviceRequest(user_code, req.user.userId);
    res.json({ success: true, data: result });
  })
);

export default router;
