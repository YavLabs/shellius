import express from 'express';
import Joi from 'joi';

import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as keystoreService from '../services/keystoreService.js';
import * as keyDeploymentService from '../services/keyDeploymentService.js';

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

const validateQuery = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.query, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.query = value;
  next();
};

router.use(authenticate, tenant);

// Viewer roles for list/get/test; admin+ for mutations.
const VIEW_ROLES = ['super_admin', 'admin', 'manager'];
const ADMIN_ROLES = ['super_admin', 'admin'];

// ---------------------------------------------------------------------------
// Keys — /api/keystore/keys
// ---------------------------------------------------------------------------

const KEY_TYPES = ['ed25519', 'rsa', 'ecdsa'];

const generateKeySchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  description: Joi.string().allow('', null).max(1000),
  keyType: Joi.string().valid(...KEY_TYPES).default('ed25519'),
  bits: Joi.number().integer(),
  comment: Joi.string().allow('', null).max(255),
  passphrase: Joi.string().allow('', null).max(255),
});

const importKeySchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  description: Joi.string().allow('', null).max(1000),
  privateKey: Joi.string().required(),
  passphrase: Joi.string().allow('', null).max(255),
});

const updateKeySchema = Joi.object({
  name: Joi.string().min(1).max(200),
  description: Joi.string().allow('', null).max(1000),
  comment: Joi.string().allow('', null).max(255),
}).min(1);

router.get(
  '/keys',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.listKeys(req.orgId, { search: req.query.search });
    res.json({ success: true, data: result });
  })
);

router.get(
  '/keys/:id',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.getKey(req.orgId, req.params.id);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/keys/generate',
  requireRole(...ADMIN_ROLES),
  audit('keystore.key.generate', 'SshKey'),
  validate(generateKeySchema),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.generateKey(req.orgId, req.body, req.user.userId);
    res.status(201).json({ success: true, data: result });
  })
);

router.post(
  '/keys/import',
  requireRole(...ADMIN_ROLES),
  audit('keystore.key.import', 'SshKey'),
  validate(importKeySchema),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.importKey(req.orgId, req.body, req.user.userId);
    res.status(201).json({ success: true, data: result });
  })
);

router.patch(
  '/keys/:id',
  requireRole(...ADMIN_ROLES),
  audit('keystore.key.update', 'SshKey'),
  validate(updateKeySchema),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.updateKey(req.orgId, req.params.id, req.body);
    res.json({ success: true, data: result });
  })
);

router.delete(
  '/keys/:id',
  requireRole(...ADMIN_ROLES),
  audit('keystore.key.delete', 'SshKey'),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.deleteKey(req.orgId, req.params.id);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/keys/:id/export',
  requireRole(...ADMIN_ROLES),
  audit('keystore.key.export', 'SshKey'),
  validate(Joi.object({ includePrivate: Joi.boolean().valid(true).required() })),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    const result = await keystoreService.exportKey(req.orgId, req.params.id, req.user.userId);
    res.json({ success: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// Credentials ("Identities") — /api/keystore/credentials
// ---------------------------------------------------------------------------

const AUTH_TYPES = ['password', 'key', 'key_password'];

const newKeySchema = Joi.alternatives().try(
  Joi.object({
    generate: Joi.boolean().valid(true).required(),
    keyType: Joi.string().valid(...KEY_TYPES),
    bits: Joi.number().integer(),
    passphrase: Joi.string().allow('', null).max(255),
  }),
  Joi.object({
    privateKey: Joi.string().required(),
    passphrase: Joi.string().allow('', null).max(255),
  })
);

const createCredentialSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  description: Joi.string().allow('', null).max(1000),
  username: Joi.string().min(1).max(255).required(),
  authType: Joi.string().valid(...AUTH_TYPES).required(),
  password: Joi.string().allow('', null).max(1000),
  sshKeyId: Joi.string(),
  newKey: newKeySchema,
  tags: Joi.array().items(Joi.string()),
});

const updateCredentialSchema = Joi.object({
  name: Joi.string().min(1).max(200),
  description: Joi.string().allow('', null).max(1000),
  username: Joi.string().min(1).max(255),
  authType: Joi.string().valid(...AUTH_TYPES),
  password: Joi.string().allow('', null).max(1000),
  clearPassword: Joi.boolean(),
  sshKeyId: Joi.string().allow(null),
  newKey: newKeySchema,
  tags: Joi.array().items(Joi.string()),
}).min(1);

const testCredentialSchema = Joi.object({
  serverId: Joi.string(),
  host: Joi.string(),
  port: Joi.number().integer().min(1).max(65535).default(22),
}).xor('serverId', 'host');

router.get(
  '/credentials',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.listCredentials(req.orgId, { search: req.query.search });
    res.json({ success: true, data: result });
  })
);

