import crypto from 'crypto';
import express from 'express';
import Joi from 'joi';
import jwt from 'jsonwebtoken';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission, can } from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import config from '../config/index.js';
import * as serverService from '../services/serverService.js';
import * as healthCheckService from '../services/healthCheckService.js';
import { provisionServer } from '../services/provisionService.js';

const router = express.Router();

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
const PROTOCOLS = ['ssh', 'rdp', 'both'];
const HEALTH_STATUSES = ['healthy', 'unhealthy', 'unknown', 'maintenance'];
const AUTH_MODES = ['certificate', 'credential'];

const createSchema = Joi.object({
  customerId: Joi.string().required(),
  hostname: Joi.string().min(1).max(255).required(),
  displayName: Joi.string().allow('', null).max(255),
  description: Joi.string().allow('', null).max(1000),
  dynamicIp: Joi.boolean().default(false),
  // Required only for static servers; dynamicIp servers resolve the address at
  // connect time, so it may be omitted/empty.
  ipAddress: Joi.string()
    .allow('', null)
    .when('dynamicIp', { is: true, then: Joi.optional(), otherwise: Joi.string().required() }),
  port: Joi.number().integer().min(1).max(65535).default(22),
  protocol: Joi.string().valid(...PROTOCOLS).default('ssh'),
  environment: Joi.string().valid(...ENVIRONMENTS).default('dev'),
  labels: Joi.array().items(Joi.string()),
  osType: Joi.string().allow('', null),
  osVersion: Joi.string().allow('', null),
  cloudProvider: Joi.string().allow('', null),
  cloudInstanceId: Joi.string().allow('', null),
  cloudRegion: Joi.string().allow('', null),
  cloudAccountId: Joi.string().allow('', null),
  sshUser: Joi.string().default('root'),
  sshKeyPath: Joi.string().allow('', null),
  rdpUsername: Joi.string().allow('', null).max(255),
  rdpPassword: Joi.string().allow('', null),
  isActive: Joi.boolean(),
  authMode: Joi.string().valid(...AUTH_MODES).default('certificate'),
  credentialId: Joi.when('authMode', {
    is: 'credential',
    then: Joi.string().required(),
    otherwise: Joi.string().allow(null),
  }),
});

const updateSchema = Joi.object({
  hostname: Joi.string().min(1).max(255),
  displayName: Joi.string().allow('', null).max(255),
  description: Joi.string().allow('', null).max(1000),
  dynamicIp: Joi.boolean(),
  ipAddress: Joi.string().allow('', null),
  port: Joi.number().integer().min(1).max(65535),
  protocol: Joi.string().valid(...PROTOCOLS),
  environment: Joi.string().valid(...ENVIRONMENTS),
  labels: Joi.array().items(Joi.string()),
  osType: Joi.string().allow('', null),
  osVersion: Joi.string().allow('', null),
  cloudProvider: Joi.string().allow('', null),
  cloudInstanceId: Joi.string().allow('', null),
  cloudRegion: Joi.string().allow('', null),
  cloudAccountId: Joi.string().allow('', null),
  sshUser: Joi.string(),
  sshKeyPath: Joi.string().allow('', null),
  rdpUsername: Joi.string().allow('', null).max(255),
  rdpPassword: Joi.string().allow('', null),
  isActive: Joi.boolean(),
  authMode: Joi.string().valid(...AUTH_MODES),
  credentialId: Joi.string().allow(null),
}).min(1);

const bulkEnvSchema = Joi.object({
  serverIds: Joi.array().items(Joi.string()).min(1).required(),
  environment: Joi.string().valid(...ENVIRONMENTS).required(),
});

const bulkUpdateSchema = Joi.object({
  serverIds: Joi.array().items(Joi.string()).min(1).required(),
  patch: Joi.object({
    environment: Joi.string().valid(...ENVIRONMENTS),
    protocol: Joi.string().valid(...PROTOCOLS),
    osType: Joi.string().valid('linux', 'windows', 'other'),
    osVersion: Joi.string().allow(''),
    sshUser: Joi.string().allow(''),
    isActive: Joi.boolean(),
    customerId: Joi.string(),
  })
    .min(1)
    .required(),
});

router.use(authenticate, tenant);

