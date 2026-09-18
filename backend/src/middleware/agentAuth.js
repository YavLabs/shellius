/**
 * agentAuth.js — shared authentication middleware for endpoints called by the
 * host-side agent / check-principals script (never by browser JWTs).
 *
 * Resolution order:
 *   1. Per-host token (preferred). Hash the presented token and look up the
 *      Server it belongs to (Server.agentTokenHash is unique). On a hit,
 *      req.agentServer = { id, orgId, hostname } and the caller is scoped to
 *      exactly that host/org — this is what closes the cross-host /
 *      cross-org certificate replay gap (see certificateService.verify).
 *   2. Legacy global AGENT_SHARED_SECRET fallback, for hosts that haven't
 *      re-run bootstrap yet. Governed by AGENT_LEGACY_SHARED_SECRET:
 *        - 'warn' (default this release) — accepted, but req.agentServer
 *          stays null (no host binding is possible for a shared secret),
 *          req.agentLegacy = true, a rate-limited warning is logged, and the
 *          response carries `x-shellius-agent-deprecated: 1`.
 *        - 'deny' — legacy tokens are rejected outright (401).
 *      NOTE: this will default to 'deny' in the next release. Operators
 *      should re-run the bootstrap install script (`--upgrade`) on every
 *      host before then.
 *
 * Never logs the plaintext token in either branch.
 */

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { hashAgentToken } from '../utils/agentToken.js';

// Throttle Server.agentTokenLastUsedAt writes — this runs on every SSH
// connection via check-principals, so we don't want a DB write per call.
const LAST_USED_THROTTLE_MS = 60 * 1000;

// Throttle the legacy-secret deprecation warning so a busy fleet of
// un-upgraded hosts doesn't spam the log.
const LEGACY_WARN_THROTTLE_MS = 5 * 60 * 1000;
let lastLegacyWarnAt = 0;

function extractToken(req) {
  return (
    req.headers['x-agent-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    ''
  ).trim();
}

export default async function agentAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return next(new ApiError(401, 'Agent token required', { code: 'AGENT_AUTH_REQUIRED' }));
    }

    const hash = hashAgentToken(token);
    const server = await prisma.server.findUnique({
      where: { agentTokenHash: hash },
      select: { id: true, orgId: true, hostname: true, agentTokenLastUsedAt: true },
    });

    if (server) {
      req.agentServer = { id: server.id, orgId: server.orgId, hostname: server.hostname };
      req.agentLegacy = false;

      const now = Date.now();
      const last = server.agentTokenLastUsedAt ? server.agentTokenLastUsedAt.getTime() : 0;
      if (now - last > LAST_USED_THROTTLE_MS) {
        // Fire-and-forget — never block/fail the request on this bookkeeping.
        prisma.server
          .update({ where: { id: server.id }, data: { agentTokenLastUsedAt: new Date() } })
          .catch((err) =>
            logger.warn('agentAuth: failed to update agentTokenLastUsedAt', {
              serverId: server.id,
              error: err.message,
            })
          );
      }
      return next();
    }

    // No per-host token matched — try the legacy global shared secret.
    const globalSecret = process.env.AGENT_SHARED_SECRET;
    if (globalSecret && token === globalSecret) {
      const mode = (process.env.AGENT_LEGACY_SHARED_SECRET || 'warn').toLowerCase();

      if (mode === 'deny') {
        return next(
          new ApiError(401, 'Legacy shared agent token is no longer accepted; re-run the bootstrap install script to obtain a per-host token', {
            code: 'AGENT_LEGACY_DENIED',
          })
        );
      }

      const now = Date.now();
      if (now - lastLegacyWarnAt > LEGACY_WARN_THROTTLE_MS) {
        lastLegacyWarnAt = now;
        logger.warn('agentAuth: legacy AGENT_SHARED_SECRET used — re-run bootstrap (--upgrade) on this host for a per-host token', {
          path: req.originalUrl,
          ip: req.ip,
          // Best-effort hint only — a shared secret has no reliable host identity.
          serverIdHint: req.body?.serverId || undefined,
        });
      }

      req.agentServer = null;
      req.agentLegacy = true;
      res.setHeader('x-shellius-agent-deprecated', '1');
      return next();
    }

    return next(new ApiError(401, 'Invalid or missing agent token', { code: 'AGENT_AUTH_INVALID' }));
  } catch (err) {
    return next(err);
  }
}
