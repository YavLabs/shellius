/**
 * auditService.js
 *
 * Structured audit logging with action taxonomy, paginated querying,
 * and CSV/JSON export. Never throws upstream on log failure.
 */

import prisma from '../config/db.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Action taxonomy
// ---------------------------------------------------------------------------

export const ACTIONS = {
  auth: {
    login: 'auth.login',
    logout: 'auth.logout',
    sso: 'auth.sso',
    device_approve: 'auth.device_approve',
  },
  user: {
    create: 'user.create',
    update: 'user.update',
    delete: 'user.delete',
  },
  group: {
    create: 'group.create',
    update: 'group.update',
    delete: 'group.delete',
  },
  customer: {
    create: 'customer.create',
    update: 'customer.update',
    delete: 'customer.delete',
  },
  server: {
    create: 'server.create',
    update: 'server.update',
    delete: 'server.delete',
    health_check: 'server.health_check',
  },
  policy: {
    create: 'policy.create',
    update: 'policy.update',
    delete: 'policy.delete',
  },
  access_request: {
    submit: 'access_request.submit',
    approve: 'access_request.approve',
    deny: 'access_request.deny',
    expire: 'access_request.expire',
    revoke: 'access_request.revoke',
  },
  cert: {
    issue: 'cert.issue',
    revoke: 'cert.revoke',
  },
  session: {
    start: 'session.start',
    end: 'session.end',
    terminate: 'session.terminate',
  },
  ca: {
    generate: 'ca.generate',
    rotate: 'ca.rotate',
  },
  connector: {
    create: 'connector.create',
    sync: 'connector.sync',
  },
  org: {
    update: 'org.update',
  },
};

// ---------------------------------------------------------------------------
// log — insert one AuditLog row, never throws upstream
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {string}  params.orgId
 * @param {string}  [params.actorId]
 * @param {string}  params.action        - One of ACTIONS.*.*
 * @param {string}  params.resourceType  - e.g. 'User', 'Certificate', 'Session'
 * @param {string}  [params.resourceId]
 * @param {object}  [params.metadata]
 * @param {string}  [params.ipAddress]
 * @param {string}  [params.userAgent]   - Stored inside metadata (no DB column)
 * @returns {Promise<void>}
 */
export async function log({
  orgId,
  actorId,
  action,
  resourceType,
  resourceId,
  metadata,
  ipAddress,
  userAgent,
}) {
  try {
    const mergedMeta = userAgent
      ? { ...(metadata ?? {}), userAgent }
      : (metadata ?? null);

    await prisma.auditLog.create({
      data: {
        orgId,
        actorId: actorId ?? null,
        action,
        resourceType,
        resourceId: resourceId ?? null,
        metadata: mergedMeta,
        ipAddress: ipAddress ?? null,
      },
    });
  } catch (err) {
    logger.error('auditService.log: failed to persist audit entry', {
      action,
      resourceType,
      resourceId,
      error: err.message,
    });
    // Swallow — audit failure must never break a request
  }
}

