import { log } from '../services/auditService.js';
import { snapshotName } from '../utils/auditNameSnapshot.js';

/**
 * audit(action, resourceType)
 *
 * Express middleware factory. Intercepts res.end to write an AuditLog entry
 * after a successful (2xx/3xx) response. Delegates to auditService.log which
 * never throws upstream.
 *
 * On a DELETE, the resource's name is read before the handler removes it
 * and kept in metadata (utils/auditNameSnapshot.js) — otherwise a deleted
 * policy or key could never be found by name in the audit log again.
 *
 * @param {string} action       - Action string, ideally from ACTIONS taxonomy
 * @param {string} resourceType - Resource type label (e.g. 'Certificate')
 * @returns {import('express').RequestHandler}
 */
const audit = (action, resourceType) => async (req, res, next) => {
  const originalEnd = res.end;
  const snapshot =
    req.method === 'DELETE' && req.params.id ? await snapshotName(req.orgId, resourceType, req.params.id) : null;

  res.end = function (...args) {
    if (res.statusCode < 400) {
      log({
        orgId: req.orgId,
        actorId: req.user?.id ?? req.user?.userId ?? null,
        action,
        resourceType,
        resourceId: req.params.id || null,
        metadata: { method: req.method, path: req.path, ...(snapshot || {}) },
        ipAddress: req.ip,
        userAgent: req.headers?.['user-agent'],
      });
    }
    originalEnd.apply(this, args);
  };

  next();
};

export default audit;