router.get(
  '/credentials/:id',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.getCredential(req.orgId, req.params.id);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/credentials',
  requireRole(...ADMIN_ROLES),
  audit('keystore.credential.create', 'Credential'),
  validate(createCredentialSchema),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.createCredential(req.orgId, req.body, req.user.userId);
    res.status(201).json({ success: true, data: result });
  })
);

router.patch(
  '/credentials/:id',
  requireRole(...ADMIN_ROLES),
  audit('keystore.credential.update', 'Credential'),
  validate(updateCredentialSchema),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.updateCredential(req.orgId, req.params.id, req.body, req.user.userId);
    res.json({ success: true, data: result });
  })
);

router.delete(
  '/credentials/:id',
  requireRole(...ADMIN_ROLES),
  audit('keystore.credential.delete', 'Credential'),
  asyncHandler(async (req, res) => {
    const force = req.query.force === 'true' || req.query.force === true;
    const result = await keystoreService.deleteCredential(req.orgId, req.params.id, { force }, req.user.userId);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/credentials/:id/test',
  requireRole(...VIEW_ROLES),
  audit('keystore.credential.test', 'Credential'),
  validate(testCredentialSchema),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.testCredential(req.orgId, req.params.id, req.body, req.user.userId);
    res.json({ success: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// Deployments — /api/keystore/deployments
// ---------------------------------------------------------------------------

const authSchema = Joi.alternatives().try(
  Joi.object({ mode: Joi.string().valid('server').required() }),
  Joi.object({ mode: Joi.string().valid('credential').required(), credentialId: Joi.string().required() })
);

const createDeploymentSchema = Joi.object({
  sshKeyId: Joi.string().required(),
  serverIds: Joi.array().items(Joi.string()).min(1).required(),
  action: Joi.string().valid('deploy', 'remove', 'rotate').required(),
  targetUser: Joi.string().allow('', null),
  auth: authSchema.required(),
  useSudo: Joi.boolean().default(false),
  rotate: Joi.when('action', {
    is: 'rotate',
    then: Joi.object({
      oldSshKeyId: Joi.string().required(),
      updateCredentials: Joi.boolean().default(false),
    }).required(),
    otherwise: Joi.forbidden(),
  }),
});

const listDeploymentsQuerySchema = Joi.object({
  batchId: Joi.string(),
  sshKeyId: Joi.string(),
  serverId: Joi.string(),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(25),
});

router.post(
  '/deployments',
  requireRole(...ADMIN_ROLES),
  audit('keystore.deployment.create', 'KeyDeployment'),
  validate(createDeploymentSchema),
  asyncHandler(async (req, res) => {
    const result = await keyDeploymentService.createBatch(req.orgId, req.body, req.user.userId);
    res.status(202).json({ success: true, data: result });
  })
);

router.get(
  '/deployments/batches',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 20;
    const result = await keyDeploymentService.listBatches(req.orgId, { limit });
    res.json({ success: true, data: result });
  })
);

router.get(
  '/deployments',
  requireRole(...VIEW_ROLES),
  validateQuery(listDeploymentsQuerySchema),
  asyncHandler(async (req, res) => {
    const result = await keyDeploymentService.listDeployments(req.orgId, req.query);
    res.json({ success: true, data: { deployments: result.deployments }, meta: result.meta });
  })
);

router.post(
  '/deployments/:id/retry',
  requireRole(...ADMIN_ROLES),
  audit('keystore.deployment.retry', 'KeyDeployment'),
  asyncHandler(async (req, res) => {
    const result = await keyDeploymentService.retryDeployment(req.orgId, req.params.id, req.user.userId);
    res.json({ success: true, data: result });
  })
);

export default router;