// ---------------------------------------------------------------------------
// list — paginated audit entries with filters + search
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {string}  params.orgId
 * @param {object}  [params.filters]
 * @param {string}  [params.filters.action]
 * @param {string}  [params.filters.actorId]
 * @param {string}  [params.filters.resourceType]
 * @param {string}  [params.filters.resourceId]
 * @param {string}  [params.filters.startDate]   ISO date string
 * @param {string}  [params.filters.endDate]     ISO date string
 * @param {string}  [params.filters.search]      ILIKE across action, resourceType, metadata
 * @param {number}  [params.page=1]
 * @param {number}  [params.limit=25]
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
export async function list({ orgId, filters = {}, page = 1, limit = 25 } = {}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));

  const { action, actorId, resourceType, resourceId, startDate, endDate, search } = filters;

  const where = { orgId };
  if (action) where.action = action;
  if (actorId) where.actorId = actorId;
  if (resourceType) where.resourceType = resourceType;
  if (resourceId) where.resourceId = resourceId;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  // Search: ILIKE across action + resourceType + metadata::text
  // Use Prisma OR with mode:'insensitive' for action/resourceType.
  // Metadata text search requires a raw query; we handle it as a separate
  // path that combines ORM-level filters with a raw metadata search.
  if (search) {
    const term = `%${search}%`;
    const skip = (page - 1) * limit;

    // Collect extra filter conditions as raw SQL fragments (safe: only string interpolation
    // of validated field names, values bound via parameterized inputs)
    const extraConditions = buildExtraConditions(filters);

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT id,
               org_id       AS "orgId",
               actor_id     AS "actorId",
               action,
               resource_type AS "resourceType",
               resource_id  AS "resourceId",
               metadata,
               ip_address   AS "ipAddress",
               created_at   AS "createdAt"
        FROM   audit_logs
        WHERE  org_id = ${orgId}
          AND  (
                 action        ILIKE ${term}
              OR resource_type ILIKE ${term}
              OR metadata::text ILIKE ${term}
               )
          AND  (${extraConditions.action}       IS NULL OR action        = ${extraConditions.action})
          AND  (${extraConditions.actorId}      IS NULL OR actor_id      = ${extraConditions.actorId})
          AND  (${extraConditions.resourceType} IS NULL OR resource_type = ${extraConditions.resourceType})
          AND  (${extraConditions.resourceId}   IS NULL OR resource_id   = ${extraConditions.resourceId})
          AND  (${extraConditions.startDate}::timestamptz IS NULL OR created_at >= ${extraConditions.startDate}::timestamptz)
          AND  (${extraConditions.endDate}::timestamptz   IS NULL OR created_at <= ${extraConditions.endDate}::timestamptz)
        ORDER BY created_at DESC
        LIMIT  ${limit}
        OFFSET ${skip}
      `,
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS total
        FROM   audit_logs
        WHERE  org_id = ${orgId}
          AND  (
                 action        ILIKE ${term}
              OR resource_type ILIKE ${term}
              OR metadata::text ILIKE ${term}
               )
          AND  (${extraConditions.action}       IS NULL OR action        = ${extraConditions.action})
          AND  (${extraConditions.actorId}      IS NULL OR actor_id      = ${extraConditions.actorId})
          AND  (${extraConditions.resourceType} IS NULL OR resource_type = ${extraConditions.resourceType})
          AND  (${extraConditions.resourceId}   IS NULL OR resource_id   = ${extraConditions.resourceId})
          AND  (${extraConditions.startDate}::timestamptz IS NULL OR created_at >= ${extraConditions.startDate}::timestamptz)
          AND  (${extraConditions.endDate}::timestamptz   IS NULL OR created_at <= ${extraConditions.endDate}::timestamptz)
      `,
    ]);

    const total = countRows[0]?.total ?? 0;
    return { items: rows, total, page, limit };
  }

  // Non-search path: pure Prisma ORM query
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { items, total, page, limit };
}

// ---------------------------------------------------------------------------
// exportAll — returns a Buffer for download
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {string}  params.orgId
 * @param {object}  [params.filters]   Same shape as list() filters (search excluded)
 * @param {'csv'|'json'} params.format
 * @returns {Promise<{ buffer: Buffer, contentType: string, filename: string }>}
 */
export async function exportAll({ orgId, filters = {}, format = 'json' }) {
  const { action, actorId, resourceType, resourceId, startDate, endDate } = filters;

  const where = { orgId };
  if (action) where.action = action;
  if (actorId) where.actorId = actorId;
  if (resourceType) where.resourceType = resourceType;
  if (resourceId) where.resourceId = resourceId;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'csv') {
    const HEADERS = ['id', 'createdAt', 'actorId', 'action', 'resourceType', 'resourceId', 'ipAddress', 'metadata'];
    const lines = [HEADERS.join(',')];

    for (const row of rows) {
      lines.push([
        csvCell(row.id),
        csvCell(row.createdAt?.toISOString() ?? ''),
        csvCell(row.actorId ?? ''),
        csvCell(row.action),
        csvCell(row.resourceType),
        csvCell(row.resourceId ?? ''),
        csvCell(row.ipAddress ?? ''),
        csvCell(row.metadata != null ? JSON.stringify(row.metadata) : ''),
      ].join(','));
    }

    return {
      buffer: Buffer.from(lines.join('\n'), 'utf8'),
      contentType: 'text/csv',
      filename: `audit-export-${timestamp}.csv`,
    };
  }

  return {
    buffer: Buffer.from(JSON.stringify(rows, null, 2), 'utf8'),
    contentType: 'application/json',
    filename: `audit-export-${timestamp}.json`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function csvCell(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Returns nullable values for use in the raw search query.
 * Each value is either the string/date or null, which Prisma binds safely.
 */
function buildExtraConditions(filters) {
  return {
    action: filters.action ?? null,
    actorId: filters.actorId ?? null,
    resourceType: filters.resourceType ?? null,
    resourceId: filters.resourceId ?? null,
    startDate: filters.startDate ?? null,
    endDate: filters.endDate ?? null,
  };
}

export default { ACTIONS, log, list, exportAll };
