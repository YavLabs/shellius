import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import prisma from '../config/db.js';
import agentAuth from '../middleware/agentAuth.js';
import * as postureService from '../services/postureService.js';

const router = express.Router();

const heartbeatSchema = Joi.object({
  agentId: Joi.string().required(),
  serverId: Joi.string().required(),
  orgId: Joi.string().required(),
  agentVersion: Joi.string().allow('', null),
  hostname: Joi.string().allow('', null),
  ipAddress: Joi.string().allow('', null),
});

// POST /api/hosts/heartbeat
// Called by the installed Shellius agent every 60 s via its systemd timer.
// Authentication: X-Agent-Token header, resolved by agentAuth (per-host
// token preferred; falls back to the legacy AGENT_SHARED_SECRET — see
// middleware/agentAuth.js). Per-host tokens resolve the server/org identity
// themselves, so the body's serverId/orgId are IGNORED in that mode — a
// stolen/legacy token (or a compromised host) can no longer forge another
// server's heartbeat by editing the request body. Legacy mode has no
// per-host identity to fall back on, so it keeps the old body-scoped lookup.
router.post('/heartbeat', agentAuth, asyncHandler(async (req, res) => {
  const { error, value } = heartbeatSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });
  // Soft no-op for agents that don't send identity yet (e.g. hosts onboarded
  // before the heartbeat payload fix). Avoids 400-error log spam — they'll send
  // a proper payload once re-onboarded. Token was already validated above.
  if (error) {
    return res.json({ success: true, data: { received: false } });
  }

  let serverId;
  let orgId;
  if (req.agentServer) {
    // Per-host token — identity comes from the token, never the body.
    serverId = req.agentServer.id;
    orgId = req.agentServer.orgId;
  } else {
    // Legacy shared-secret mode — no per-host identity available from the
    // token itself; fall back to the body, but the lookup below still
    // requires serverId to belong to orgId (unchanged from prior behaviour).
    serverId = value.serverId;
    orgId = value.orgId;
  }

  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId },
    select: { id: true },
  });
  if (!server) throw new ApiError(404, 'Server not found');

  await prisma.server.update({
    where: { id: server.id },
    data: {
      agentId: value.agentId,
      agentVersion: value.agentVersion || null,
      agentLastSeen: new Date(),
      healthStatus: 'healthy',
      lastHealthCheck: new Date(),
    },
  });

  res.json({ success: true, data: { received: true } });
}));

// ---------------------------------------------------------------------------
// POST /api/hosts/posture
// ---------------------------------------------------------------------------
//
// Called by the (separate, from check-principals/heartbeat) posture collector
// timer — see docs/posture/posture-spec.md and .posture-wip/posture-design.md
// §3 for the full contract. `agentAuth`, per-host token identity ONLY: unlike
// /heartbeat, posture has no legacy collector predating per-host tokens, so
// the org-wide legacy shared secret is refused outright rather than trusting
// a body-supplied serverId/orgId.
//
// The snapshot is attacker-controlled input from a host that may already be
// compromised (posture-spec.md §3 / posture-design.md §6 "payload trust").
// Hard Joi caps below; reject (400/413), never truncate. Whole-body cap is
// enforced twice: Content-Length here (independent of whatever the shared
// express.json() limit is configured to) and the per-field/array caps via Joi.
//
// Accepted payload (after Joi's stripUnknown — anything else, including a
// host-computed `reachability`/`service`/`findings`, is dropped: this
// service NEVER trusts host-computed verdicts, only raw facts):
//
//   {
//     schemaVersion?: 1,
//     scanner?: string,            agentVersion?: string,
//     collectedAt: ISO date string (required),
//     hostname?: string,
//     collectorOk?: boolean (default true),
//     degradedReason?: string,
//     firewall: {
//       engine: 'ufw'|'firewalld'|'iptables'|'nftables'|'none'|'unknown',
//       active: boolean,
//       defaultIncoming?: 'allow'|'deny'|'reject'|'unknown',
//       rules?: [{ port: '5432'|'6000:6007'|'80,443', proto?: 'tcp'|'udp'|'any',
//                  action: 'ALLOW'|'DENY'|'REJECT'|'LIMIT', from?: string,
//                  family?: 'v4'|'v6'|'any' }]   // <= 200 rules
//     },
//     listeners?: [{ proto: 'tcp'|'udp', bind: string, port: 1-65535,
//                     containerPort?: 1-65535, pids?: string (csv),
//                     process?: string, ownerKind?: string, ownerName?: string,
//                     ownerDetail?: string, ownerRef?: string, ownerUser?: string,
//                     sourcePath?: string, source?: 'ss'|'docker' }]  // <= 500
//     services?: [{ kind?, name?, detail?, sourcePath? }]             // <= 300
//     metrics?: { cpuPct?, memPct?, diskPct?, load1? }
//   }
//
// Every free-text string is capped at 512 chars (Joi below); the whole body
// is capped at 256KB.

const MAX_POSTURE_BODY_BYTES = 256 * 1024;
const STR512 = Joi.string().max(512).allow('', null);

const firewallRuleSchema = Joi.object({
  port: Joi.string().max(64).pattern(/^[0-9,:]+$/).required(),
  proto: Joi.string().valid('tcp', 'udp', 'any').default('any'),
  action: Joi.string().valid('ALLOW', 'DENY', 'REJECT', 'LIMIT').required(),
  from: Joi.string().max(128).allow('', null),
  family: Joi.string().valid('v4', 'v6', 'any').default('any'),
});

