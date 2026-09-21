import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission, can } from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import * as serverService from '../services/serverService.js';
import * as healthCheckService from '../services/healthCheckService.js';
import { provisionServer } from '../services/provisionService.js';
import { resolveCredentialForActor } from '../services/keystoreService.js';
import { signBootstrapToken, INSTALL_MODES } from './bootstrap.js';
import {
  planBulkInstall,
  isBootstrapped,
  typedFallbackAuth,
  shouldRetryWithFallback,
} from '../services/bulkBootstrapService.js';
import { serverScopeWhere } from '../lib/scope.js';
import prisma from '../config/db.js';
import { mintInstallCertificate } from '../services/installCertService.js';
import * as serverSudoService from '../services/serverSudoService.js';

const router = express.Router();

/**
 * The URL the TARGET HOST will use to fetch install.sh — not the URL the
 * browser used. In prod TRAEFIK_HOST is always set; the request headers are
 * the last resort because a host behind a proxy may not be able to reach
 * whatever the admin's browser called us.
 */
function resolveBackendUrl(req) {
  if (process.env.TRAEFIK_HOST) return `https://${process.env.TRAEFIK_HOST}`;
  if (process.env.PUBLIC_API_URL) {
    return String(process.env.PUBLIC_API_URL).replace(/\/$/, '').replace(/\/api$/, '');
  }
  if (process.env.VITE_API_URL) {
    return String(process.env.VITE_API_URL).replace(/\/$/, '').replace(/\/api$/, '');
  }
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}


const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

// Upper bound on one bulk run. Not a technical limit — a blast-radius one:
// past this, "install on everything" stops being a reviewable action.
const MAX_BULK_INSTALL = 200;

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

// POST /:id/provision body. Only `mode` is validated here (Joi, matching
// bootstrap.js's own tokenSchema) — credentials/sudo fields keep their
// existing manual validation below so this change doesn't touch that
// behavior. `mode` defaults to 'full' when omitted (today's only behavior);
// any OTHER value must be one of INSTALL_MODES or the request is rejected
// outright — it never silently falls back to 'full'.
const provisionSchema = Joi.object({
  mode: Joi.string().valid(...INSTALL_MODES).default('full'),
}).unknown(true);

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
    const result = await serverService.listServers(req.orgId, req.query, req.scope);
    res.json({ success: true, data: result });
  })
);

router.get(
  '/health/summary',
  requirePermission('servers.view'),
  asyncHandler(async (req, res) => {
    const summary = await healthCheckService.getHealthSummary(req.orgId, req.scope);
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
      req.body.environment,
      req.scope
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
    const result = await serverService.bulkUpdate(req.orgId, req.body.serverIds, req.body.patch, req.scope);
    res.json({ success: true, data: result });
  })
);

router.get(
  '/:id',
  requirePermission('servers.view'),
  asyncHandler(async (req, res) => {
    const server = await serverService.getServer(req.orgId, req.params.id, req.scope);
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
    const current = await serverService.getServer(req.orgId, req.params.id, req.scope);
    assertServerFieldPermissions(req, { ipAddress: req.body.ipAddress }, current);
    const server = await serverService.updateConnectionIp(
      req.orgId,
      req.params.id,
      req.body.ipAddress,
      req.scope
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
    const server = await serverService.createServer(req.orgId, customerId, rest, req.scope);
    res.status(201).json({ success: true, data: { server } });
  })
);

router.put(
  '/:id',
  requirePermission('servers.update'),
  audit('server.update', 'Server'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const current = await serverService.getServer(req.orgId, req.params.id, req.scope);
    assertServerFieldPermissions(req, req.body, current);
    const server = await serverService.updateServer(req.orgId, req.params.id, req.body, req.scope);
    res.json({ success: true, data: { server } });
  })
);

