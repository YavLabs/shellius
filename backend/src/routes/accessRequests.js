import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as accessRequestService from '../services/accessRequestService.js';
import * as rdpService from '../services/rdpService.js';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';

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
// Joi schemas
// ---------------------------------------------------------------------------

const submitSchema = Joi.object({
  serverId: Joi.string().required(),
  reason: Joi.string().min(10).required(),
  requestedDuration: Joi.number().integer().min(60).max(86400 * 7).required(),
  // POSIX-ish Linux username — must match an actual local account on the
  // target host or sshd cert auth will refuse the connection.
  // Optional — when omitted, the service auto-resolves to the JIT
  // principal if a matching policy has osProvisioning, otherwise the
  // server's legacy sshUser.
  requestedPrincipal: Joi.string()
    .pattern(/^[a-z_][a-z0-9_-]{0,31}$/)
    .optional()
    .allow('', null)
    .messages({
      'string.pattern.base':
        'requestedPrincipal must be a valid Linux username: lowercase letters, digits, underscore, or hyphen (1-32 chars, must start with a letter or underscore).',
    }),
  // Accept any case — the Server model's ServerProtocol enum stores 'ssh'/'rdp'
  // lowercase, but the AccessRequest Protocol enum stores uppercase. Normalize
  // so the callers don't have to care about the difference.
  protocol: Joi.string()
    .custom((value, helpers) => {
      if (value == null) return 'SSH';
      const v = String(value).toUpperCase();
      if (v === 'SSH' || v === 'RDP') return v;
      return helpers.error('any.only');
    })
    .default('SSH')
    .messages({
      'any.only': 'protocol must be one of: SSH, RDP',
    }),
});

const listQuerySchema = Joi.object({
  tab: Joi.string().valid('mine', 'to-review', 'all').default('mine'),
  status: Joi.string().valid('PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'REVOKED'),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
});

const reviewSchema = Joi.object({
  decision: Joi.string().valid('approve', 'deny').required(),
  approvedDuration: Joi.when('decision', {
    is: 'approve',
    then: Joi.number().integer().min(60).max(86400 * 7),
    otherwise: Joi.forbidden(),
  }),
  deniedReason: Joi.when('decision', {
    is: 'deny',
    then: Joi.string().min(5).required(),
    otherwise: Joi.string().min(5),
  }),
});

const revokeSchema = Joi.object({
  reason: Joi.string().min(1),
});

// ---------------------------------------------------------------------------
// All routes require JWT auth + tenant extraction
// ---------------------------------------------------------------------------

router.use(authenticate, tenant);

// ---------------------------------------------------------------------------
// POST /api/access-requests — any authenticated user
// ---------------------------------------------------------------------------

router.post(
  '/',
  audit('access_request.submit', 'AccessRequest'),
  validate(submitSchema),
  asyncHandler(async (req, res) => {
    const accessRequest = await accessRequestService.submit({
      orgId: req.orgId,
      requesterId: req.user.userId,
      serverId: req.body.serverId,
      reason: req.body.reason,
      requestedDuration: req.body.requestedDuration,
      requestedPrincipal: req.body.requestedPrincipal,
      protocol: req.body.protocol,
      callerRole: req.user.role,
    });
    res.status(201).json({ success: true, data: { accessRequest } });
  })
);

// ---------------------------------------------------------------------------
// GET /api/access-requests — any authenticated user
// tab='all' requires admin+; enforced by the service
// ---------------------------------------------------------------------------

router.get(
  '/',
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const result = await accessRequestService.list({
      orgId: req.orgId,
      userId: req.user.userId,
      role: req.user.role,
      tab: req.query.tab,
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ success: true, data: result, meta: { page: result.page, limit: result.limit, total: result.total } });
  })
);

// ---------------------------------------------------------------------------
// GET /api/access-requests/by-server/:serverId/active — any authenticated user
//
// Returns the most recent APPROVED, non-expired access request for the
// calling user on a given server. Returns { accessRequest: null } when none
// exists. Used by the Quick Connect button on the Servers list page.
//
// MUST be registered before /:id to prevent Express matching 'by-server'
// as an :id parameter.
// ---------------------------------------------------------------------------

