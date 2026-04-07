import ApiError from '../utils/ApiError.js';

// super_admin is the root user of the application and bypasses all RBAC checks.
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Authentication required'));
  if (req.user.role === 'super_admin') return next();
  if (!roles.includes(req.user.role)) return next(new ApiError(403, 'Insufficient permissions'));
  next();
};

export default requireRole;
