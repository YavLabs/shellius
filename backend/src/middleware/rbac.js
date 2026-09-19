import ApiError from '../utils/ApiError.js';

/**
 * requirePermission(...keys) — the caller's role must hold EVERY listed
 * permission (keys from config/permissions.js). Permissions come from the
 * user's current role on every request (middleware/auth.js), so role edits
 * apply immediately.
 */
export const requirePermission = (...keys) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Authentication required'));
  const missing = keys.filter((k) => !req.user.permissions?.has(k));
  if (missing.length > 0) {
    return next(
      new ApiError(403, 'You don’t have permission to do this', {
        code: 'PERMISSION_DENIED',
        details: { missing },
      })
    );
  }
  next();
};

/** requireAnyPermission(...keys) — at least one of the listed permissions. */
export const requireAnyPermission = (...keys) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Authentication required'));
  if (keys.some((k) => req.user.permissions?.has(k))) return next();
  return next(
    new ApiError(403, 'You don’t have permission to do this', {
      code: 'PERMISSION_DENIED',
      details: { anyOf: keys },
    })
  );
};

/** can(req, key) — inline check for handlers. */
export const can = (req, key) => !!req.user?.permissions?.has(key);

export default requirePermission;
