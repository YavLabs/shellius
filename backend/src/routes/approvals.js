/**
 * Access-request approval from the link in the approval email.
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
 * The token IS the credential: single-use, expiring, and bound to one approver
 * and one request. That is an acceptable trade for a dev or staging box, and
 * it is why these routes are not behind `authenticate`.
 *
 * It is NOT an acceptable trade for production. A bearer URL that grants
 * production access sits in a mailbox for 24 hours; a forwarded message, a
 * shared inbox or a compromised mail account is enough to use it, and the
 * audit entry would name the approver who never touched it. Shellius's central
 * rule is that production access goes through the approval flow — and an
 * unauthenticated link is a way around the authentication part of that flow.
 *
 * So: **a production request cannot be decided from the email link alone.**
 * The link still works — it opens the request — but deciding it requires being
 * signed in as that approver. Non-production keeps one-click, because that is
 * the convenience people actually use and the stakes match.
 *
 * Every decision now records how it was made (`via`) on its audit entry.
 */

import express from 'express';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/auth.js';
import * as inviteService from '../services/inviteService.js';
import * as accessRequestService from '../services/accessRequestService.js';

const router = express.Router();

const TYPE = inviteService.TOKEN_TYPES.ACCESS_APPROVAL;

/**
 * Keyed on the token, not the client IP.
 *
 * A shared office IP would otherwise put every approver in one bucket and let
 * them lock each other out of approving anything. The thing actually worth
 * limiting is repeated attempts against one link, and guessing a link is not a
 * threat worth modelling — the token is 32 random bytes.
 */
const approvalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.params.token,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 429, message: 'Too many attempts on this approval link' } },
});

/** Environments where the emailed link may not decide on its own. */
const SESSION_REQUIRED_ENVIRONMENTS = ['prod'];

const needsSession = (ar) => SESSION_REQUIRED_ENVIRONMENTS.includes(ar?.server?.environment);

/**
 * Populate `req.user` when the caller happens to be signed in, and say nothing
 * when they are not. Used only to decide whether a production approval may
 * proceed — never to grant access on its own.
 *
 * An API token is deliberately refused here even though it authenticates: a
 * machine credential must not be able to approve a human's production access.
 */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  authenticate(req, res, (err) => {
    if (err) req.user = undefined; // not signed in; the prod branch decides
    next();
  });
}

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
    // Lets the confirmation page ask for a sign-in up front rather than
    // offering buttons that are going to be refused.
    requiresSession: needsSession(ar),
  };
}

async function loadRequest(resourceId) {
  const ar = await prisma.accessRequest.findUnique({
    where: { id: resourceId },
    include: {
      requester: { select: { name: true, email: true } },
      server: { select: { hostname: true, displayName: true, environment: true } },
    },
  });
  if (!ar) throw new ApiError(404, 'Access request not found');
  return ar;
}

// GET /api/approvals/:token — render data for the confirmation page (no consume)
router.get(
  '/:token',
  approvalLimiter,
  asyncHandler(async (req, res) => {
    const { user, resourceId } = await inviteService.getResourceToken(req.params.token, TYPE, {
      consume: false,
    });
    const ar = await loadRequest(resourceId);
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
  approvalLimiter,
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { error, value } = decisionSchema.validate(req.body, { stripUnknown: true });
    if (error) throw new ApiError(400, error.message);

    // Peek first so a failed review() (e.g. already decided) does not burn the
    // token; consume only once we are about to act.
    const peek = await inviteService.getResourceToken(req.params.token, TYPE, { consume: false });
    const requestId = peek.resourceId;
    const approverId = peek.user.id;
    const ar = await loadRequest(requestId);

    // Production: the link identifies the request, but the decision needs a
    // session belonging to this same approver. Anyone else signed in — even a
    // super admin — is refused here; they can approve from the app, where the
    // action is theirs and is audited as theirs.
    const viaSession = req.user?.userId === approverId && req.auth?.type !== 'api_token';
    if (needsSession(ar) && !viaSession) {
      throw new ApiError(401, 'Approving production access requires signing in as the approver', {
        code: 'SESSION_REQUIRED',
      });
    }

    const result = await accessRequestService.review({
      requestId,
      reviewerId: approverId,
      decision: value.decision === 'approve' ? 'approve' : 'deny',
      deniedReason: value.decision === 'reject' ? value.reason || 'Rejected via email' : undefined,
      via: viaSession ? 'email_link_session' : 'email_token',
    });

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