router.get(
  '/by-server/:serverId/active',
  asyncHandler(async (req, res) => {
    const ar = await accessRequestService.getActiveByServerForUser(
      req.orgId, // tenant scope — Task 15R-D fix
      req.user.userId,
      req.params.serverId,
    );
    res.json({ success: true, data: { accessRequest: ar } });
  })
);

// ---------------------------------------------------------------------------
// GET /api/access-requests/:id — requester, reviewer, or admin+
// Access control enforced in service via callerId/callerRole
// ---------------------------------------------------------------------------

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const accessRequest = await accessRequestService.getById({
      requestId: req.params.id,
      callerId: req.user.userId,
      callerRole: req.user.role,
    });
    res.json({ success: true, data: { accessRequest } });
  })
);

// ---------------------------------------------------------------------------
// PATCH /api/access-requests/:id/review — reviewer only (service enforces)
// ---------------------------------------------------------------------------

router.patch(
  '/:id/review',
  audit('access_request.review', 'AccessRequest'),
  validate(reviewSchema),
  asyncHandler(async (req, res) => {
    const accessRequest = await accessRequestService.review({
      requestId: req.params.id,
      reviewerId: req.user.userId,
      decision: req.body.decision,
      approvedDuration: req.body.approvedDuration,
      deniedReason: req.body.deniedReason,
    });
    res.json({ success: true, data: { accessRequest } });
  })
);

// ---------------------------------------------------------------------------
// POST /api/access-requests/:id/revoke — admin+ OR reviewer (service enforces)
// ---------------------------------------------------------------------------

router.post(
  '/:id/revoke',
  audit('access_request.revoke', 'AccessRequest'),
  validate(revokeSchema),
  asyncHandler(async (req, res) => {
    const accessRequest = await accessRequestService.revoke({
      requestId: req.params.id,
      callerId: req.user.userId,
      callerRole: req.user.role,
      reason: req.body.reason,
    });
    res.json({ success: true, data: { accessRequest } });
  })
);

// ---------------------------------------------------------------------------
// POST /api/access-requests/:id/ssh-credentials — requester only
//
// SECURITY: This endpoint returns an ephemeral Ed25519 private key.
// The private key crosses the wire exactly once here and is NEVER stored
// server-side. Callers must set Cache-Control: no-store on their end;
// we enforce it here via response headers.
// ---------------------------------------------------------------------------

router.post(
  '/:id/ssh-credentials',
  audit('access_request.ssh_credentials', 'AccessRequest'),
  asyncHandler(async (req, res) => {
    // WARNING: private key is included in the response — it must not be cached
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');

    // Phase 21A — gate SSH key download behind policy.allowKeyDownload.
    // Web-terminal sessions bypass this route entirely (they hit the
    // WebSocket proxy directly), so we only restrict out-of-band key
    // downloads here. Default is deny — any ALLOW policy with the flag
    // set opens it up.
    const ar = await prisma.accessRequest.findFirst({
      where: { id: req.params.id, orgId: req.orgId },
      include: { requester: { select: { id: true, role: true } } },
    });
    if (!ar) throw new ApiError(404, 'Access request not found');
    if (ar.requesterId !== req.user.userId) {
      throw new ApiError(403, 'Only the requester may download credentials');
    }

    // Find any ALLOW policy in the org that permits key download.
    const allowed = await prisma.accessPolicy.findFirst({
      where: {
        orgId: req.orgId,
        isActive: true,
        effect: 'ALLOW',
        allowKeyDownload: true,
      },
      select: { id: true },
    });
    if (!allowed && !ar.breakGlass) {
      logger.warn('accessRequests: key download denied by policy', {
        accessRequestId: ar.id,
        userId: req.user.userId,
      });
      throw new ApiError(
        403,
        'Key download is disabled by policy. Use the web terminal instead, or ask an admin to enable "Allow SSH key download" on a matching policy.'
      );
    }

    const credentials = await accessRequestService.generateSshCredentials({
      requestId: req.params.id,
      callerId: req.user.userId,
    });

    // High-severity audit event distinct from the generic access_request.ssh_credentials
    try {
      const auditService = await import('../services/auditService.js');
      await auditService.default.create
        ? auditService.default.create({
            orgId: req.orgId,
            actorId: req.user.userId,
            action: 'certificate.key_downloaded',
            targetType: 'AccessRequest',
            targetId: ar.id,
            metadata: { severity: 'HIGH' },
          })
        : null;
    } catch (err) {
      logger.warn('accessRequests: failed to write KEY_DOWNLOADED audit', { error: err.message });
    }

    res.json({ success: true, data: { credentials } });
  })
);

