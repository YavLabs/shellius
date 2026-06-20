/**
 * Public (no-login) access-request approval via single-use token.
 *
 * Flow (safe against email link-prefetchers):
 *   GET  /api/approvals/:token  -> peek (no consume); returns a sanitized
 *                                  summary so the frontend can render a
 *                                  confirmation page with Approve / Reject.
 *   POST /api/approvals/:token  -> { decision: 'approve'|'reject', reason? }
 *                                  consumes the token and applies the decision
 *                                  via the normal review() path (audit +
 *                                  notifications + cert issuance reused).
 *
 * NOTE: deliberately NOT behind authenticate/tenant — the token IS the
 * credential. It is single-use, expiring, and bound to one approver + request.
 */

import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import * as inviteService from '../services/inviteService.js';
import * as accessRequestService from '../services/accessRequestService.js';

const router = express.Router();

const TYPE = inviteService.TOKEN_TYPES.ACCESS_APPROVAL;

function summarize(ar, approver) {
  return {
    id: ar.id,
    status: ar.status,
    reason: ar.reason,
    requestedPrincipal: ar.requestedPrincipal,
    requestedDuration: ar.requestedDuration,
    protocol: ar.protocol,
    createdAt: ar.createdAt,
    requester: ar.requester ? { name: ar.requester.name, email: ar.requester.email } : null,
    server: ar.server
      ? { hostname: ar.server.hostname, displayName: ar.server.displayName, environment: ar.server.environment }
      : null,
    approver: approver ? { name: approver.name, email: approver.email } : null,
  };
}

// GET /api/approvals/:token — render data for the confirmation page (no consume)
router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const { user, resourceId } = await inviteService.getResourceToken(req.params.token, TYPE, {
      consume: false,
    });
    const ar = await prisma.accessRequest.findUnique({
      where: { id: resourceId },
      include: {
        requester: { select: { name: true, email: true } },
        server: { select: { hostname: true, displayName: true, environment: true } },
      },
    });
    if (!ar) throw new ApiError(404, 'Access request not found');
    res.json({ success: true, data: { request: summarize(ar, user) } });
  })
);

const decisionSchema = Joi.object({
  decision: Joi.string().valid('approve', 'reject').required(),
  reason: Joi.string().max(1000).allow('', null),
});

// POST /api/approvals/:token — apply the decision (consumes the token)
router.post(
  '/:token',
  asyncHandler(async (req, res) => {
    const { error, value } = decisionSchema.validate(req.body, { stripUnknown: true });
    if (error) throw new ApiError(400, error.message);

    // Peek first so a failed review() (e.g. already decided) does not burn the
    // token; consume only once we are about to act.
    const peek = await inviteService.getResourceToken(req.params.token, TYPE, { consume: false });
    const requestId = peek.resourceId;
    const approverId = peek.user.id;

    let result;
    try {
      result = await accessRequestService.review({
        requestId,
        reviewerId: approverId,
        decision: value.decision === 'approve' ? 'approve' : 'deny',
        deniedReason: value.decision === 'reject' ? value.reason || 'Rejected via email' : undefined,
      });
    } catch (err) {
      // Surface a friendly already-handled state without consuming the token.
      throw err;
    }

    // Success — consume the token so the link can't be reused.
    await inviteService.getResourceToken(req.params.token, TYPE, { consume: true }).catch((e) => {
      logger.warn('approvals: token consume after decision failed', { error: e.message });
    });

    res.json({
      success: true,
      data: { decision: value.decision, status: result.status, requestId },
    });
  })
);

export default router;
