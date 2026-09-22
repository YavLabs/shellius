/**
 * auditService.js
 *
 * Structured audit logging with action taxonomy, paginated querying,
 * and CSV/JSON export. Never throws upstream on log failure.
 */

import { Prisma } from '@prisma/client';
import prisma from '../config/db.js';
import logger, { redactValue } from '../utils/logger.js';
import { endOfDayInclusive } from '../utils/dateRange.js';

// ---------------------------------------------------------------------------
// Action taxonomy
// ---------------------------------------------------------------------------

export const ACTIONS = {
  auth: {
    login: 'auth.login',
    login_failed: 'auth.login_failed',
    account_locked: 'auth.account_locked',
    logout: 'auth.logout',
    sso: 'auth.sso',
    sso_login: 'auth.sso_login',
    sso_failed: 'auth.sso_failed',
    device_approve: 'auth.device_approve',
    refresh_reuse: 'auth.refresh_reuse',
    mfa_failed: 'auth.mfa_failed',
    // SSO account linking (docs/auth-hardening.md "Linking SSO accounts").
    // metadata.method: auto | confirmed | email_approved | connect (linked)
    // or self | admin (unlinked).
    identity_linked: 'auth.identity.linked',
    identity_unlinked: 'auth.identity.unlinked',
    identity_link_pending: 'auth.identity.link_pending',
    identity_link_failed: 'auth.identity.link_failed',
    identity_connect_started: 'auth.identity.connect_started',
    password_set: 'auth.password.set',
    sso_required_blocked: 'auth.sso_required_blocked',
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
    // Immediate prod APPROVED because the requester's role is at/above the
    // org's Organization.settings.access.prodApprovalBypassMinRole — see
    // policyService.evaluate() / accessRequestService.submit().
    prod_bypass: 'access_request.prod_bypass',
  },
  cert: {
    issue: 'cert.issue',
    revoke: 'cert.revoke',
  },
  session: {
    start: 'session.start',
    end: 'session.end',
    terminate: 'session.terminate',
    attach: 'session.attach',
    detach: 'session.detach',
    duplicate: 'session.duplicate',
    rename: 'session.rename',
    close: 'session.close',
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
  // Written by emailProviderService (metadata never carries secrets).
  email_provider: {
    create: 'email_provider.create',
    update: 'email_provider.update',
    delete: 'email_provider.delete',
    activate: 'email_provider.activate',
    deactivate: 'email_provider.deactivate',
    test: 'email_provider.test',
    google_connect: 'email_provider.google_connect',
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
    // AuditLog is immutable (no UPDATE/DELETE) and often surfaced directly
    // in the UI/export — never let a caller accidentally persist a secret
    // (password, token, private key, etc.) via metadata.
    const safeMeta = mergedMeta ? redactValue(mergedMeta) : mergedMeta;

    await prisma.auditLog.create({
      data: {
        orgId,
        actorId: actorId ?? null,
        action,
        resourceType,
        resourceId: resourceId ?? null,
        metadata: safeMeta,
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

  const { action, actorId, resourceType, resourceId, ip, startDate, endDate, search } = filters;

  const where = { orgId };
  if (action) where.action = action;
  if (actorId) where.actorId = actorId;
  if (resourceType) where.resourceType = resourceType;
  if (resourceId) where.resourceId = resourceId;
  if (ip) where.ipAddress = { contains: ip, mode: 'insensitive' };
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = endOfDayInclusive(endDate);
  }

  // Search: ILIKE across action, resourceType, metadata::text, ip_address,
  // the actor's name/email (joined), and a handful of common resource
  // labels (Server hostname/display name, Customer name, User name/email —
  // joined by resource_type/resource_id since resourceId is a polymorphic
  // FK with no single table to join generically). Metadata/ip/action
  // require a raw query; ORM-level filters can't express an OR across a
  // join, so the whole search path is raw SQL.
  if (search) {
    const term = `%${search}%`;
    const skip = (page - 1) * limit;

    // Collect extra filter conditions as raw SQL fragments (safe: only string interpolation
    // of validated field names, values bound via parameterized inputs)
    const extraConditions = buildExtraConditions(filters);
    const searchFragment = auditSearchFragment(term);

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT al.id,
               al.org_id       AS "orgId",
               al.actor_id     AS "actorId",
               al.action,
               al.resource_type AS "resourceType",
               al.resource_id  AS "resourceId",
               al.metadata,
               al.ip_address   AS "ipAddress",
               al.created_at   AS "createdAt"
        FROM   audit_logs al
        LEFT JOIN users ru ON al.actor_id = ru.id
        LEFT JOIN servers rs ON al.resource_type = 'Server' AND rs.id = al.resource_id
        LEFT JOIN customers rc ON al.resource_type = 'Customer' AND rc.id = al.resource_id
        LEFT JOIN users rru ON al.resource_type = 'User' AND rru.id = al.resource_id
        WHERE  al.org_id = ${orgId}
          AND  (${searchFragment})
          AND  (${extraConditions.action}::text       IS NULL OR al.action        = ${extraConditions.action}::text)
          AND  (${extraConditions.actorId}::text      IS NULL OR al.actor_id      = ${extraConditions.actorId}::text)
          AND  (${extraConditions.resourceType}::text IS NULL OR al.resource_type = ${extraConditions.resourceType}::text)
          AND  (${extraConditions.resourceId}::text   IS NULL OR al.resource_id   = ${extraConditions.resourceId}::text)
          AND  (${extraConditions.ip}::text           IS NULL OR al.ip_address   ILIKE ${extraConditions.ip}::text)
          AND  (${extraConditions.startDate}::timestamptz IS NULL OR al.created_at >= ${extraConditions.startDate}::timestamptz)
          AND  (${extraConditions.endDate}::timestamptz   IS NULL OR al.created_at <= ${extraConditions.endDate}::timestamptz)
        ORDER BY al.created_at DESC
        LIMIT  ${limit}
        OFFSET ${skip}
      `,
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS total
        FROM   audit_logs al
        LEFT JOIN users ru ON al.actor_id = ru.id
        LEFT JOIN servers rs ON al.resource_type = 'Server' AND rs.id = al.resource_id
        LEFT JOIN customers rc ON al.resource_type = 'Customer' AND rc.id = al.resource_id
        LEFT JOIN users rru ON al.resource_type = 'User' AND rru.id = al.resource_id
        WHERE  al.org_id = ${orgId}
          AND  (${searchFragment})
          AND  (${extraConditions.action}::text       IS NULL OR al.action        = ${extraConditions.action}::text)
          AND  (${extraConditions.actorId}::text      IS NULL OR al.actor_id      = ${extraConditions.actorId}::text)
          AND  (${extraConditions.resourceType}::text IS NULL OR al.resource_type = ${extraConditions.resourceType}::text)
          AND  (${extraConditions.resourceId}::text   IS NULL OR al.resource_id   = ${extraConditions.resourceId}::text)
          AND  (${extraConditions.ip}::text           IS NULL OR al.ip_address   ILIKE ${extraConditions.ip}::text)
          AND  (${extraConditions.startDate}::timestamptz IS NULL OR al.created_at >= ${extraConditions.startDate}::timestamptz)
          AND  (${extraConditions.endDate}::timestamptz   IS NULL OR al.created_at <= ${extraConditions.endDate}::timestamptz)
      `,
    ]);

    const total = countRows[0]?.total ?? 0;
    const enriched = await enrichAuditItems(rows, orgId);
    return { items: enriched, total, page, limit };
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

  const enriched = await enrichAuditItems(items, orgId);
  return { items: enriched, total, page, limit };
}

// ---------------------------------------------------------------------------
// facets — distinct action / resourceType values actually present for the
// org, so the frontend's Action/Resource type pickers offer only what exists
// (rather than a hard-coded list that drifts from ACTIONS above — it was
// missing ~13 real resource types and had a stale 'Policy' the backend never
// writes, since the model is `AccessPolicy`).
// ---------------------------------------------------------------------------

/**
 * @param {string} orgId
 * @returns {Promise<{ actions: string[], resourceTypes: string[] }>}
 */
export async function facets({ orgId }) {
  const [actions, resourceTypes] = await Promise.all([
    prisma.auditLog.findMany({ where: { orgId }, distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
    // resourceType is a required (non-nullable) column — no `not: null` needed.
    prisma.auditLog.findMany({
      where: { orgId },
      distinct: ['resourceType'],
      select: { resourceType: true },
      orderBy: { resourceType: 'asc' },
    }),
  ]);
  return {
    actions: actions.map((a) => a.action).filter(Boolean),
    resourceTypes: resourceTypes.map((r) => r.resourceType).filter(Boolean),
  };
}

/**
 * The search OR-clause shared by list()'s search path and exportAll() —
 * action/resourceType/metadata text, ip address, the actor's name/email, and
 * the handful of joined resource labels (see the `list()` query's LEFT
 * JOINs — same aliases: ru = actor, rs = Server, rc = Customer, rru = User
 * as a resource).
 */
function auditSearchFragment(term) {
  return Prisma.sql`
    al.action        ILIKE ${term}
    OR al.resource_type ILIKE ${term}
    OR al.metadata::text ILIKE ${term}
    OR al.ip_address    ILIKE ${term}
    OR ru.name  ILIKE ${term}
    OR ru.email ILIKE ${term}
    OR rs.hostname     ILIKE ${term}
    OR rs.display_name ILIKE ${term}
    OR rc.name  ILIKE ${term}
    OR rru.name  ILIKE ${term}
    OR rru.email ILIKE ${term}
  `;
}

// ---------------------------------------------------------------------------
// Enrichment — attach human-readable labels so the UI never has to show a
// raw primary key. Each item gets:
//
//   actorName      — user name (fall back to email local-part)
//   actorEmail     — user email
//   resourceLabel  — human string (server hostname, user name, AR composite, ...)
//   resourceLink   — optional frontend route to drill into
//
// The IDs stay in the payload so the UI can navigate, but they are never
// rendered as strings to the user.
// ---------------------------------------------------------------------------

async function enrichAuditItems(items, orgId) {
  if (!Array.isArray(items) || items.length === 0) return items;

  // Bucket distinct IDs by resource type so each lookup is a single
  // batched query.
  const actorIds = new Set();
  const byType = new Map(); // type -> Set(id)

  for (const it of items) {
    if (it.actorId) actorIds.add(it.actorId);
    if (it.resourceType && it.resourceId) {
      if (!byType.has(it.resourceType)) byType.set(it.resourceType, new Set());
      byType.get(it.resourceType).add(it.resourceId);
    }
  }

  // Always include actorIds in the User batch, regardless of resourceType.
  if (actorIds.size > 0) {
    if (!byType.has('User')) byType.set('User', new Set());
    actorIds.forEach((id) => byType.get('User').add(id));
  }

  // Fire all lookups in parallel.
  const lookups = {};
  const promises = [];

  if (byType.has('User')) {
    promises.push(
      prisma.user
        .findMany({
          where: { id: { in: [...byType.get('User')] }, orgId },
          select: { id: true, name: true, email: true, avatarUrl: true },
        })
        .then((rows) => {
          lookups.User = new Map(rows.map((r) => [r.id, r]));
        })
    );
  }
  if (byType.has('Server')) {
    promises.push(
      prisma.server
        .findMany({
          where: { id: { in: [...byType.get('Server')] }, orgId },
          select: { id: true, hostname: true, displayName: true, environment: true, ipAddress: true },
        })
        .then((rows) => {
          lookups.Server = new Map(rows.map((r) => [r.id, r]));
        })
    );
  }
  if (byType.has('Customer')) {
    promises.push(
      prisma.customer
        .findMany({
          where: { id: { in: [...byType.get('Customer')] }, orgId },
          select: { id: true, name: true, slug: true },
        })
        .then((rows) => {
          lookups.Customer = new Map(rows.map((r) => [r.id, r]));
        })
    );
  }
  if (byType.has('AccessRequest')) {
    promises.push(
      prisma.accessRequest
        .findMany({
          where: { id: { in: [...byType.get('AccessRequest')] }, orgId },
          select: {
            id: true,
            requestedPrincipal: true,
            requesterId: true,
            requester: { select: { name: true, email: true } },
            server: { select: { hostname: true, displayName: true, environment: true } },
          },
        })
        .then((rows) => {
          lookups.AccessRequest = new Map(rows.map((r) => [r.id, r]));
        })
    );
  }
  if (byType.has('Certificate')) {
    promises.push(
      prisma.certificate
        .findMany({
          where: { id: { in: [...byType.get('Certificate')] }, orgId },
          select: { id: true, keyId: true, principals: true },
        })
        .then((rows) => {
          lookups.Certificate = new Map(rows.map((r) => [r.id, r]));
        })
    );
  }
  if (byType.has('Session')) {
    promises.push(
      prisma.session
        .findMany({
          where: { id: { in: [...byType.get('Session')] }, orgId },
          select: {
            id: true,
            userId: true,
            targetHost: true,
            targetUser: true,
            user: { select: { name: true, email: true } },
            server: { select: { hostname: true, displayName: true } },
          },
        })
        .then((rows) => {
          lookups.Session = new Map(rows.map((r) => [r.id, r]));
        })
    );
  }
  if (byType.has('Group')) {
    promises.push(
      prisma.group
        .findMany({
          where: { id: { in: [...byType.get('Group')] }, orgId },
          select: { id: true, name: true },
        })
        .then((rows) => {
          lookups.Group = new Map(rows.map((r) => [r.id, r]));
        })
    );
  }
  if (byType.has('AccessPolicy')) {
    promises.push(
      prisma.accessPolicy
        .findMany({
          where: { id: { in: [...byType.get('AccessPolicy')] }, orgId },
          select: { id: true, name: true, effect: true },
        })
        .then((rows) => {
          lookups.AccessPolicy = new Map(rows.map((r) => [r.id, r]));
        })
    );
  }

  await Promise.all(promises);

  // Build the enriched view-models.
  return items.map((it) => {
    const out = { ...it };

    // Actor display name + lean user DTO ({ id, name, email, avatarUrl }) so
    // the UI can render a consistent user cell (see docs/auth-hardening.md
    // Revision 2 "Avatars").
    if (it.actorId && lookups.User) {
      const u = lookups.User.get(it.actorId);
      if (u) {
        out.actorName = u.name || (u.email || '').split('@')[0] || 'Unknown';
        out.actorEmail = u.email;
        out.actor = { id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl };
      }
    }
    if (!out.actorName) out.actorName = it.actorId ? 'Unknown user' : 'System';
    if (!out.actor) out.actor = null;

    // Resource label + link — links MUST point at routes that actually
    // exist in the frontend. Detail pages exist only for Server, Group,
    // and Customer; everything else falls back to the list page (with a
    // filter query param when the list page supports it).
    const rt = it.resourceType;
    const rid = it.resourceId;
    let label = rt;
    let link = null;
    if (rt && rid) {
      switch (rt) {
        case 'User': {
          const u = lookups.User?.get(rid);
          if (u) label = u.name || u.email || 'User';
          // No standalone user detail page — deep-links into the Users list
          // the same way Users.jsx's own row actions do.
          link = `/admin/users?highlight=${rid}`;
          break;
        }
        case 'Server': {
          const s = lookups.Server?.get(rid);
          if (s) {
            const name = s.displayName || s.hostname;
            label = `${name}${s.environment ? ` (${s.environment})` : ''}`;
          }
          link = `/servers/${rid}`; // detail page exists
          break;
        }
        case 'Customer': {
          const c = lookups.Customer?.get(rid);
          if (c) label = c.name;
          link = `/customers/${rid}`; // detail page exists
          break;
        }
        case 'AccessRequest': {
          const ar = lookups.AccessRequest?.get(rid);
          if (ar) {
            const where = ar.server?.displayName || ar.server?.hostname || 'server';
            // Own request: just the server ("Jane requested access sshtest"),
            // someone else's: "Jane → sshtest" (e.g. an approver acting on it).
            label =
              ar.requesterId && ar.requesterId === it.actorId
                ? where
                : `${ar.requester?.name || ar.requester?.email || 'someone'} → ${where}`;
          }
          // No standalone detail page — deep-link into the list, which opens
          // the request's detail modal for this id (AccessRequests.jsx).
          link = `/access-requests?request=${rid}`;
          break;
        }
        case 'Certificate': {
          const c = lookups.Certificate?.get(rid);
          if (c) label = c.keyId || (c.principals?.[0] ?? 'certificate');
          link = '/certificates'; // list only
          break;
        }
        case 'Session': {
          const s = lookups.Session?.get(rid);
          if (s) {
            // Saved server, else the Quick Connect target (user@host).
            const where =
              s.server?.displayName ||
              s.server?.hostname ||
              (s.targetHost ? `${s.targetUser ? `${s.targetUser}@` : ''}${s.targetHost}` : 'host');
            // Own session: just where; someone else's (admin terminate): "Jane on where".
            label =
              s.userId && s.userId === it.actorId
                ? where
                : `${s.user?.name || s.user?.email || 'user'} on ${where}`;
          }
          link = '/sessions'; // list only
          break;
        }
        case 'Group': {
          const g = lookups.Group?.get(rid);
          if (g) label = g.name;
          link = `/admin/groups/${rid}`; // detail page exists
          break;
        }
        case 'AccessPolicy': {
          const p = lookups.AccessPolicy?.get(rid);
          if (p) label = p.name;
          // Policies moved into Administration; deep-link opens its edit modal.
          link = `/admin/policies?highlight=${rid}`;
          break;
        }
        default:
          label = rt;
          link = null;
      }
    } else if (rt) {
      label = rt;
    }
    out.resourceLabel = label;
    out.resourceLink = link;

    // Strip actorId / resourceId from the serialized output is NOT done —
    // keep them for the detail pages. Only the UI chooses to hide them.

    return out;
  });
}

// ---------------------------------------------------------------------------
// exportAll — returns a Buffer for download
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {string}  params.orgId
 * @param {object}  [params.filters]   Same shape as list() filters, including `search`
 * @param {'csv'|'json'} params.format
 * @returns {Promise<{ buffer: Buffer, contentType: string, filename: string }>}
 */
export async function exportAll({ orgId, filters = {}, format = 'json' }) {
  const { action, actorId, resourceType, resourceId, ip, startDate, endDate, search } = filters;

  let rows;
  if (search) {
    // Same joined search as list()'s search path (see auditSearchFragment),
    // just without LIMIT/OFFSET — an export must reflect exactly what the
    // page's search box matched, not the unfiltered log.
    const term = `%${search}%`;
    const extraConditions = buildExtraConditions(filters);
    const searchFragment = auditSearchFragment(term);
    rows = await prisma.$queryRaw`
      SELECT al.id,
             al.org_id       AS "orgId",
             al.actor_id     AS "actorId",
             al.action,
             al.resource_type AS "resourceType",
             al.resource_id  AS "resourceId",
             al.metadata,
             al.ip_address   AS "ipAddress",
             al.created_at   AS "createdAt"
      FROM   audit_logs al
      LEFT JOIN users ru ON al.actor_id = ru.id
      LEFT JOIN servers rs ON al.resource_type = 'Server' AND rs.id = al.resource_id
      LEFT JOIN customers rc ON al.resource_type = 'Customer' AND rc.id = al.resource_id
      LEFT JOIN users rru ON al.resource_type = 'User' AND rru.id = al.resource_id
      WHERE  al.org_id = ${orgId}
        AND  (${searchFragment})
        AND  (${extraConditions.action}::text       IS NULL OR al.action        = ${extraConditions.action}::text)
        AND  (${extraConditions.actorId}::text      IS NULL OR al.actor_id      = ${extraConditions.actorId}::text)
        AND  (${extraConditions.resourceType}::text IS NULL OR al.resource_type = ${extraConditions.resourceType}::text)
        AND  (${extraConditions.resourceId}::text   IS NULL OR al.resource_id   = ${extraConditions.resourceId}::text)
        AND  (${extraConditions.ip}::text           IS NULL OR al.ip_address   ILIKE ${extraConditions.ip}::text)
        AND  (${extraConditions.startDate}::timestamptz IS NULL OR al.created_at >= ${extraConditions.startDate}::timestamptz)
        AND  (${extraConditions.endDate}::timestamptz   IS NULL OR al.created_at <= ${extraConditions.endDate}::timestamptz)
      ORDER BY al.created_at DESC
    `;
  } else {
    const where = { orgId };
    if (action) where.action = action;
    if (actorId) where.actorId = actorId;
    if (resourceType) where.resourceType = resourceType;
    if (resourceId) where.resourceId = resourceId;
    if (ip) where.ipAddress = { contains: ip, mode: 'insensitive' };
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = endOfDayInclusive(endDate);
    }

    rows = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

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
    ip: filters.ip ? `%${filters.ip}%` : null,
    startDate: filters.startDate ?? null,
    endDate: filters.endDate ?? null,
  };
}

export default { ACTIONS, log, list, exportAll, facets };
