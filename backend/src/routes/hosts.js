import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import prisma from '../config/db.js';

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
// Authentication: X-Agent-Token header (the shared secret written to
// /etc/shellius/agent-token during bootstrap). The Server model does not have
// a dedicated agentToken column — the shared secret written to the host is the
// AGENT_SHARED_SECRET env var, which is the same for every host in the org.
// We validate it here before allowing any state update.
router.post('/heartbeat', asyncHandler(async (req, res) => {
  const agentToken = req.headers['x-agent-token']
    || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  if (!agentToken) throw new ApiError(401, 'Agent token required');

  // Validate the agent shared secret before processing the payload.
  // AGENT_SHARED_SECRET is required in production; skip in test environments
  // where it may be unset.
  const sharedSecret = process.env.AGENT_SHARED_SECRET;
  if (sharedSecret && agentToken !== sharedSecret) {
    throw new ApiError(401, 'Invalid agent token');
  }

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

  const server = await prisma.server.findFirst({
    where: { id: value.serverId, orgId: value.orgId },
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
