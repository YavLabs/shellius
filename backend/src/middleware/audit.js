import prisma from '../config/db.js';
import logger from '../utils/logger.js';

const audit = (action, resourceType) => async (req, res, next) => {
  const originalEnd = res.end;

  res.end = function (...args) {
    if (res.statusCode < 400) {
      prisma.auditLog
        .create({
          data: {
            orgId: req.orgId,
            actorId: req.user?.id,
            action,
            resourceType,
            resourceId: req.params.id || null,
            metadata: { method: req.method, path: req.path },
            ipAddress: req.ip,
          },
        })
        .catch((err) => logger.error('Audit log failed:', err));
    }
    originalEnd.apply(this, args);
  };

  next();
};

export default audit;