const firewallSchema = Joi.object({
  engine: Joi.string().valid('ufw', 'firewalld', 'iptables', 'nftables', 'none', 'unknown').required(),
  active: Joi.boolean().required(),
  defaultIncoming: Joi.string().valid('allow', 'deny', 'reject', 'unknown').default('unknown'),
  rules: Joi.array().items(firewallRuleSchema).max(200).default([]),
}).required();

const listenerSchema = Joi.object({
  proto: Joi.string().valid('tcp', 'udp').required(),
  bind: Joi.string().max(512).required(),
  port: Joi.number().integer().min(1).max(65535).required(),
  containerPort: Joi.number().integer().min(1).max(65535).allow(null),
  pids: STR512,
  process: STR512,
  ownerKind: Joi.string().max(64).allow('', null),
  ownerName: STR512,
  ownerDetail: STR512,
  ownerRef: STR512,
  ownerUser: Joi.string().max(128).allow('', null),
  sourcePath: STR512,
  source: Joi.string().valid('ss', 'docker').default('ss'),
});

/**
 * What is installed on the host and whether it is running.
 *
 * This field existed and was silently dropped — accepted by the schema,
 * stored nowhere, emitted by nothing. It is real now: the collector reports
 * stopped/failed units and (where the operator granted it) containers in
 * every state, because a stopped service's firewall rule and published port
 * outlive the socket that `ss` can see.
 */
const SERVICE_STATES = [
  'running', 'exited', 'created', 'paused', 'restarting', 'dead',
  'failed', 'inactive', 'stopped', 'unknown',
];

const declaredPortSchema = Joi.object({
  proto: Joi.string().valid('tcp', 'udp').required(),
  port: Joi.number().integer().min(1).max(65535).required(),
  containerPort: Joi.number().integer().min(1).max(65535).allow(null),
  bind: Joi.string().max(128).allow('', null),
});

const serviceInventorySchema = Joi.object({
  kind: Joi.string().max(64).allow('', null),
  name: STR512,
  ref: STR512,
  state: Joi.string().valid(...SERVICE_STATES).default('unknown'),
  running: Joi.boolean().default(false),
  statusText: STR512,
  detail: STR512,
  sourcePath: STR512,
  exitCode: Joi.number().integer().min(-1).max(255).allow(null),
  ports: Joi.array().items(declaredPortSchema).max(64).default([]),
});

/**
 * Which halves of the service scan actually ran. A host that never looked
 * for containers must not be indistinguishable from one that looked and
 * found none — that difference is the whole value of the field.
 */
const serviceScanSchema = Joi.object({
  systemd: Joi.boolean().default(false),
  containers: Joi.boolean().default(false),
  containersBlocked: Joi.boolean().default(false),
  pm2: Joi.boolean().default(false),
});

const metricsSchema = Joi.object({
  cpuPct: Joi.number().min(0).max(100).allow(null),
  memPct: Joi.number().min(0).max(100).allow(null),
  diskPct: Joi.number().min(0).max(100).allow(null),
  load1: Joi.number().min(0).max(100000).allow(null),
});

const postureSchema = Joi.object({
  schemaVersion: Joi.number().integer().min(1).max(1).default(1),
  scanner: Joi.string().max(128).allow('', null),
  agentVersion: Joi.string().max(64).allow('', null),
  collectedAt: Joi.date().iso().required(),
  hostname: Joi.string().max(512).allow('', null),
  collectorOk: Joi.boolean().default(true),
  degradedReason: Joi.string().max(512).allow('', null),
  firewall: firewallSchema,
  listeners: Joi.array().items(listenerSchema).max(500).default([]),
  services: Joi.array().items(serviceInventorySchema).max(300).default([]),
  serviceScan: serviceScanSchema.default({}),
  metrics: metricsSchema.allow(null),
});

// This route parses its own body: the app-wide express.json() keeps express's
// 100kb default, which a legitimate snapshot can exceed. The larger parser is
// mounted HERE so only this endpoint accepts a bigger body, and it is still
// bounded — 256KB, the same number the Content-Length check below enforces.
router.post('/posture', agentAuth, express.json({ limit: MAX_POSTURE_BODY_BYTES }), asyncHandler(async (req, res) => {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_POSTURE_BODY_BYTES) {
    throw new ApiError(413, 'Posture snapshot payload exceeds the 256KB limit', {
      code: 'POSTURE_PAYLOAD_TOO_LARGE',
    });
  }

  if (!req.agentServer) {
    // No legacy posture collector predates per-host tokens — never accept a
    // body-scoped serverId/orgId for this endpoint.
    throw new ApiError(401, 'A per-host agent token is required for posture ingest; re-run the bootstrap install script on this host', {
      code: 'AGENT_AUTH_REQUIRED',
    });
  }

  const { error, value } = postureSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });
  if (error) {
    throw new ApiError(400, 'Invalid posture snapshot', {
      code: 'POSTURE_INVALID_PAYLOAD',
      details: error.details.map((d) => d.message),
    });
  }

  const result = await postureService.ingest(req.agentServer.orgId, req.agentServer.id, value);

  res.json({ success: true, data: result });
}));

export default router;
