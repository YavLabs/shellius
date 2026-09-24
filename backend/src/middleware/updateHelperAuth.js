/**
 * updateHelperAuth.js — authenticates the host-side self-update helper.
 *
 * A purpose-built credential rather than an API token, and the reason is
 * concrete rather than stylistic. `settings.updates` is non-delegable, and
 * `middleware/apiTokenAuth.effectivePermissions()` strips every non-delegable
 * permission from every API token — a service account's included, by design,
 * with a test pinning it. A helper authenticating as an API client would have
 * received 403 on every call, forever, and the service-layer tests would not
 * have noticed because they never drive a token through the route stack.
 *
 * The alternative fix — an exception in that stripping — would reopen the "no
 * API token ever holds a non-delegable permission" guarantee that
 * settings.storage, settings.email, audit.sinks and service-account
 * management all depend on. A credential that reaches exactly three endpoints
 * and nothing else in the product is the narrower answer.
 *
 * Deliberately NOT tenant-scoped: an instance upgrade is an installation-wide
 * event, not an organization's. Nothing this credential can reach reads or
 * writes org data.
 */

import ApiError from '../utils/ApiError.js';
import { resolveHelperToken } from '../services/instanceUpdateService.js';

function extractToken(req) {
  return (
    req.headers['x-shellius-helper-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    ''
  ).trim();
}

export default async function updateHelperAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return next(
        new ApiError(401, 'Update helper token required', { code: 'UPDATE_HELPER_AUTH_REQUIRED' })
      );
    }

    const helper = await resolveHelperToken(token);
    if (!helper) {
      // Same message whether the token is malformed, revoked or simply wrong:
      // there is nothing useful to tell an unauthenticated caller, and the
      // distinction would be an oracle.
      return next(
        new ApiError(401, 'Invalid update helper token', { code: 'UPDATE_HELPER_AUTH_INVALID' })
      );
    }

    req.updateHelper = { id: helper.id };
    return next();
  } catch (err) {
    return next(err);
  }
}