// ---------------------------------------------------------------------------
// Field-level permissions on server writes (docs/rbac F-05):
//   environment                        -> servers.change_environment
//   authMode / credentialId / rdpPassword, and the address of a server that
//   authenticates with a stored identity (re-pointing it would hand the
//   stored secret to another host)     -> servers.manage_credentials
// Only CHANGED values count, so an edit form that re-sends the current
// environment still works for someone without those permissions.
// ---------------------------------------------------------------------------
function assertServerFieldPermissions(req, body, current = null) {
  const changed = (field) =>
    body[field] !== undefined && (!current || (body[field] ?? null) !== (current[field] ?? null));
  const missing = [];
  if (current ? changed('environment') : false) missing.push('servers.change_environment');
  const credentialChange =
    (current ? changed('authMode') : body.authMode === 'credential') ||
    changed('credentialId') ||
    (body.rdpPassword !== undefined && body.rdpPassword !== '' && body.rdpPassword !== null) ||
    (current?.authMode === 'credential' && (changed('ipAddress') || changed('hostname') || changed('port')));
  if (credentialChange) missing.push('servers.manage_credentials');
  const lacking = missing.filter((p) => !can(req, p));
  if (lacking.length > 0) {
    throw new ApiError(403, 'You don’t have permission to change these server settings', {
      code: 'PERMISSION_DENIED',
      details: { missing: lacking },
    });
  }
}

router.get(
  '/',
  // Anyone with servers.view can browse the inventory to request access /
  // connect; writes need their own permissions below.
  requirePermission('servers.view'),
  asyncHandler(async (req, res) => {
    const result = await serverService.listServers(req.orgId, req.query);
    res.json({ success: true, data: result });
  })
);

router.get(
  '/health/summary',
  requirePermission('servers.view'),
  asyncHandler(async (req, res) => {
    const summary = await healthCheckService.getHealthSummary(req.orgId);
    res.json({ success: true, data: summary });
  })
);

router.post(
  '/bulk/environment',
  requirePermission('servers.change_environment'),
  audit('server.bulk_environment', 'Server'),
  validate(bulkEnvSchema),
  asyncHandler(async (req, res) => {
    const result = await serverService.bulkUpdateEnvironment(
      req.orgId,
      req.body.serverIds,
      req.body.environment
    );
    res.json({ success: true, data: result });
  })
);

// Generalized bulk update — change any of a set of fields on many servers.
router.post(
  '/bulk',
  requirePermission('servers.update'),
  audit('server.bulk_update', 'Server'),
  validate(bulkUpdateSchema),
  asyncHandler(async (req, res) => {
    if (req.body.patch.environment !== undefined && !can(req, 'servers.change_environment')) {
      throw new ApiError(403, 'You don’t have permission to change server environments', {
        code: 'PERMISSION_DENIED',
        details: { missing: ['servers.change_environment'] },
      });
    }
    const result = await serverService.bulkUpdate(req.orgId, req.body.serverIds, req.body.patch);
    res.json({ success: true, data: result });
  })
);

router.get(
  '/:id',
  requirePermission('servers.view'),
  asyncHandler(async (req, res) => {
    const server = await serverService.getServer(req.orgId, req.params.id);
    res.json({ success: true, data: { server } });
  })
);

// Update the connection IP of a non-static-IP server so a changed cloud IP
// doesn't lock people out (servers.update_connection_ip). An identity-auth
// server also needs servers.manage_credentials (see above).
router.patch(
  '/:id/connection-ip',
  requirePermission('servers.update_connection_ip'),
  audit('server.connection_ip', 'Server'),
  validate(Joi.object({ ipAddress: Joi.string().required() })),
  asyncHandler(async (req, res) => {
    const current = await serverService.getServer(req.orgId, req.params.id);
    assertServerFieldPermissions(req, { ipAddress: req.body.ipAddress }, current);
    const server = await serverService.updateConnectionIp(
      req.orgId,
      req.params.id,
      req.body.ipAddress
    );
    res.json({ success: true, data: { server } });
  })
);

router.post(
  '/',
  requirePermission('servers.create'),
  audit('server.create', 'Server'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    assertServerFieldPermissions(req, req.body);
    const { customerId, ...rest } = req.body;
    const server = await serverService.createServer(req.orgId, customerId, rest);
    res.status(201).json({ success: true, data: { server } });
  })
);

