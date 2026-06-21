import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as policyService from '../services/policyService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shared Joi schemas
// ---------------------------------------------------------------------------

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
const EFFECTS = ['ALLOW', 'DENY'];
const SUBJECT_TYPES = ['USER', 'GROUP', 'ROLE'];
const ORG_ROLES = ['super_admin', 'admin', 'manager', 'member'];

const subjectSchema = Joi.object({
  subjectType: Joi.string().valid(...SUBJECT_TYPES).required(),
  subjectId: Joi.when('subjectType', {
    is: 'ROLE',
    then: Joi.string().valid(...ORG_ROLES).required(),
    otherwise: Joi.string().required(),
  }),
});

// Phase 21A — JIT OS provisioning block embedded in AccessPolicy.
const osProvisioningSchema = Joi.object({
  linuxGroups: Joi.array().items(Joi.string().pattern(/^[a-z][a-z0-9_-]{0,31}$/)).default([]),
  sudo: Joi.boolean().default(false),
  aclReadPaths: Joi.array().items(Joi.string().pattern(/^\/[^\0]*$/)).default([]),
  aclRecursive: Joi.boolean().default(false),
  hardCutoff: Joi.boolean().default(false),
}).default({});

const policyBodySchema = Joi.object({
  name: Joi.string().min(1).max(255).required(),
  description: Joi.string().allow('', null).max(1000),
  effect: Joi.string().valid(...EFFECTS).required(),
  customerId: Joi.string().allow(null),
  targetEnvironments: Joi.array().items(Joi.string().valid(...ENVIRONMENTS)).default([]),
  targetLabels: Joi.object().default({}),
  targetServerIds: Joi.array().items(Joi.string()).default([]),
  allowedPrincipals: Joi.array().items(Joi.string()).default([]),
  maxSessionDuration: Joi.number().integer().min(60).max(604800).required(),
  requireApproval: Joi.boolean().default(false),
  autoApprove: Joi.boolean().default(false),
  isActive: Joi.boolean().default(true),
  priority: Joi.number().integer().min(1).max(9999).default(100),
  osProvisioning: osProvisioningSchema,
  allowKeyDownload: Joi.boolean().default(false),
  isBreakGlass: Joi.boolean().default(false),
  approverGroupId: Joi.string().allow(null, ''),
  approverRoles: Joi.array().items(Joi.string().valid(...ORG_ROLES)).default([]),
  approverUserIds: Joi.array().items(Joi.string()).default([]),
  subjects: Joi.array().items(subjectSchema).default([]),
});

const policyUpdateSchema = Joi.object({
  name: Joi.string().min(1).max(255),
  description: Joi.string().allow('', null).max(1000),
  effect: Joi.string().valid(...EFFECTS),
  customerId: Joi.string().allow(null),
  targetEnvironments: Joi.array().items(Joi.string().valid(...ENVIRONMENTS)),
  targetLabels: Joi.object(),
  targetServerIds: Joi.array().items(Joi.string()),
  allowedPrincipals: Joi.array().items(Joi.string()),
  maxSessionDuration: Joi.number().integer().min(60).max(604800),
  requireApproval: Joi.boolean(),
  autoApprove: Joi.boolean(),
  isActive: Joi.boolean(),
  priority: Joi.number().integer().min(1).max(9999),
  osProvisioning: osProvisioningSchema,
  allowKeyDownload: Joi.boolean(),
  isBreakGlass: Joi.boolean(),
  approverGroupId: Joi.string().allow(null, ''),
  approverRoles: Joi.array().items(Joi.string().valid(...ORG_ROLES)),
  approverUserIds: Joi.array().items(Joi.string()),
  subjects: Joi.array().items(subjectSchema),
}).min(1);

const listQuerySchema = Joi.object({
  customerId: Joi.string(),
  effect: Joi.string().valid(...EFFECTS),
  isActive: Joi.boolean(),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(25),
});

const draftPolicySchema = Joi.object({
  name: Joi.string().min(1).max(255).required(),
  effect: Joi.string().valid('ALLOW', 'DENY').required(),
  targetEnvironments: Joi.array().items(Joi.string().valid(...ENVIRONMENTS)).default([]),
  targetLabels: Joi.object().default({}),
  targetServerIds: Joi.array().items(Joi.string()).default([]),
  allowedPrincipals: Joi.array().items(Joi.string()).default([]),
  maxSessionDuration: Joi.number().integer().min(60).max(604800).required(),
  requireApproval: Joi.boolean().default(false),
  autoApprove: Joi.boolean().default(false),
  priority: Joi.number().integer().min(1).max(9999).default(100),
  customerId: Joi.string().allow(null),
  subjects: Joi.array().items(subjectSchema).default([]),
});

