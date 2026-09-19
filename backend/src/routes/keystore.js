import express from 'express';
import Joi from 'joi';

import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission, requireAnyPermission, can } from '../middleware/rbac.js';
import prisma from '../config/db.js';
import { canBypassProdApproval, isVaultEnabled } from '../services/orgService.js';
import audit from '../middleware/audit.js';
import * as keystoreService from '../services/keystoreService.js';
import * as keyDeploymentService from '../services/keyDeploymentService.js';
import { userRateLimiter } from '../middleware/rateLimiter.js';

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

// A key deployed to a prod host is standing access without an approval, so
// it needs the same right as skipping prod approval (F-09).
async function assertCanDeployTo(req, serverIds) {
  const prodCount = await prisma.server.count({ where: { orgId: req.orgId, id: { in: serverIds }, environment: 'prod' } });
  if (prodCount === 0) return;
  if (!(await canBypassProdApproval(req.orgId, req.user.permissions))) {
    throw new ApiError(403, 'Deploying keys to production servers requires the Production without approval permission', {
      code: 'PERMISSION_DENIED',
      details: { missing: ['access.prod_bypass'] },
    });
  }
}

// ---------------------------------------------------------------------------
// Scope (docs/personal-vault.md). Org items (ownerId null) keep their
// keystore.* permissions; personal items belong to one user, need vault.use
// + the org switch, and are a 404 for everyone else. Each handler resolves
// the ownerId it may act on and passes it to keystoreService, which only
// ever touches rows of that scope.
// ---------------------------------------------------------------------------

const VAULT_OR_KEYSTORE = requireAnyPermission('keystore.view', 'vault.use');

function permissionDenied(missing, message = 'You don’t have permission to do this') {
  return new ApiError(403, message, { code: 'PERMISSION_DENIED', details: { missing: [missing] } });
}

async function assertPersonalAccess(req) {
  if (!(await isVaultEnabled(req.orgId))) {
    throw new ApiError(403, 'The personal vault is turned off for this organization', { code: 'VAULT_DISABLED' });
  }
  if (!can(req, 'vault.use')) throw permissionDenied('vault.use');
}

/** ownerId for a list/create call: `scope` from the query/body. */
async function ownerForScope(req, scope, orgPermission) {
  if (scope === 'personal') {
    await assertPersonalAccess(req);
    return req.user.userId;
  }
  if (!can(req, orgPermission)) throw permissionDenied(orgPermission);
  return null;
}

/**
 * ownerId for an existing item. `orgPermission` applies to org items; the
 * owner of a personal item needs only vault.use (`personalCheck` can add
 * more, e.g. move-to-org also needs keystore.manage).
 */
async function ownerForItem(req, model, id, orgPermission, personalCheck) {
  const row = await prisma[model].findFirst({ where: { id, orgId: req.orgId }, select: { ownerId: true } });
  const notFound = new ApiError(404, model === 'sshKey' ? 'Key not found' : 'Identity not found');
  if (!row) throw notFound;
  if (row.ownerId) {
    if (row.ownerId !== req.user.userId) throw notFound;
    await assertPersonalAccess(req);
    if (personalCheck) personalCheck(req);
    return row.ownerId;
  }
  if (orgPermission && !can(req, orgPermission)) throw permissionDenied(orgPermission);
  return null;
}

const scopeSchema = Joi.string().valid('org', 'personal').default('org');

// ---------------------------------------------------------------------------
// Keys — /api/keystore/keys
// ---------------------------------------------------------------------------

const KEY_TYPES = ['ed25519', 'rsa', 'ecdsa'];

const generateKeySchema = Joi.object({
  scope: scopeSchema,
  name: Joi.string().min(1).max(200).required(),
  description: Joi.string().allow('', null).max(1000),
  keyType: Joi.string().valid(...KEY_TYPES).default('ed25519'),
  bits: Joi.number().integer(),
  comment: Joi.string().allow('', null).max(255),
  passphrase: Joi.string().allow('', null).max(255),
});

const importKeySchema = Joi.object({
  scope: scopeSchema,
  name: Joi.string().min(1).max(200).required(),
  description: Joi.string().allow('', null).max(1000),
  privateKey: Joi.string().required(),
  passphrase: Joi.string().allow('', null).max(255),
  publicKey: Joi.string().allow('', null),
  certificate: Joi.string().allow('', null),
});

const inspectKeySchema = Joi.object({
  privateKey: Joi.string().required(),
  passphrase: Joi.string().allow('', null).max(255),
});

const updateKeySchema = Joi.object({
  name: Joi.string().min(1).max(200),
  description: Joi.string().allow('', null).max(1000),
  comment: Joi.string().allow('', null).max(255),
  certificate: Joi.string().allow(null),
}).min(1);