// ---------------------------------------------------------------------------
// POST /api/access-requests/:id/rdp-credentials — requester only
// ---------------------------------------------------------------------------

router.post(
  '/:id/rdp-credentials',
  audit('access_request.rdp_credentials', 'AccessRequest'),
  asyncHandler(async (req, res) => {
    const rdpFile = await accessRequestService.generateRdpFile({
      requestId: req.params.id,
      callerId: req.user.userId,
    });
    res.json({ success: true, data: rdpFile });
  })
);

// ---------------------------------------------------------------------------
// POST /api/access-requests/:id/rdp-token — requester only
//
// Returns a short-lived gateway JWT (5 min) that the frontend passes as
// ?token= on the WebSocket RDP connection.
// ---------------------------------------------------------------------------

router.post(
  '/:id/rdp-token',
  audit('access_request.rdp_token', 'AccessRequest'),
  asyncHandler(async (req, res) => {
    const id = req.params.id;

    // Verify caller is the requester and request is accessible
    const accessRequest = await accessRequestService.getById({
      requestId: id,
      callerId: req.user.userId,
      callerRole: req.user.role,
    });

    if (accessRequest.requesterId !== req.user.userId) {
      throw new ApiError(403, 'Only the requester may obtain an RDP gateway token');
    }

    const { gatewayToken } = await rdpService.createConnectionForRequest(id);

    // Gateway token TTL is 5 minutes; compute an approximate expiresAt
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    res.json({ success: true, data: { token: gatewayToken, expiresAt } });
  })
);

// ---------------------------------------------------------------------------
// POST /api/access-requests/:id/connect — requester only
// TODO(phase-8): Wire to web terminal WebSocket session. Currently returns
// a stub URL for the xterm.js terminal page.
// ---------------------------------------------------------------------------

router.post(
  '/:id/connect',
  asyncHandler(async (req, res) => {
    const id = req.params.id;

    // Verify caller is the requester and request is approved (delegate to getById)
    const accessRequest = await accessRequestService.getById({
      requestId: id,
      callerId: req.user.userId,
      callerRole: req.user.role,
    });

    if (accessRequest.requesterId !== req.user.userId) {
      throw new ApiError(403, 'Only the requester may start a web terminal session');
    }
    if (accessRequest.status !== 'APPROVED') {
      throw new ApiError(409, `Access request is not approved (status: ${accessRequest.status})`);
    }

    // TODO(phase-8): Replace stub with Guacamole / ssh2 WebSocket session creation
    res.json({
      success: true,
      data: {
        url: `/terminal?requestId=${id}`,
        expiresAt: accessRequest.expiresAt,
      },
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/access-requests/intent?serverId=... — any authenticated user
//
// Returns everything the frontend needs to decide whether the user should
// see a "Request Access" or "Connect" button for a given server, and which
// principal to pre-fill in the form. One round trip instead of three.
// ---------------------------------------------------------------------------

router.get(
  '/intent',
  asyncHandler(async (req, res) => {
    const serverId = req.query.serverId;
    if (!serverId) throw new ApiError(400, 'serverId query parameter is required');

    const intent = await accessRequestService.getAccessIntent({
      orgId: req.orgId,
      userId: req.user.userId,
      userRole: req.user.role,
      serverId,
    });
    res.json({ success: true, data: intent });
  })
);

// ---------------------------------------------------------------------------
// POST /api/access-requests/break-glass — admin-only emergency access
// ---------------------------------------------------------------------------

const breakGlassSchema = Joi.object({
  serverId: Joi.string().required(),
  reason: Joi.string().min(20).max(1000).required(),
  durationSeconds: Joi.number().integer().min(300).max(3600).default(3600),
});

router.post(
  '/break-glass',
  requireRole('admin', 'super_admin'),
  validate(breakGlassSchema),
  asyncHandler(async (req, res) => {
    const ar = await accessRequestService.createBreakGlass({
      orgId: req.orgId,
      invokerId: req.user.userId,
      invokerRole: req.user.role,
      serverId: req.body.serverId,
      reason: req.body.reason,
      durationSeconds: req.body.durationSeconds,
    });
    res.status(201).json({ success: true, data: ar });
  })
);

export default router;
