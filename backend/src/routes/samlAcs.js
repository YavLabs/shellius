/**
 * routes/samlAcs.js — the two SAML endpoints an identity provider talks to:
 * the Assertion Consumer Service and the SP metadata document.
 *
 * ## Why this is a separate router mounted before the body parsers
 *
 * `app.js` installs `express.json()` and `express.urlencoded()` globally at
 * express's default 100KB limit. A SAML assertion arrives as
 * `application/x-www-form-urlencoded` and a real one — encrypted, or carrying
 * a long group list — can exceed that, at which point the global parser
 * answers 413 before any route sees it. So this router is mounted BEFORE the
 * global parsers and brings its own, exactly as `routes/slackInteractions.js`
 * does and for the same class of reason. Mount order is load-bearing.
 *
 * ## Why neither endpoint is behind `authenticate`
 *
 * The identity provider has no Shellius session and never will. The ACS is
 * authenticated by the XML signature on the assertion it carries, and by
 * nothing else; the metadata document is public information by design (an IdP
 * has to be able to fetch it before any trust exists).
 *
 * ## What takes the place of the OIDC `state` cookie
 *
 * The OIDC callback is a GET redirect, so its `SameSite=Lax` state cookie
 * rides along. The ACS is a cross-site form POST — a Lax cookie is NOT sent
 * on one. Loosening it to `SameSite=None` would require `Secure`, breaking
 * every non-TLS development install, and would weaken the cookie everywhere
 * else it is used. So SAML does not lean on a cookie at all. Its binding to a
 * sign-in this server started is `InResponseTo`, checked against the request
 * id we wrote to Redis when we generated the AuthnRequest, plus a RelayState
 * that is itself a single-use Redis-held token. That is the protocol's own
 * mechanism and it is stronger here than the cookie would be.
 */

import express from 'express';
import prisma from '../config/db.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import asyncHandler from '../utils/asyncHandler.js';
import * as samlService from '../services/samlService.js';
import { handleSamlAssertion } from './sso.js';
import { authLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

const FRONTEND_URL = config.frontendUrl;

/**
 * SAML's own parser. `extended: false` (querystring, not qs) because the body
 * is three flat fields and nothing needs nested-object support; 1MB because
 * that is the cap `samlService.MAX_SAML_RESPONSE_BYTES` enforces on the
 * SAMLResponse itself, and a parser limit below it would turn a clear
 * application-level refusal into an opaque 413.
 */
router.use(
  '/acs',
  express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 20 })
);

function redirectError(res, code) {
  return res.redirect(`${FRONTEND_URL}/auth/callback#${new URLSearchParams({ error: code }).toString()}`);
}

/**
 * GET /api/auth/sso/saml/metadata/:providerId — the SP metadata an admin
 * hands to their IdP.
 *
 * Public, because an IdP fetches it with no credential. It contains only
 * information the IdP is about to be told anyway: our EntityID, our ACS URL,
 * the NameID format we want, and our PUBLIC certificate. The IdP's
 * certificate and our private key are not in it and are not reachable from
 * it.
 *
 * Rate limited, and 404 for anything that is not an active SAML provider, so
 * it is not usable as an oracle for enumerating provider ids or orgs.
 */
router.get(
  '/metadata/:providerId',
  authLimiter,
  asyncHandler(async (req, res) => {
    const row = await prisma.ssoConfig.findFirst({
      where: { id: req.params.providerId, provider: 'saml' },
    });
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });

    const cfg = samlService.decryptSamlProvider(row);
    const xml = samlService.buildMetadata(cfg);
    res.type('application/samlmetadata+xml');
    res.setHeader('Content-Disposition', `inline; filename="shellius-sp-${row.id}.xml"`);
    res.send(xml);
  })
);

/**
 * POST /api/auth/sso/saml/acs/:providerId — the assertion lands here.
 *
 * The provider id in the path is what makes this endpoint org-scoped: ids are
 * globally unique and each belongs to exactly one org, so the row we load
 * fixes the org, the trusted certificate, the audience and the Redis
 * namespace for the rest of the request. An assertion minted for org A's
 * provider cannot be POSTed to org B's ACS and validate — different audience,
 * different certificate, different destination, three independent refusals.
 *
 * The handler itself only resolves the provider and delegates; every
 * validation and every decision about the user lives in the service layer,
 * shared with the OIDC callback.
 */
router.post(
  '/acs/:providerId',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { providerId } = req.params;
    const samlResponse = req.body?.SAMLResponse;
    const relayState = typeof req.body?.RelayState === 'string' ? req.body.RelayState : null;

    if (!samlResponse || typeof samlResponse !== 'string') {
      logger.warn('SAML ACS called without a SAMLResponse', { providerId });
      return redirectError(res, 'saml_invalid');
    }

    const row = await prisma.ssoConfig.findFirst({ where: { id: providerId, provider: 'saml' } });
    if (!row) {
      logger.warn('SAML ACS called for an unknown provider', { providerId });
      return redirectError(res, 'sso_not_configured');
    }
    if (!row.isActive) {
      logger.warn('SAML ACS called for a disabled provider', { providerId, orgId: row.orgId });
      return redirectError(res, 'sso_not_configured');
    }

    // routes/sso.js owns the shared sign-in tail — reconcile, pending-link,
    // audit, one-time exchange code — and SAML uses exactly that, so the
    // assertion is handed straight to it. One direction only: sso.js does not
    // import this router back.
    return handleSamlAssertion(req, res, { row, samlResponse, relayState });
  })
);

/**
 * Router-scoped error handling for body-parser failures.
 *
 * Two reasons this is here rather than left to the global handler:
 *
 *  1. The global `middleware/errorHandler.js` only honours `statusCode` on an
 *     ApiError. A body-parser error carries `status: 413` and `type:
 *     'entity.too.large'` and is neither an ApiError nor a Prisma error, so it
 *     is reported as a 500. That is a pre-existing wart affecting every route
 *     with a body limit, not something to fix from inside a SAML feature —
 *     but a SAML assertion that is too large should not look like a server
 *     crash.
 *
 *  2. This endpoint's client is a BROWSER following an IdP's form POST. A JSON
 *     error envelope would be rendered as raw text in the address bar with no
 *     way back to the application. A redirect to the login page with a stable
 *     error code is the same contract every other failure on this path uses.
 */
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
    logger.warn('SAML ACS body exceeded the size limit', { providerId: req.params?.providerId });
    // A 302, not a 413: express's res.redirect() sets its own status, and a
    // browser mid-form-POST needs somewhere to go more than it needs a code.
    return redirectError(res, 'saml_too_large');
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    logger.warn('SAML ACS body could not be parsed');
    return redirectError(res, 'saml_invalid');
  }
  return next(err);
});

export default router;