// evaluate accepts any combination of the optional policyId / policy fields;
// the route handler decides how to interpret them.
const evaluateBodySchema = Joi.object({
  userId: Joi.string().required(),
  serverId: Joi.string().required(),
  requestedPrincipal: Joi.string(),
  policyId: Joi.string(),          // evaluate a saved policy by id
  policy: draftPolicySchema,       // evaluate a draft policy inline
});

// ---------------------------------------------------------------------------
// All routes require JWT auth + tenant extraction
// ---------------------------------------------------------------------------

router.use(authenticate, tenant);

// ---------------------------------------------------------------------------
// GET /api/policies/my-access — any authenticated user
// Must be registered before /:id to avoid matching "my-access" as an id param
// ---------------------------------------------------------------------------

router.get(
  '/my-access',
  asyncHandler(async (req, res) => {
    const results = await policyService.getAccessibleServers(req.orgId, req.user.userId);
    res.json({ success: true, data: { accessibleServers: results } });
  })
);

// ---------------------------------------------------------------------------
// POST /api/policies/evaluate — admin+ — debugging/admin tool
// Must be registered before /:id for the same reason
// ---------------------------------------------------------------------------

router.post(
  '/evaluate',
  requireRole('super_admin', 'admin'),
  validate(evaluateBodySchema),
  asyncHandler(async (req, res) => {
    const { userId, serverId, requestedPrincipal, policyId, policy } = req.body;
    const result = await policyService.evaluate({
      orgId: req.orgId,
      userId,
      serverId,
      requestedPrincipal,
      // Pass through so the service can evaluate against a specific saved
      // policy or a draft policy object; fall back to org-wide if neither.
      policyId,
      draftPolicy: policy,
    });

    // Derive the canonical outcome string for the frontend contract:
    //   'allow' | 'deny' | 'requires_approval'
    // The service returns allowed: boolean + requiresApproval: boolean.
    // requiresApproval takes precedence over allowed because prod servers
    // return { allowed: false, requiresApproval: true }.
    let outcome;
    if (result.requiresApproval) {
      outcome = 'requires_approval';
    } else if (result.allowed) {
      outcome = 'allow';
    } else {
      outcome = 'deny';
    }

    res.json({ success: true, data: { ...result, outcome } });
  })
);

// ---------------------------------------------------------------------------
// GET /api/policies — admin+
// ---------------------------------------------------------------------------

router.get(
  '/',
  requireRole('super_admin', 'admin'),
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const result = await policyService.list(req.orgId, req.query);
    res.json({ success: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// POST /api/policies — admin+
// ---------------------------------------------------------------------------

router.post(
  '/',
  requireRole('super_admin', 'admin'),
  audit('policy.create', 'AccessPolicy'),
  validate(policyBodySchema),
  asyncHandler(async (req, res) => {
    const policy = await policyService.create(req.orgId, req.body);
    res.status(201).json({ success: true, data: { policy } });
  })
);

// ---------------------------------------------------------------------------
// GET /api/policies/:id — admin+
// ---------------------------------------------------------------------------

router.get(
  '/:id',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const policy = await policyService.getById(req.orgId, req.params.id);
    res.json({ success: true, data: { policy } });
  })
);

// ---------------------------------------------------------------------------
// PUT /api/policies/:id — admin+
// ---------------------------------------------------------------------------

router.put(
  '/:id',
  requireRole('super_admin', 'admin'),
  audit('policy.update', 'AccessPolicy'),
  validate(policyUpdateSchema),
  asyncHandler(async (req, res) => {
    const policy = await policyService.update(req.orgId, req.params.id, req.body);
    res.json({ success: true, data: { policy } });
  })
);

// ---------------------------------------------------------------------------
// DELETE /api/policies/:id — admin+
// ---------------------------------------------------------------------------

router.get(
  '/:id/delete-impact',
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const impact = await policyService.getDeleteImpact(req.orgId, req.params.id);
    res.json({ success: true, data: impact });
  })
);

router.delete(
  '/:id',
  requireRole('super_admin', 'admin'),
  audit('policy.delete', 'AccessPolicy'),
  asyncHandler(async (req, res) => {
    await policyService.del(req.orgId, req.params.id);
    res.json({ success: true, data: { success: true } });
  })
);

export default router;
