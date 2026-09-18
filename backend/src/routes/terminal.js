/**
 * routes/terminal.js
 *
 * REST surface for the Terminals workspace (persistent/detachable sessions).
 * The WebSocket upgrade for /api/terminal/ssh is handled directly on the
 * http.Server in terminalService.attachWebSocketServer() — upgrades never
 * reach Express, so mounting this router at /api/terminal is safe.
 *
 * All routes operate on the caller's OWN live hub sessions only — ownership
 * is enforced inside terminalHub (HubError -> 404/403), never trusted from
 * the request.
 */

import express from 'express';
import Joi from 'joi';

import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import audit from '../middleware/audit.js';
import prisma from '../config/db.js';
import * as hub from '../services/terminalHub.js';
import * as quickConnectService from '../services/quickConnectService.js';
import * as wsTicketService from '../services/wsTicketService.js';
import { userRateLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

router.use(authenticate, tenant);

const wsTicketLimiter = userRateLimiter({ keyPrefix: 'rl:ws-ticket', windowSeconds: 60, max: 30 });

// ---------------------------------------------------------------------------
// POST /api/terminal/ws-ticket — mint a single-use, 30s WebSocket connect
// ticket. Every /api/terminal/ssh upgrade authenticates with `?t=<ticket>`
// instead of the access JWT, so the long-lived bearer token never appears in
// a URL (and therefore never in a reverse-proxy access log). See
// services/wsTicketService.js and docs/terminal-workspace.md.
// ---------------------------------------------------------------------------

const sshParamsSchema = Joi.alternatives().try(
  Joi.object({ attach: Joi.string().required() }),
  Joi.object({ ticket: Joi.string().required() }),
  Joi.object({ requestId: Joi.string().required(), principal: Joi.string().allow('', null) })
);

const wsTicketSchema = Joi.object({
  purpose: Joi.string().valid('ssh').required(), // RDP tunnels its own short-lived, single-use Guacamole gateway token over the tunnel (never the URL) — see services/rdpService.js
  params: sshParamsSchema.required(),
});

router.post(
  '/ws-ticket',
  wsTicketLimiter,
  asyncHandler(async (req, res) => {
    const { error, value } = wsTicketSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) throw new ApiError(400, error.details.map((d) => d.message).join(', '));

    const result = await wsTicketService.issue({
      userId: req.user.userId,
      orgId: req.orgId,
      purpose: value.purpose,
      params: value.params,
    });
    res.status(201).json({ success: true, data: result });
  })
);

function mapHubError(err) {
  if (err instanceof hub.HubError) {
    return new ApiError(err.httpStatus, err.message, { code: err.code });
  }
  return err;
}

// ---------------------------------------------------------------------------
// GET /api/terminal/sessions — caller's own live hub sessions
// ---------------------------------------------------------------------------

router.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const sessions = hub.list(req.user.userId, req.orgId);
    res.json({ success: true, data: { sessions } });
  })
);

// ---------------------------------------------------------------------------
// POST /api/terminal/sessions/:id/duplicate — connect info for a new session
// to the same target with the same auth.
// ---------------------------------------------------------------------------

router.post(
  '/sessions/:id/duplicate',
  audit('session.duplicate', 'Session'),
  asyncHandler(async (req, res) => {
    let spec;
    try {
      spec = hub.getConnectSpec(req.params.id, { userId: req.user.userId, orgId: req.orgId });
    } catch (err) {
      throw mapHubError(err);
    }

    if (!spec) {
      throw new ApiError(409, 'This session cannot be duplicated', { code: 'CANNOT_DUPLICATE' });
    }

    if (spec.type === 'access_request') {
      const ar = await prisma.accessRequest.findFirst({ where: { id: spec.requestId, orgId: req.orgId } });
      if (!ar || ar.status !== 'APPROVED' || !ar.expiresAt || ar.expiresAt <= new Date()) {
        throw new ApiError(
          409,
          'This access request is no longer approved — start a new request to reconnect',
          { code: 'CANNOT_DUPLICATE' }
        );
      }
      res.status(201).json({ success: true, data: { connect: { requestId: spec.requestId, principal: spec.principal } } });
      return;
    }

    if (spec.type === 'quick_connect') {
      const result = await quickConnectService.createTicketFromSpec(
        req.orgId,
        { id: req.user.userId, role: req.user.role },
        { host: spec.host, port: spec.port, username: spec.username, auth: spec.auth, expectedHostKey: spec.expectedHostKey }
      );
      res.status(201).json({ success: true, data: { connect: { ticket: result.ticket } } });
      return;
    }

    throw new ApiError(409, 'This session cannot be duplicated', { code: 'CANNOT_DUPLICATE' });
  })
);

// ---------------------------------------------------------------------------
// PATCH /api/terminal/sessions/:id — rename (shown in tabs, max 60 chars)
// ---------------------------------------------------------------------------

const renameSchema = Joi.object({
  label: Joi.string().trim().min(1).max(60).required(),
});

router.patch(
  '/sessions/:id',
  audit('session.rename', 'Session'),
  asyncHandler(async (req, res) => {
    const { error, value } = renameSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) throw new ApiError(400, error.details.map((d) => d.message).join(', '));

    let session;
    try {
      session = hub.rename(req.params.id, { userId: req.user.userId, orgId: req.orgId }, value.label);
    } catch (err) {
      throw mapHubError(err);
    }
    res.json({ success: true, data: { session } });
  })
);

// ---------------------------------------------------------------------------
// POST /api/terminal/sessions/:id/close — end the session (same as the
// `{type:'close'}` WS frame)
// ---------------------------------------------------------------------------

router.post(
  '/sessions/:id/close',
  audit('session.close', 'Session'),
  asyncHandler(async (req, res) => {
    let session;
    try {
      session = await hub.closeOwned(req.params.id, { userId: req.user.userId, orgId: req.orgId });
    } catch (err) {
      throw mapHubError(err);
    }
    res.json({ success: true, data: { session } });
  })
);

export default router;
