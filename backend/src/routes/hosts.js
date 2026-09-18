import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import prisma from '../config/db.js';
import agentAuth from '../middleware/agentAuth.js';

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

export default router;