router.put(
  '/:id',
  requirePermission('servers.update'),
  audit('server.update', 'Server'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const current = await serverService.getServer(req.orgId, req.params.id);
    assertServerFieldPermissions(req, req.body, current);
    const server = await serverService.updateServer(req.orgId, req.params.id, req.body);
    res.json({ success: true, data: { server } });
  })
);

router.get(
  '/:id/delete-impact',
  requirePermission('servers.delete'),
  asyncHandler(async (req, res) => {
    const impact = await serverService.getDeleteImpact(req.orgId, req.params.id);
    res.json({ success: true, data: impact });
  })
);

router.delete(
  '/:id',
  requirePermission('servers.delete'),
  audit('server.delete', 'Server'),
  asyncHandler(async (req, res) => {
    await serverService.deleteServer(req.orgId, req.params.id, req.user.userId);
    res.json({ success: true, data: { success: true } });
  })
);

// POST /api/servers/:id/host-key/reset — admin only; clears the pinned SSH
// host key (TOFU) so the next ssh2 connection re-pins on first contact.
router.post(
  '/:id/host-key/reset',
  requirePermission('servers.reset_host_key'),
  audit('server.host_key_reset', 'Server'),
  asyncHandler(async (req, res) => {
    const server = await serverService.resetHostKey(req.orgId, req.params.id);
    res.json({ success: true, data: { server } });
  })
);

router.post(
  '/:id/health-check',
  requirePermission('servers.onboard'),
  asyncHandler(async (req, res) => {
    const server = await healthCheckService.runHealthCheckForServer(req.orgId, req.params.id);
    if (!server) throw new ApiError(404, 'Server not found');
    res.json({ success: true, data: { server } });
  })
);

// POST /api/servers/:id/provision
// SSE endpoint — streams bootstrap output to admin in real time.
// The private key and sudo password are used once in memory and never stored.
router.post(
  '/:id/provision',
  requirePermission('servers.onboard'),
  audit('server.provision', 'Server'),
  asyncHandler(async (req, res) => {
    const { privateKey, passphrase, password, sshUser, sudoPassword } = req.body;
    if (!privateKey && !password) throw new ApiError(400, 'Provide an SSH private key or a password');
    if (!sshUser) throw new ApiError(400, 'sshUser is required');

    // Set SSE headers before any async work so the client starts receiving
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (type, data) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // Generate a short-lived bootstrap token using the same signing approach
      // as bootstrap.js — no separate service layer exists for this yet.
      const bootstrapToken = jwt.sign(
        { kind: 'bootstrap', serverId: req.params.id, orgId: req.orgId, jti: crypto.randomUUID() },
        config.jwt.secret,
        { expiresIn: 30 * 60 }
      );

      // Resolve the backend URL the target host will reach to fetch install.sh.
      // In prod the TRAEFIK_HOST env var is always set; fall back to PUBLIC_API_URL,
      // VITE_API_URL, then the incoming request headers.
      let backendUrl;
      if (process.env.TRAEFIK_HOST) {
        backendUrl = `https://${process.env.TRAEFIK_HOST}`;
      } else if (process.env.PUBLIC_API_URL) {
        backendUrl = String(process.env.PUBLIC_API_URL).replace(/\/$/, '').replace(/\/api$/, '');
      } else if (process.env.VITE_API_URL) {
        backendUrl = String(process.env.VITE_API_URL).replace(/\/$/, '').replace(/\/api$/, '');
      } else {
        const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
        const host = req.headers['x-forwarded-host'] || req.get('host');
        backendUrl = `${proto}://${host}`;
      }

      const bootstrapUrl = `${backendUrl}/api/bootstrap/install.sh?token=${bootstrapToken}`;

      send('log', { message: `[shellius] Starting provisioning for server ${req.params.id}` });
      send('log', { message: '[shellius] Bootstrap token generated' });

      await provisionServer(req.orgId, req.params.id, {
        privateKey: privateKey || undefined,
        passphrase: passphrase || undefined,
        password: password || undefined,
        sshUser,
        sudoPassword: sudoPassword || '',
        bootstrapUrl,
        onOutput: (line) => send('log', { message: line }),
      });

      send('done', { success: true });
    } catch (err) {
      send('error', { message: err.message || 'Provisioning failed' });
    } finally {
      res.end();
    }
  })
);

export default router;
