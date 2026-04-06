import ApiError from '../utils/ApiError.js';

const tenant = (req, res, next) => {
  if (!req.user || !req.user.orgId) return next(new ApiError(401, 'Organization context required'));
  req.orgId = req.user.orgId;
  next();
};

export default tenant;
