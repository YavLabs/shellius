import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission, can } from '../middleware/rbac.js';
import { actorFromReq } from '../services/roleService.js';
import * as userService from '../services/userService.js';
import audit from '../middleware/audit.js';
import agentAuth from '../middleware/agentAuth.js';
import * as certificateService from '../services/certificateService.js';

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

const CERT_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'];

const issueSchema = Joi.object({
  userId: Joi.string(),
  serverId: Joi.string().required(),
  principals: Joi.array().items(Joi.string().min(1).max(64)).min(1).max(10).required(),
  validitySeconds: Joi.number().integer().min(60).max(604800).required(),
  publicKey: Joi.string().required(),
  keyId: Joi.string().max(255),
  certType: Joi.string().valid('USER').default('USER'),
  extensions: Joi.object().default({}),
  criticalOptions: Joi.object().default({}),
  issuedVia: Joi.string().valid('web', 'tui', 'api').default('web'),
});

const listQuerySchema = Joi.object({
  status: Joi.string().valid(...CERT_STATUSES),
  userId: Joi.string(),
  serverId: Joi.string(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
});

const verifySchema = Joi.object({
  serial: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  principal: Joi.string().min(1).required(),
});

// ---------------------------------------------------------------------------
// POST /api/certificates/verify — agent auth (x-agent-token header, per-host
// token or legacy AGENT_SHARED_SECRET — see middleware/agentAuth.js).
// Registered FIRST so it takes priority over /:id for the literal segment.
// Called per SSH connection by check-principals on target hosts.
// ---------------------------------------------------------------------------
router.post(
  '/verify',
  agentAuth,
  validate(verifySchema),
  asyncHandler(async (req, res) => {
    const result = await certificateService.verify({
      serial: req.body.serial,
      principal: req.body.principal,
      agentServer: req.agentServer || null,
    });
    res.json({ success: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// All routes below require standard JWT auth
// ---------------------------------------------------------------------------

router.use(authenticate, tenant);

// POST /api/certificates/issue — direct issuance (API only; the web UI and
// CLI use access requests). Needs certificates.issue_direct. Issuing for
// another user additionally needs users.update and the right to manage that
// user (you can't borrow a stronger user's policy access — F-04).
router.post(
  '/issue',
  requirePermission('certificates.issue_direct'),
  audit('certificate.issue', 'Certificate'),
  validate(issueSchema),
  asyncHandler(async (req, res) => {
    const requestingUserId = req.user.userId;
    const targetUserId = req.body.userId || requestingUserId;
    if (targetUserId !== requestingUserId) {
      if (!can(req, 'users.update')) throw new ApiError(403, 'You may only issue certificates for yourself');
      const target = await userService.getUser(req.orgId, targetUserId);
      await userService.assertCanManageUser(req.orgId, actorFromReq(req), target, 'issue certificates for this user');
    }

    const { certificate, signedCert } = await certificateService.issue({
      orgId: req.orgId,
      userId: targetUserId,
      serverId: req.body.serverId,
      principals: req.body.principals,
      validitySeconds: req.body.validitySeconds,
      publicKey: req.body.publicKey,
      keyId: req.body.keyId,
      certType: req.body.certType,
      extensions: req.body.extensions,
      criticalOptions: req.body.criticalOptions,
      issuedVia: req.body.issuedVia,
      actorId: requestingUserId,
      scope: req.scope,
    });

    res.status(201).json({ success: true, data: { certificate, signedCert } });
  })
);

// GET /api/certificates/my-certs — any authenticated user; own certs only
router.get(
  '/my-certs',
  asyncHandler(async (req, res) => {
    const { page, limit, status } = req.query;
    // Own certs, but still customer-scoped — a scoped user shouldn't see a
    // cert issued for a server that has since left (or never was in) scope.
    const result = await certificateService.list({
      orgId: req.orgId,
      userId: req.user.userId,
      status,
      page,
      limit,
      scope: req.scope,
    });
    res.json({ success: true, data: result });
  })
);

// GET /api/certificates — admin+; all certs with filters
router.get(
  '/',
  requirePermission('certificates.view_all'),
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const result = await certificateService.list({
      orgId: req.orgId,
      userId: req.query.userId,
      serverId: req.query.serverId,
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
      scope: req.scope,
    });
    res.json({ success: true, data: result });
  })
);

// GET /api/certificates/:id — certificates.view_all OR owner of the cert
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const cert = await certificateService.getById(req.orgId, req.params.id, req.scope);

    const isOwner = cert.issuedToId === req.user.userId;

    if (!can(req, 'certificates.view_all') && !isOwner) {
      throw new ApiError(403, 'Insufficient permissions');
    }

    res.json({ success: true, data: { certificate: cert } });
  })
);

// POST /api/certificates/:id/revoke — admin+
router.post(
  '/:id/revoke',
  requirePermission('certificates.revoke'),
  audit('certificate.revoke', 'Certificate'),
  asyncHandler(async (req, res) => {
    const updated = await certificateService.revoke(
      req.orgId,
      req.params.id,
      req.user.userId
    );
    res.json({ success: true, data: { certificate: updated } });
  })
);

export default router;