router.get(
  '/:id/delete-impact',
  requirePermission('servers.delete'),
  asyncHandler(async (req, res) => {
    const impact = await serverService.getDeleteImpact(req.orgId, req.params.id, req.scope);
    res.json({ success: true, data: impact });
  })
);

router.delete(
  '/:id',
  requirePermission('servers.delete'),
  audit('server.delete', 'Server'),
  asyncHandler(async (req, res) => {
    await serverService.deleteServer(req.orgId, req.params.id, req.user.userId, req.scope);
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
    const server = await serverService.resetHostKey(req.orgId, req.params.id, req.scope);
    res.json({ success: true, data: { server } });
  })
);

router.post(
  '/:id/health-check',
  requirePermission('servers.onboard'),
  asyncHandler(async (req, res) => {
    const server = await healthCheckService.runHealthCheckForServer(req.orgId, req.params.id, req.scope);
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
    const { error: modeError, value: modeValue } = provisionSchema.validate(req.body);
    if (modeError) throw new ApiError(400, modeError.message);
    const mode = modeValue.mode; // 'full' | 'posture' — rejected above if neither
    const {
      privateKey, passphrase, password, sshUser, sudoPassword, credentialId, useCertificate, rememberSudoPassword,
    } = req.body;

    // Three ways in: a saved Keystore identity, credentials typed into the
    // form, or — for a host that is already bootstrapped and therefore
    // trusts our CA — a short-lived certificate and no secret at all.
    let certServer = null;
    if (useCertificate) {
      certServer = await prisma.server.findFirst({
        where: { id: req.params.id, orgId: req.orgId, ...serverScopeWhere(req.scope) },
        select: { id: true, sshUser: true, provisionStatus: true, agentId: true },
      });
      if (!certServer) throw new ApiError(404, 'Server not found');
      if (!isBootstrapped(certServer)) {
        throw new ApiError(
          400,
          'This host is not bootstrapped, so it does not trust the certificate authority yet. Use a saved identity or credentials.'
        );
      }
      if (!(sshUser || certServer.sshUser)) {
        throw new ApiError(400, 'Set an SSH user on this server to issue a certificate for it');
      }
    } else {
      if (!credentialId && !privateKey && !password) {
        throw new ApiError(400, 'Provide a saved identity, an SSH private key, or a password');
      }
      if (!credentialId && !sshUser) throw new ApiError(400, 'sshUser is required');
    }

    // Resolved BEFORE the SSE headers go out, so a missing identity or a
    // scope violation is a real 403/404 instead of an error event in a 200.
    let identityAuth = null;
    let identityName = null;
    if (credentialId) {
      const resolved = await resolveCredentialForActor(req.orgId, req.user, credentialId);
      identityAuth = resolved.auth;
      identityName = resolved.credential.name;
    }
    const effectiveUser = sshUser || identityAuth?.username || certServer?.sshUser;
    if (!effectiveUser) throw new ApiError(400, 'sshUser is required');

    // A sudo password saved for this host — used only when none was typed.
    const sudoTarget = await prisma.server.findFirst({
      where: { id: req.params.id, orgId: req.orgId, ...serverScopeWhere(req.scope) },
      select: { sudoCredentialId: true },
    });
    const savedSudo =
      !sudoPassword && effectiveUser !== 'root'
        ? await serverSudoService.resolveSavedSudo(req.orgId, req.user, sudoTarget?.sudoCredentialId, effectiveUser)
        : {};
    // Say "I won't be able to keep it" up front, not after a successful
    // install when the password has already been typed and used.
    const wantsRemember = !!rememberSudoPassword && !!sudoPassword && effectiveUser !== 'root';
    const canRemember = wantsRemember && serverSudoService.canSaveSudo(req.user);

    // Set SSE headers before any async work so the client starts receiving
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (type, data) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let installCert = null;
    try {
      // Mint the bootstrap token via bootstrap.js's own signBootstrapToken so
      // the `mode` claim it signs and the one verifyBootstrapToken later reads
      // (GET /api/bootstrap/install.sh) can never drift apart.
      const bootstrapToken = signBootstrapToken({ serverId: req.params.id, orgId: req.orgId, mode });

      const bootstrapUrl = `${resolveBackendUrl(req)}/api/bootstrap/install.sh?token=${bootstrapToken}`;

      send('log', { message: `[shellius] Starting provisioning for server ${req.params.id}` });
      send('log', {
        message:
          mode === 'posture'
            ? '[shellius] Mode: posture collector only (CA trust / sshd / check-principals untouched)'
            : '[shellius] Mode: full agent',
      });
      send('log', { message: '[shellius] Bootstrap token generated' });

      if (identityName) send('log', { message: `[shellius] Using saved identity "${identityName}"` });
      if (savedSudo.password) send('log', { message: `[shellius] Using the saved sudo password ("${savedSudo.name}")` });
      if (savedSudo.note) send('log', { message: `[shellius] ${savedSudo.note}` });
      if (wantsRemember && !canRemember) {
        send('log', {
          message: '[shellius] The sudo password will be used for this run only — saving it needs "Bind stored identities to servers" and "Manage Keystore"',
        });
      }

      if (certServer) {
        installCert = await mintInstallCertificate({
          orgId: req.orgId,
          server: certServer,
          principal: effectiveUser,
          actorId: req.user.userId,
        });
        send('log', {
          message:
            '[shellius] Using a short-lived certificate (5 min, this host only) — no stored secret',
        });
      }

      await provisionServer(req.orgId, req.params.id, {
        privateKey: installCert?.privateKey || identityAuth?.privateKey || privateKey || undefined,
        passphrase: identityAuth?.passphrase || passphrase || undefined,
        password: installCert ? undefined : identityAuth?.password || password || undefined,
        certificate: installCert?.certificate,
        sshUser: effectiveUser,
        // Typed now, then saved for this host, then a password identity's
        // own password (which doubles as sudo's, as key deployment already
        // assumes) — otherwise `sudo -S` would have nothing to read.
        sudoPassword: sudoPassword || savedSudo.password || identityAuth?.password || '',
        scope: req.scope,
        bootstrapUrl,
        mode,
        onOutput: (line) => send('log', { message: line }),
      });

      // Only now, once it has been seen to work.
      let sudoSaved = null;
      if (canRemember) {
        try {
          const saved = await serverSudoService.saveSudoPassword(
            req.orgId, req.params.id, { password: sudoPassword }, req.user, { scope: req.scope, source: 'install' }
          );
          sudoSaved = { name: saved.name };
          send('log', { message: `[shellius] Saved the sudo password to the Keystore as "${saved.name}" — reinstalls will not ask again` });
        } catch (err) {
          send('log', { message: `[shellius] Installed, but the sudo password could not be saved: ${err.message}` });
        }
      }

      send('done', { success: true, sudoSaved });
    } catch (err) {
      // `code` lets the UI tell "no sudo password" from "wrong sudo
      // password" from everything else, and ask for the right thing.
      send('error', { message: err.message || 'Provisioning failed', code: err?.code });
    } finally {
      if (installCert) await installCert.dispose();
      res.end();
    }
  })
);


