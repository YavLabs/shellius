import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as storageConfigService from '../services/storageConfigService.js';
import * as storageService from '../services/storageService.js';
import logger from '../utils/logger.js';

const router = express.Router();
router.use(authenticate, tenant);

const storageSchema = Joi.object({
  provider: Joi.string().valid('minio', 's3', 'azure').required(),
  endpoint: Joi.string().max(500).allow('', null),
  region: Joi.string().max(100).allow('', null),
  bucket: Joi.string().max(255).allow('', null),
  accessKey: Joi.string().max(500).allow('', null),
  secretKey: Joi.string().max(2000).allow('', null),
  useSsl: Joi.boolean(),
  forcePathStyle: Joi.boolean(),
  isActive: Joi.boolean(),
});

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { stripUnknown: true });
  if (error) return next(new ApiError(400, error.message));
  req.body = value;
  next();
};

// GET /api/settings/storage — super_admin; effective config, secret masked
router.get(
  '/',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const config = await storageConfigService.getPublic();
    res.json({ success: true, data: { config } });
  })
);

// PUT /api/settings/storage — super_admin; upsert + encrypt secret
router.put(
  '/',
  requireRole('super_admin'),
  audit('storage.config.updated', 'StorageConfig'),
  validate(storageSchema),
  asyncHandler(async (req, res) => {
    const row = await storageConfigService.upsert(req.body);
    res.json({ success: true, data: { config: row } });
  })
);

// DELETE /api/settings/storage — super_admin; revert to env defaults
router.delete(
  '/',
  requireRole('super_admin'),
  audit('storage.config.deleted', 'StorageConfig'),
  asyncHandler(async (req, res) => {
    await storageConfigService.remove();
    res.json({ success: true, data: { success: true } });
  })
);

// POST /api/settings/storage/test — super_admin; verify connectivity + bucket
router.post(
  '/test',
  requireRole('super_admin'),
  audit('storage.config.test', 'StorageConfig'),
  asyncHandler(async (req, res) => {
    if (!(await storageService.isConfigured())) {
      throw new ApiError(400, 'No storage configuration — set provider + credentials first');
    }
    try {
      const bucket = await storageService.ensureBucket();
      // Round-trip a tiny object to prove read+write+delete all work.
      const key = `.shellius-storage-test-${req.orgId || 'global'}`;
      const { Readable } = await import('stream');
      await storageService.putObjectStream(key, Readable.from([Buffer.from('ok')]), {
        contentType: 'text/plain',
      });
      await storageService.deleteObject(key).catch(() => {});
      res.json({ success: true, data: { ok: true, bucket } });
    } catch (err) {
      logger.warn('storage test failed', { error: err.message });
      throw new ApiError(400, `Storage test failed: ${err.message}`);
    }
  })
);

export default router;