router.get(
  '/keys',
  VAULT_OR_KEYSTORE,
  asyncHandler(async (req, res) => {
    const ownerId = await ownerForScope(req, req.query.scope, 'keystore.view');
    const result = await keystoreService.listKeys(req.orgId, { search: req.query.search, ownerId });
    res.json({ success: true, data: result });
  })
);

router.get(
  '/keys/:id',
  VAULT_OR_KEYSTORE,
  asyncHandler(async (req, res) => {
    const ownerId = await ownerForItem(req, 'sshKey', req.params.id, 'keystore.view');
    const result = await keystoreService.getKey(req.orgId, req.params.id, { ownerId });
    res.json({ success: true, data: result });
  })
);

router.post(
  '/keys/generate',
  requireAnyPermission('keystore.manage', 'vault.use'),
  audit('keystore.key.generate', 'SshKey'),
  validate(generateKeySchema),
  asyncHandler(async (req, res) => {
    const { scope, ...body } = req.body;
    const ownerId = await ownerForScope(req, scope, 'keystore.manage');
    const result = await keystoreService.generateKey(req.orgId, body, req.user.userId, { ownerId });
    res.status(201).json({ success: true, data: result });
  })
);

const inspectLimiter = userRateLimiter({ keyPrefix: 'rl:key-inspect', windowSeconds: 60, max: 30 });
const importLimiter = userRateLimiter({ keyPrefix: 'rl:key-import', windowSeconds: 60, max: 30 });
const credentialTestLimiter = userRateLimiter({ keyPrefix: 'rl:credential-test', windowSeconds: 60, max: 30 });

