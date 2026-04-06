import ApiError from '../utils/ApiError.js';
import { verifyAccessToken } from '../utils/jwt.js';

const authenticate = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return next(new ApiError(401, 'Authentication token required'));
  }

  const token = header.split(' ')[1];

  try {
    const decoded = verifyAccessToken(token);
    req.user = {
      userId: decoded.userId,
      orgId: decoded.orgId,
      role: decoded.role,
      email: decoded.email,
    };
    next();
  } catch (err) {
    return next(new ApiError(401, 'Invalid or expired token'));
  }
};

export default authenticate;
