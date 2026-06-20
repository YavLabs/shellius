import express from 'express';
import Joi from 'joi';
import jwt from 'jsonwebtoken';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
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

const createSchema = Joi.object({
  customerId: Joi.string().required(),
  hostname: Joi.string().min(1).max(255).required(),
  displayName: Joi.string().allow('', null).max(255),
  description: Joi.string().allow('', null).max(1000),
  ipAddress: Joi.string().required(),
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
});

const updateSchema = Joi.object({
  hostname: Joi.string().min(1).max(255),
  displayName: Joi.string().allow('', null).max(255),
  description: Joi.string().allow('', null).max(1000),
  ipAddress: Joi.string(),
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
}).min(1);

const bulkEnvSchema = Joi.object({
  serverIds: Joi.array().items(Joi.string()).min(1).required(),
  environment: Joi.string().valid(...ENVIRONMENTS).required(),
});

router.use(authenticate, tenant);

router.get(
  '/',
  // Members can browse the inventory read-only so they can request access /
  // connect. Create / edit / delete remain admin-only below.
  requireRole('super_admin', 'admin', 'manager', 'member'),
  asyncHandler(async (req, res) => {
    const result = await serverService.listServers(req.orgId, req.query);
    res.json({ success: true, data: result });
  })
);

router.get(
  '/health/summary',
  requireRole('super_admin', 'admin', 'manager', 'member'),
  asyncHandler(async (req, res) => {
    const summary = await healthCheckService.getHealthSummary(req.orgId);
    res.json({ success: true, data: summary });
  })
);

router.post(
  '/bulk/environment',
  requireRole('super_admin', 'admin'),
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

router.get(
  '/:id',
  requireRole('super_admin', 'admin', 'manager', 'member'),
  asyncHandler(async (req, res) => {
    const server = await serverService.getServer(req.orgId, req.params.id);
    res.json({ success: true, data: { server } });
  })
);

router.post(
  '/',
  requireRole('super_admin', 'admin'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { customerId, ...rest } = req.body;
    const server = await serverService.createServer(req.orgId, customerId, rest);
    res.status(201).json({ success: true, data: { server } });
  })
);

router.put(
  '/:id',
  requireRole('super_admin', 'admin'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const server = await serverService.updateServer(req.orgId, req.params.id, req.body);
    res.json({ success: true, data: { server } });
  })
);

router.delete(
  '/:id',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    await serverService.deleteServer(req.orgId, req.params.id);
    res.json({ success: true, data: { success: true } });
  })
);

router.post(
  '/:id/health-check',
  requireRole('super_admin', 'admin'),
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
  requireRole('super_admin', 'admin'),
  asyncHandler(async (req, res) => {
    const { privateKey, sshUser, sudoPassword } = req.body;
    if (!privateKey) throw new ApiError(400, 'privateKey is required');
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
        { kind: 'bootstrap', serverId: req.params.id, orgId: req.orgId },
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
        privateKey,
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
