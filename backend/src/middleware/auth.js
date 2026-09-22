import ApiError from '../utils/ApiError.js';
import { verifyAccessToken } from '../utils/jwt.js';
import prisma from '../config/db.js';
import * as mfaConfigService from '../services/mfaConfigService.js';
import { USER_AUTH_SELECT, hydrateRequestUser } from './requestUser.js';
import apiTokenAuth from './apiTokenAuth.js';
import { looksLikeApiToken } from '../utils/apiToken.js';

// ---------------------------------------------------------------------------
// Enforced-MFA allowlist — endpoints that must stay reachable for a user who
// is required to enroll MFA but hasn't yet, per docs/auth-hardening.md
// ("Enforced MFA"). Keep in sync with that doc.
// ---------------------------------------------------------------------------

function isMfaSetupAllowlisted(req) {
  const url = (req.originalUrl || req.url || '').split('?')[0];
  const method = req.method;
  if (url.startsWith('/api/mfa')) return true;
  if (url === '/api/settings/mfa/public' && method === 'GET') return true;
  if (url === '/api/auth/me' && method === 'GET') return true;
  if (url === '/api/auth/logout' && method === 'POST') return true;
  if (url === '/api/auth/refresh' && method === 'POST') return true;
  if (url === '/api/auth/sessions' && method === 'GET') return true;
  return false;
}

/**
 * authenticate — verifies the bearer JWT is a valid, non-forged access token
 * (see utils/jwt.js typ:'access' check), then loads the user on every
 * request so that:
 *   - non-active users are rejected (401 SESSION_REVOKED)
 *   - tokens minted before a "sign out everywhere" event are rejected
 *     (iat < user.sessionsValidFrom → 401 SESSION_REVOKED)
 *   - the role and its permissions used for RBAC are always the current DB
 *     values (demotions and role edits apply immediately, not on next login)
 *   - org-enforced MFA is applied except for a small allowlist of endpoints
 */
export const authenticate = async (req, res, next) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return next(new ApiError(401, 'Authentication token required'));
  }

  const token = header.split(' ')[1];

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    return next(new ApiError(401, 'Invalid or expired token'));
  }

  if (!decoded.userId || !decoded.orgId) {
    return next(new ApiError(401, 'Invalid or expired token'));
  }

  let user;
  try {
    user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: USER_AUTH_SELECT,
    });
  } catch (err) {
    return next(err);
  }

  if (!user || user.orgId !== decoded.orgId || user.status !== 'active') {
    return next(new ApiError(401, 'Session has been revoked — please sign in again', { code: 'SESSION_REVOKED' }));
  }

  // A service account has no interactive session to hold. It cannot obtain a
  // JWT in the first place (authService refuses to sign one in), so this is
  // the second lock on that door rather than the first.
  if (user.kind === 'service') {
    return next(new ApiError(401, 'Session has been revoked — please sign in again', { code: 'SESSION_REVOKED' }));
  }

  if (
    user.sessionsValidFrom &&
    typeof decoded.iat === 'number' &&
    decoded.iat * 1000 < user.sessionsValidFrom.getTime()
  ) {
    return next(new ApiError(401, 'Session has been revoked — please sign in again', { code: 'SESSION_REVOKED' }));
  }

  try {
    await hydrateRequestUser(req, user, { fid: decoded.fid });
  } catch (err) {
    return next(err);
  }

  try {
    const cfg = await mfaConfigService.getEffective(user.orgId);
    if (cfg.enforced) {
      const hasFactor =
        !!user.mfaTotpEnabled || !!user.mfaEmailEnabled || (user.mfaBackupCodes || []).length > 0;
      if (!hasFactor && !isMfaSetupAllowlisted(req)) {
        return next(
          new ApiError(403, 'Your organization requires MFA setup before you can continue', {
            code: 'MFA_SETUP_REQUIRED',
          })
        );
      }
    }
  } catch (err) {
    // Never let a config lookup failure block authentication entirely.
    return next();
  }

  next();
};

/**
 * The middleware every router mounts. Picks the authentication path from the
 * shape of the bearer credential: our tokens carry a recognisable prefix, and
 * anything else is treated as an access JWT exactly as before.
 *
 * Composing here rather than at each router means routes did not have to
 * change to accept tokens — and, more importantly, that no route can be
 * accidentally left behind on a path that skips the token rules.
 */
const bearerAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && looksLikeApiToken(header.slice(7).trim())) {
    return apiTokenAuth(req, res, next);
  }
  return authenticate(req, res, next);
};

export default bearerAuth;