// ---------------------------------------------------------------------------
// Saved sudo password (Keystore identity bound as Server.sudoCredentialId)
// ---------------------------------------------------------------------------

const sudoPasswordSchema = Joi.object({
  password: Joi.string().min(1).max(1024).required(),
});

// PUT /api/servers/:id/sudo-password — save or replace. The password is
// write-only: nothing ever returns it.
router.put(
  '/:id/sudo-password',
  requirePermission('servers.manage_credentials', 'keystore.manage'),
  // Audited by serverSudoService (with the Keystore identity's id), which
  // also audits the saves made from an install.
  asyncHandler(async (req, res) => {
    const { error, value } = sudoPasswordSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.message);
    const result = await serverSudoService.saveSudoPassword(req.orgId, req.params.id, value, req.user, {
      scope: req.scope,
      source: 'manual',
    });
    res.json({ success: true, data: result });
  })
);

// DELETE /api/servers/:id/sudo-password — unbind, and delete the identity if
// this feature created it and nothing else uses it.
router.delete(
  '/:id/sudo-password',
  requirePermission('servers.manage_credentials', 'keystore.manage'),
  // Audited by serverSudoService.
  asyncHandler(async (req, res) => {
    const result = await serverSudoService.forgetSudoPassword(req.orgId, req.params.id, req.user, { scope: req.scope });
    res.json({ success: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// Bulk bootstrap / collector install
// ---------------------------------------------------------------------------

const bulkPlanSchema = Joi.object({
  serverIds: Joi.array().items(Joi.string()).default([]),
  mode: Joi.string().valid(...INSTALL_MODES).default('posture'),
  hasFallbackCredentials: Joi.boolean().default(false),
  includeDone: Joi.boolean().default(false),
});

// POST /api/servers/bulk-install/plan
// What a run would do, before it does any of it. Read-only.
router.post(
  '/bulk-install/plan',
  requirePermission('servers.onboard'),
  asyncHandler(async (req, res) => {
    const { error, value } = bulkPlanSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.message);
    const plan = await planBulkInstall(req.orgId, value.serverIds, {
      mode: value.mode,
      hasFallbackCredentials: value.hasFallbackCredentials,
      includeDone: value.includeDone,
      scope: req.scope,
    });
    res.json({ success: true, data: plan });
  })
);

const bulkInstallSchema = Joi.object({
  serverIds: Joi.array().items(Joi.string()).min(1).max(MAX_BULK_INSTALL).required(),
  mode: Joi.string().valid(...INSTALL_MODES).default('posture'),
  concurrency: Joi.number().integer().min(1).max(8).default(3),
  // Fallback identity for hosts with none of their own. Either a saved
  // Keystore identity or credentials typed into the form — the same two
  // options the single-host provision route takes.
  credentialId: Joi.string().allow('', null),
  sshUser: Joi.string().allow('', null),
  privateKey: Joi.string().allow('', null),
  passphrase: Joi.string().allow('', null),
  password: Joi.string().allow('', null),
  sudoPassword: Joi.string().allow('', null),
  // Keep `sudoPassword` in the Keystore for every host it worked on.
  rememberSudoPassword: Joi.boolean().default(false),
  // Prefer each server's own bound identity where it has one. Off means "use
  // the supplied credentials everywhere", which is what you want for a fleet
  // that shares one break-in account.
  useServerIdentity: Joi.boolean().default(true),
}).unknown(false);

// POST /api/servers/bulk-install
// SSE. Runs the installer across many hosts, bounded concurrency, one event
// stream. Secrets are resolved in memory per host and never stored.
router.post(
  '/bulk-install',
  requirePermission('servers.onboard'),
  audit('server.bulk_install', 'Server'),
  asyncHandler(async (req, res) => {
    const { error, value } = bulkInstallSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.message);

    const hasSupplied = !!(value.credentialId || value.privateKey || value.password);

    // Everything that can 4xx happens BEFORE the SSE headers go out —
    // otherwise a missing identity or a scope violation arrives as an error
    // event inside a 200 and looks like a host that failed to install.
    let fallbackAuth = null;
    let fallbackName = null;
    if (value.credentialId) {
      const resolved = await resolveCredentialForActor(req.orgId, req.user, value.credentialId);
      fallbackAuth = resolved.auth;
      fallbackName = resolved.credential.name;
    } else {
      // Credentials typed into the form. These used to leave fallbackAuth
      // null, so every host that needed them failed with "No credentials
      // available for this host" — typed credentials never worked in bulk.
      fallbackAuth = typedFallbackAuth(value);
    }

    const plan = await planBulkInstall(req.orgId, value.serverIds, {
      mode: value.mode,
      hasFallbackCredentials: hasSupplied,
      // The caller already chose these hosts from a plan; re-filtering
      // "already done" here would silently drop a deliberate re-run.
      includeDone: true,
      scope: req.scope,
    });

    // Hosts the caller asked for that the plan refuses (out of scope, Windows,
    // RDP-only, nothing to authenticate with) are reported, never attempted.
    const targets = plan.targets;
    if (targets.length === 0) {
      throw new ApiError(
        400,
        'None of the selected servers can be installed on. ' +
          (plan.skipped[0]?.message || 'Check the plan for why.')
      );
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (type, data) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // A client that navigates away must stop the run, not leave N SSH
    // sessions installing software with nobody watching the output.
    let aborted = false;
    req.on('close', () => {
      aborted = true;
    });

    send('start', {
      mode: value.mode,
      total: targets.length,
      concurrency: value.concurrency,
      skipped: plan.skipped.map((s) => ({ id: s.id, hostname: s.hostname, reason: s.reason, message: s.message })),
    });

    const backendUrl = resolveBackendUrl(req);
    const results = [];
    const canRememberSudo = value.rememberSudoPassword && !!value.sudoPassword && serverSudoService.canSaveSudo(req.user);
    if (value.rememberSudoPassword && value.sudoPassword && !canRememberSudo) {
      send('log', {
        message: '[shellius] The sudo password will be used for this run only — saving it needs "Bind stored identities to servers" and "Manage Keystore"',
      });
    }

    const runOne = async (target) => {
      if (aborted) return;
      send('server-start', { id: target.id, hostname: target.hostname });
      const log = (message) => send('log', { id: target.id, message });

      let installCert = null;
      try {
        let auth = fallbackAuth;
        let usedOwnMethod = false;
        let authLabel = fallbackName ? `identity "${fallbackName}"` : 'supplied credentials';
        let sshUser = value.sshUser || fallbackAuth?.username;

        if (value.useServerIdentity && target.credential?.id) {
          // Each host's own bound identity. This is the whole point of the
          // bulk flow for an established fleet: nothing to type, N hosts.
          const resolved = await resolveCredentialForActor(req.orgId, req.user, target.credential.id);
          auth = resolved.auth;
          usedOwnMethod = true;
          authLabel = `saved identity "${resolved.credential.name}"`;
          sshUser = target.sshUser || resolved.auth.username;
        } else if (target.credentialSource === 'certificate') {
          // The host already trusts our CA — mint a 300s cert instead of
          // asking anyone for a password. The cert is persisted and bound to
          // this server because check-principals verifies it against the API
          // on the way in; see installCertService.
          installCert = await mintInstallCertificate({
            orgId: req.orgId,
            server: { id: target.id },
            principal: target.sshUser,
            actorId: req.user.userId,
          });
          auth = { certificate: installCert.certificate, privateKey: installCert.privateKey };
          authLabel = 'a short-lived certificate (no stored secret)';
          sshUser = target.sshUser;
        }

        if (!auth) throw new ApiError(400, 'No credentials available for this host');
        if (!sshUser) throw new ApiError(400, 'No SSH user for this host');

        log(`[shellius] Connecting as ${sshUser} using ${authLabel}`);

        // The batch's typed sudo password wins; otherwise this host's saved
        // one, if it has one and the caller may use it.
        let savedSudo = {};
        if (!value.sudoPassword && sshUser !== 'root' && target.savedSudo?.id) {
          savedSudo = await serverSudoService.resolveSavedSudo(req.orgId, req.user, target.savedSudo.id, sshUser);
          if (savedSudo.password) log(`[shellius] Using the saved sudo password ("${savedSudo.name}")`);
          if (savedSudo.note) log(`[shellius] ${savedSudo.note}`);
        }

        const bootstrapToken = signBootstrapToken({
          serverId: target.id,
          orgId: req.orgId,
          mode: value.mode,
        });
        const bootstrapUrl = `${backendUrl}/api/bootstrap/install.sh?token=${bootstrapToken}`;

        const runWith = (a, extra = {}) =>
          provisionServer(req.orgId, target.id, {
            privateKey: a.privateKey || value.privateKey || undefined,
            passphrase: a.passphrase || value.passphrase || undefined,
            password: a.password || value.password || undefined,
            certificate: a.certificate || undefined,
            sshUser: extra.sshUser || sshUser,
            sudoPassword: value.sudoPassword || savedSudo.password || a.password || '',
            scope: req.scope,
            bootstrapUrl,
            mode: value.mode,
            onOutput: log,
          });

        try {
          await runWith(auth);
        } catch (err) {
          // A certificate install needs passwordless sudo, which bootstrap
          // does not grant. Rather than fail a host the operator gave us a
          // working account for, try that account before giving up — one
          // retry, clearly announced, never silent.
          // …and the same for a host's own saved identity that no longer
          // works (rotated password, removed key): that is exactly the host
          // someone retries "with different credentials".
          const suppliedAuth = fallbackAuth;
          const canRetry = shouldRetryWithFallback({
            usedCertificate: !!installCert,
            usedOwnIdentity: usedOwnMethod,
            fallbackAuth,
            attemptedAuth: auth,
          });
          if (!canRetry) throw err;
          log(`[shellius] ${installCert ? 'Certificate' : 'Saved identity'} install failed (${err.message}) — retrying with ${fallbackName ? `identity "${fallbackName}"` : 'the supplied credentials'}`);
          await runWith(suppliedAuth, { sshUser: value.sshUser || suppliedAuth.username || sshUser });
        }

        // Worked with the batch's sudo password — keep it for this host.
        let sudoSaved = null;
        if (canRememberSudo && sshUser !== 'root') {
          try {
            const saved = await serverSudoService.saveSudoPassword(
              req.orgId, target.id, { password: value.sudoPassword }, req.user, { scope: req.scope, source: 'bulk_install' }
            );
            sudoSaved = { name: saved.name };
            log(`[shellius] Saved the sudo password to the Keystore as "${saved.name}"`);
          } catch (err) {
            log(`[shellius] Installed, but the sudo password could not be saved: ${err.message}`);
          }
        }

        results.push({ id: target.id, hostname: target.hostname, status: 'ok' });
        send('server-done', { id: target.id, hostname: target.hostname, status: 'ok', sudoSaved });
      } catch (err) {
        // One host's failure is not the batch's. Twenty-nine successes and
        // one unreachable box is a good outcome that must not be thrown away.
        const message = err?.message || 'Install failed';
        // `code` is what lets the UI offer a sudo password box for this one
        // host instead of presenting the whole batch as a dead end.
        const code = err?.code;
        results.push({ id: target.id, hostname: target.hostname, status: 'failed', error: message, code });
        send('server-done', {
          id: target.id,
          hostname: target.hostname,
          status: 'failed',
          error: message,
          code,
        });
      } finally {
        // Close the certificate's window as soon as the install is over
        // instead of leaving it valid for the rest of its five minutes.
        if (installCert) await installCert.dispose();
      }
    };

    try {
      // Bounded concurrency: a fleet run should not open ninety simultaneous
      // SSH sessions, and it should not take an hour either.
      const queue = [...targets];
      const workers = Array.from({ length: Math.min(value.concurrency, queue.length) }, async () => {
        while (queue.length > 0 && !aborted) {
          await runOne(queue.shift());
        }
      });
      await Promise.all(workers);

      send('done', {
        aborted,
        ok: results.filter((r) => r.status === 'ok').length,
        failed: results.filter((r) => r.status === 'failed').length,
        results,
      });
    } catch (err) {
      send('error', { message: err.message || 'Bulk install failed' });
    } finally {
      res.end();
    }
  })
);

export default router;