router.post(
  '/keys/inspect',
  VAULT_OR_KEYSTORE,
  inspectLimiter,
  validate(inspectKeySchema),
  asyncHandler(async (req, res) => {
    const result = await keystoreService.inspectKey(req.body);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/keys/import',
  requireAnyPermission('keystore.manage', 'vault.use'),
  importLimiter,
  audit('keystore.key.import', 'SshKey'),
  validate(importKeySchema),
  asyncHandler(async (req, res) => {
    const { scope, ...body } = req.body;
    const ownerId = await ownerForScope(req, scope, 'keystore.manage');
    const result = await keystoreService.importKey(req.orgId, body, req.user.userId, { ownerId });
    res.status(201).json({ success: true, data: result });
  })
);

router.patch(
  '/keys/:id',
  requireAnyPermission('keystore.manage', 'vault.use'),
  audit('keystore.key.update', 'SshKey'),
  validate(updateKeySchema),
  asyncHandler(async (req, res) => {
    const ownerId = await ownerForItem(req, 'sshKey', req.params.id, 'keystore.manage');
    const result = await keystoreService.updateKey(req.orgId, req.params.id, req.body, { ownerId });
    res.json({ success: true, data: result });
  })
);

router.delete(
  '/keys/:id',
  requireAnyPermission('keystore.manage', 'vault.use'),
  audit('keystore.key.delete', 'SshKey'),
  asyncHandler(async (req, res) => {
    const ownerId = await ownerForItem(req, 'sshKey', req.params.id, 'keystore.manage');
    const result = await keystoreService.deleteKey(req.orgId, req.params.id, { ownerId });
    res.json({ success: true, data: result });
  })
);

router.post(
  '/keys/:id/export',
  requireAnyPermission('keystore.export_private', 'vault.use'),
  audit('keystore.key.export', 'SshKey'),
  validate(Joi.object({ includePrivate: Joi.boolean().valid(true).required() })),
  asyncHandler(async (req, res) => {
    // Owners may always export their own personal keys (audited).
    const ownerId = await ownerForItem(req, 'sshKey', req.params.id, 'keystore.export_private');
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    const result = await keystoreService.exportKey(req.orgId, req.params.id, req.user.userId, { ownerId });
    res.json({ success: true, data: result });
  })
);

// Personal → organization, one-way. Owner only, and only with keystore.manage.
const requireManage = (req) => {
  if (!can(req, 'keystore.manage')) {
    throw permissionDenied('keystore.manage', 'Moving items into the organization Keystore requires Manage Keystore');
  }
};

router.post(
  '/keys/:id/move-to-org',
  requirePermission('keystore.manage'),
  audit('keystore.key.move_to_org', 'SshKey'),
  asyncHandler(async (req, res) => {
    const ownerId = await ownerForItem(req, 'sshKey', req.params.id, null, requireManage);
    if (!ownerId) throw new ApiError(400, 'This key is already in the organization Keystore');
    const result = await keystoreService.moveKeyToOrg(req.orgId, req.params.id, ownerId);
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
  scope: scopeSchema,
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
  VAULT_OR_KEYSTORE,
  asyncHandler(async (req, res) => {
    const ownerId = await ownerForScope(req, req.query.scope, 'keystore.view');
    const result = await keystoreService.listCredentials(req.orgId, { search: req.query.search, ownerId });
    res.json({ success: true, data: result });
  })
);

router.get(
  '/credentials/:id',
  VAULT_OR_KEYSTORE,
  asyncHandler(async (req, res) => {
    const ownerId = await ownerForItem(req, 'credential', req.params.id, 'keystore.view');
    const result = await keystoreService.getCredential(req.orgId, req.params.id, { ownerId });
    res.json({ success: true, data: result });
  })
);

router.post(
  '/credentials',
  requireAnyPermission('keystore.manage', 'vault.use'),
  audit('keystore.credential.create', 'Credential'),
  validate(createCredentialSchema),
  asyncHandler(async (req, res) => {
    const { scope, ...body } = req.body;
    const ownerId = await ownerForScope(req, scope, 'keystore.manage');
    const result = await keystoreService.createCredential(req.orgId, body, req.user.userId, { ownerId });
    res.status(201).json({ success: true, data: result });
  })
);

router.patch(
  '/credentials/:id',
  requireAnyPermission('keystore.manage', 'vault.use'),
  audit('keystore.credential.update', 'Credential'),
  validate(updateCredentialSchema),
  asyncHandler(async (req, res) => {
    const ownerId = await ownerForItem(req, 'credential', req.params.id, 'keystore.manage');
    const result = await keystoreService.updateCredential(req.orgId, req.params.id, req.body, req.user.userId, { ownerId });
    res.json({ success: true, data: result });
  })
);

router.delete(
  '/credentials/:id',
  requireAnyPermission('keystore.manage', 'vault.use'),
  audit('keystore.credential.delete', 'Credential'),
  asyncHandler(async (req, res) => {
    const ownerId = await ownerForItem(req, 'credential', req.params.id, 'keystore.manage');
    const force = req.query.force === 'true' || req.query.force === true;
    const result = await keystoreService.deleteCredential(req.orgId, req.params.id, { force, ownerId }, req.user.userId);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/credentials/:id/test',
  requireAnyPermission('keystore.test', 'vault.use'),
  credentialTestLimiter,
  audit('keystore.credential.test', 'Credential'),
  validate(testCredentialSchema),
  asyncHandler(async (req, res) => {
    const ownerId = await ownerForItem(req, 'credential', req.params.id, 'keystore.test');
    if (ownerId) {
      // Your own identity: host tests only (prod / DENY guards in the service).
      const result = await keystoreService.testCredential(req.orgId, req.params.id, req.body, req.user.userId, { ownerId });
      res.json({ success: true, data: result });
      return;
    }
    // Testing against an arbitrary host sends the stored secret there — only
    // for people who could read/replace the identity anyway (F-17).
    if (req.body.host && !can(req, 'keystore.manage')) {
      throw new ApiError(403, 'Testing against an arbitrary host requires the Manage Keystore permission — pick a saved server', {
        code: 'PERMISSION_DENIED',
        details: { missing: ['keystore.manage'] },
      });
    }
    const result = await keystoreService.testCredential(req.orgId, req.params.id, req.body, req.user.userId);
    res.json({ success: true, data: result });
  })
);

router.post(
  '/credentials/:id/move-to-org',
  requirePermission('keystore.manage'),
  audit('keystore.credential.move_to_org', 'Credential'),
  asyncHandler(async (req, res) => {
    const ownerId = await ownerForItem(req, 'credential', req.params.id, null, requireManage);
    if (!ownerId) throw new ApiError(400, 'This identity is already in the organization Keystore');
    const result = await keystoreService.moveCredentialToOrg(req.orgId, req.params.id, ownerId);
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
  requirePermission('keystore.deploy'),
  audit('keystore.deployment.create', 'KeyDeployment'),
  validate(createDeploymentSchema),
  asyncHandler(async (req, res) => {
    await assertCanDeployTo(req, req.body.serverIds);
    const result = await keyDeploymentService.createBatch(req.orgId, req.body, req.user.userId);
    res.status(202).json({ success: true, data: result });
  })
);

router.get(
  '/deployments/batches',
  requirePermission('keystore.view'),
  asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 20;
    const result = await keyDeploymentService.listBatches(req.orgId, { limit });
    res.json({ success: true, data: result });
  })
);

router.get(
  '/deployments',
  requirePermission('keystore.view'),
  validateQuery(listDeploymentsQuerySchema),
  asyncHandler(async (req, res) => {
    const result = await keyDeploymentService.listDeployments(req.orgId, req.query);
    res.json({ success: true, data: { deployments: result.deployments }, meta: result.meta });
  })
);

router.post(
  '/deployments/:id/retry',
  requirePermission('keystore.deploy'),
  audit('keystore.deployment.retry', 'KeyDeployment'),
  asyncHandler(async (req, res) => {
    const dep = await prisma.keyDeployment.findFirst({ where: { id: req.params.id, orgId: req.orgId }, select: { serverId: true } });
    if (dep) await assertCanDeployTo(req, [dep.serverId]);
    const result = await keyDeploymentService.retryDeployment(req.orgId, req.params.id, req.user.userId);
    res.json({ success: true, data: result });
  })
);

export default router;
