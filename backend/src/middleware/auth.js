import ApiError from '../utils/ApiError.js';
import { verifyAccessToken } from '../utils/jwt.js';
import prisma from '../config/db.js';
import * as mfaConfigService from '../services/mfaConfigService.js';
import { permissionsForUser } from '../services/roleService.js';

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
const authenticate = async (req, res, next) => {
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
      select: {
        id: true,
        orgId: true,
        email: true,
        role: true,
        roleId: true,
        assignedRole: { select: { id: true, key: true, name: true, isSystem: true, baseRole: true, permissions: true } },
        status: true,
        sessionsValidFrom: true,
        mfaTotpEnabled: true,
        mfaEmailEnabled: true,
        mfaBackupCodes: true,
      },
    });
  } catch (err) {
    return next(err);
  }

  if (!user || user.orgId !== decoded.orgId || user.status !== 'active') {
    return next(new ApiError(401, 'Session has been revoked — please sign in again', { code: 'SESSION_REVOKED' }));
  }

  if (
    user.sessionsValidFrom &&
    typeof decoded.iat === 'number' &&
    decoded.iat * 1000 < user.sessionsValidFrom.getTime()
  ) {
    return next(new ApiError(401, 'Session has been revoked — please sign in again', { code: 'SESSION_REVOKED' }));
  }

  req.user = {
    userId: user.id,
    orgId: user.orgId,
    role: user.role, // base tier — DB-authoritative, demotions apply immediately
    roleId: user.roleId,
    roleKey: user.assignedRole?.key || user.role,
    permissions: new Set(permissionsForUser(user)),
    email: user.email,
    fid: decoded.fid,
  };

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

export default authenticate;
