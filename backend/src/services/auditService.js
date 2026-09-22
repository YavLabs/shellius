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
  api_token: {
    create: 'api_token.create',
    rotate: 'api_token.rotate',
    revoke: 'api_token.revoke',
    // Once per token, the first time it authenticates — so "was this
    // credential ever actually used?" has an answer in the log, not just in
    // a lastUsedAt column that a later use overwrites.
    first_use: 'api_token.first_use',
  },
  service_account: {
    create: 'service_account.create',
    update: 'service_account.update',
    delete: 'service_account.delete',
    role_changed: 'service_account.role_changed',
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
 * @param {string}  [params.filters.search]      ILIKE across action, resourceType, metadata, ip,
 *                                               actor, and resource names (see RESOURCE_NAME_SEARCH)
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
  // FK with no single table to join generically), plus every other audited
  // resource type by name via findResourceIdsByName (RESOURCE_NAME_SEARCH).
  // Metadata/ip/action require a raw query; ORM-level filters can't express
  // an OR across a join, so the whole search path is raw SQL.
  if (search) {
    const skip = (page - 1) * limit;

    // Collect extra filter conditions as raw SQL fragments (safe: only string interpolation
    // of validated field names, values bound via parameterized inputs)
    const extraConditions = buildExtraConditions(filters);
    const searchFragment = await buildSearchFragment(orgId, search);

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

// ---------------------------------------------------------------------------
// Resource-name search — every other resource type
// ---------------------------------------------------------------------------
//
// resource_id is a polymorphic FK, so Server/Customer/User (the most common
// types) are LEFT JOINed straight into the search SQL. Every other audited
// type is resolved here instead: one bounded, org-scoped lookup per type for
// ids whose *current* name matches, OR'd into the search as
// `(resource_type = T AND resource_id IN (...ids))`.
//
// Deleted resources can't be resolved by current name; where the writer
// stored a name snapshot in metadata (keystore, vault, roles …) the existing
// `metadata::text ILIKE` branch still finds them.
//
// Deliberately NOT in this map:
//   - Server, Customer, User          — joined in SQL (auditSearchFragment)
//   - PersonalHost, QuickConnectHistory — personal to one user; per the
//     personal-vault rule they are never searchable by other users (their
//     create/update rows carry a metadata name snapshot, which the admin
//     already sees in the row itself)
//   - personal Credential / SshKey rows — filtered out via `ownerId: null`
//   - ImportJob, QuickConnect, Posture, PostureSettings, SmtpConfig,
//     StorageConfig, MfaConfig          — no name column / singleton
//     settings rows / null resourceId
// ---------------------------------------------------------------------------

export const NAME_LOOKUP_CAP = 200;

const ci = (q) => ({ contains: q, mode: 'insensitive' });
const serverNameMatch = (q) => [{ server: { hostname: ci(q) } }, { server: { displayName: ci(q) } }];
const userNameMatch = (rel, q) => [{ [rel]: { name: ci(q) } }, { [rel]: { email: ci(q) } }];

/**
 * resourceType → how to find its ids by name.
 *   model   — Prisma delegate name
 *   match   — (q) => array of OR conditions
 *   scope   — extra fixed where (e.g. org Keystore only); can never override
 *             the org predicate, which is applied last
 *   orgField — column holding the org id (default 'orgId'; 'id' for Organization)
 *   select / ids — when one row maps to several audited ids (KeyDeployment
 *             rows are audited by deployment id AND by batch id)
 */
export const RESOURCE_NAME_SEARCH = {
  AccessPolicy: { model: 'accessPolicy', match: (q) => [{ name: ci(q) }] },
  Group: { model: 'group', match: (q) => [{ name: ci(q) }] },
  Role: { model: 'role', match: (q) => [{ name: ci(q) }, { key: ci(q) }] },
  Credential: {
    model: 'credential',
    scope: { ownerId: null }, // org Keystore only — never personal items
    match: (q) => [{ name: ci(q) }, { username: ci(q) }],
  },
  SshKey: {
    model: 'sshKey',
    scope: { ownerId: null }, // org Keystore only — never personal items
    match: (q) => [{ name: ci(q) }, { fingerprint: ci(q) }],
  },
  KeyDeployment: {
    model: 'keyDeployment',
    // Deployments only ever use org keys, but keep the guard explicit.
    scope: { sshKey: { ownerId: null } },
    match: (q) => [{ sshKey: { name: ci(q) } }, ...serverNameMatch(q), { targetUser: ci(q) }],
    select: { id: true, batchId: true },
    ids: (r) => [r.id, r.batchId],
  },
  AccessRequest: {
    model: 'accessRequest',
    match: (q) => [...serverNameMatch(q), ...userNameMatch('requester', q), { requestedPrincipal: ci(q) }],
  },
  Certificate: { model: 'certificate', match: (q) => [{ keyId: ci(q) }] },
  Session: {
    model: 'session',
    match: (q) => [...serverNameMatch(q), { targetHost: ci(q) }, ...userNameMatch('user', q)],
  },
  CaKeyPair: { model: 'caKeyPair', match: (q) => [{ name: ci(q) }, { fingerprint: ci(q) }] },
  SsoConfig: { model: 'ssoConfig', match: (q) => [{ name: ci(q) }, { provider: ci(q) }] },
  EmailProvider: { model: 'emailProvider', match: (q) => [{ name: ci(q) }] },
  PostureAlertRule: { model: 'postureAlertRule', match: (q) => [{ name: ci(q) }] },
  ExposureFinding: {
    model: 'exposureFinding',
    match: (q) => [...serverNameMatch(q), { code: ci(q) }, { service: ci(q) }],
  },
  Organization: { model: 'organization', orgField: 'id', match: (q) => [{ name: ci(q) }] },
  // Legacy lowercase type written by healthCheckService (server.health_transition);
  // the SQL join only covers 'Server'.
  server: { model: 'server', match: (q) => [{ hostname: ci(q) }, { displayName: ci(q) }] },
};

/**
 * For every type in RESOURCE_NAME_SEARCH, the ids in `orgId` whose name
 * matches `q` (case-insensitive contains, at most `cap` rows per type).
 * A failing lookup is logged and skipped — it must never break the search.
 *
 * @param {string} orgId
 * @param {string} q
 * @param {{ db?: object, cap?: number }} [opts]  db is injectable for tests
 * @returns {Promise<Array<[string, string[]]>>}  [resourceType, ids] pairs, non-empty only
 */
export async function findResourceIdsByName(orgId, q, { db = prisma, cap = NAME_LOOKUP_CAP } = {}) {
  if (!orgId || !q) return [];
  const results = await Promise.all(
    Object.entries(RESOURCE_NAME_SEARCH).map(async ([type, spec]) => {
      try {
        const rows = await db[spec.model].findMany({
          // org predicate last so no `scope` entry can ever override it
          where: { ...(spec.scope ?? {}), OR: spec.match(q), [spec.orgField ?? 'orgId']: orgId },
          select: spec.select ?? { id: true },
          take: cap,
        });
        const ids = new Set();
        for (const r of rows) for (const id of spec.ids ? spec.ids(r) : [r.id]) if (id) ids.add(id);
        return [type, [...ids]];
      } catch (err) {
        logger.warn('auditService: resource name lookup failed', { resourceType: type, error: err.message });
        return [type, []];
      }
    })
  );
  return results.filter(([, ids]) => ids.length > 0);
}

/**
 * The search OR-clause shared by list()'s search path and exportAll() —
 * action/resourceType/metadata text, ip address, the actor's name/email, the
 * joined resource labels (see the `list()` query's LEFT JOINs — same
 * aliases: ru = actor, rs = Server, rc = Customer, rru = User as a
 * resource), plus one `(resource_type = T AND resource_id IN ids)` branch
 * per type resolved by findResourceIdsByName. It is always placed inside
 * `al.org_id = … AND (…) AND <filters>`, so it can only narrow, never widen.
 */
export function auditSearchFragment(term, nameMatches = []) {
  const idBranches = nameMatches.length
    ? Prisma.sql` OR ${Prisma.join(
        nameMatches.map(
          ([type, ids]) => Prisma.sql`(al.resource_type = ${type} AND al.resource_id IN (${Prisma.join(ids)}))`
        ),
        ' OR '
      )}`
    : Prisma.empty;
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
    OR rru.email ILIKE ${term}${idBranches}
  `;
}

async function buildSearchFragment(orgId, search) {
  const nameMatches = await findResourceIdsByName(orgId, search);
  return auditSearchFragment(`%${search}%`, nameMatches);
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

const shortId = (id) => (id ? String(id).slice(-6) : '');

/**
 * Label resolution for the types the hand-written switch in enrichAuditItems
 * doesn't cover. One batched, org-scoped findMany per type present on the
 * page. Personal Keystore items (ownerId set) are never looked up — their
 * rows fall back to the metadata name snapshot the writer stored, same as a
 * deleted resource. KeyDeployment rows are audited by deployment id OR batch
 * id, so its lookup matches both and `byId` indexes both.
 *
 *   where(ids)  — extra where besides the org predicate (default id IN ids)
 *   select      — Prisma select
 *   byId(rows)  — Map(auditedId → label) (default: row.id → label(row))
 *   label(row)  — display string
 *   link(rid)   — frontend route (must exist) or null
 */
export const RESOURCE_LABELS = {
  Role: {
    model: 'role',
    select: { id: true, name: true },
    label: (r) => r.name,
    link: (rid) => `/admin/roles/${rid}`,
  },
  Credential: {
    model: 'credential',
    where: (ids) => ({ id: { in: ids }, ownerId: null }),
    select: { id: true, name: true, username: true },
    label: (r) => `${r.name} (${r.username})`,
    link: (rid) => `/keystore?tab=identities&highlight=${rid}`,
  },
  SshKey: {
    model: 'sshKey',
    where: (ids) => ({ id: { in: ids }, ownerId: null }),
    select: { id: true, name: true },
    label: (r) => r.name,
    link: (rid) => `/keystore?tab=keys&highlight=${rid}`,
  },
  KeyDeployment: {
    model: 'keyDeployment',
    where: (ids) => ({ OR: [{ id: { in: ids } }, { batchId: { in: ids } }], sshKey: { ownerId: null } }),
    select: {
      id: true,
      batchId: true,
      sshKey: { select: { name: true } },
      server: { select: { hostname: true, displayName: true } },
    },
    byId: (rows) => {
      const out = new Map();
      const batches = new Map();
      for (const r of rows) {
        const host = r.server?.displayName || r.server?.hostname || 'server';
        out.set(r.id, `${r.sshKey?.name || 'key'} → ${host}`);
        if (!batches.has(r.batchId)) batches.set(r.batchId, { key: r.sshKey?.name || 'key', hosts: new Set() });
        batches.get(r.batchId).hosts.add(host);
      }
      for (const [batchId, b] of batches) {
        const hosts = [...b.hosts];
        out.set(batchId, `${b.key} → ${hosts.length === 1 ? hosts[0] : `${hosts.length} servers`}`);
      }
      return out;
    },
    link: () => '/keystore?tab=deployments',
  },
  CaKeyPair: {
    model: 'caKeyPair',
    select: { id: true, name: true },
    label: (r) => r.name,
    link: () => '/admin/ca',
  },
  SsoConfig: {
    model: 'ssoConfig',
    select: { id: true, name: true },
    label: (r) => r.name,
    link: () => '/admin/sso',
  },
  EmailProvider: {
    model: 'emailProvider',
    select: { id: true, name: true },
    label: (r) => r.name,
    link: () => '/admin/email',
  },
  PostureAlertRule: {
    model: 'postureAlertRule',
    select: { id: true, name: true },
    label: (r) => r.name,
    link: () => '/admin/posture',
  },
  ExposureFinding: {
    model: 'exposureFinding',
    select: { id: true, code: true, port: true, server: { select: { hostname: true, displayName: true } } },
    label: (r) =>
      `${r.code}${r.port != null ? `:${r.port}` : ''} on ${r.server?.displayName || r.server?.hostname || 'server'}`,
    link: () => '/posture',
  },
  Organization: {
    model: 'organization',
    orgField: 'id',
    select: { id: true, name: true },
    label: (r) => r.name,
    link: () => '/admin/organization',
  },
  ImportJob: {
    model: 'importJob',
    select: { id: true, source: true, createdAt: true },
    label: (r) => `${String(r.source || 'import').toUpperCase()} import #${shortId(r.id)}`,
    link: () => '/bulk-import',
  },
};

export async function lookupLabels(type, ids, orgId, db = prisma) {
  const spec = RESOURCE_LABELS[type];
  const rows = await db[spec.model].findMany({
    // org predicate last so a spec's `where` can never override it
    where: { ...(spec.where ? spec.where(ids) : { id: { in: ids } }), [spec.orgField ?? 'orgId']: orgId },
    select: spec.select,
  });
  return spec.byId ? spec.byId(rows) : new Map(rows.map((r) => [r.id, spec.label(r)]));
}

/** Name snapshot some writers store in metadata — the only label left for a deleted/personal resource. */
function metadataName(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const n = metadata.name ?? metadata.hostname;
  return typeof n === 'string' && n.trim() ? n : null;
}

// healthCheckService writes a legacy lowercase 'server' resourceType.
const normalizeType = (t) => (t === 'server' ? 'Server' : t);

async function enrichAuditItems(items, orgId) {
  if (!Array.isArray(items) || items.length === 0) return items;

  // Bucket distinct IDs by resource type so each lookup is a single
  // batched query.
  const actorIds = new Set();
  const byType = new Map(); // type -> Set(id)

  for (const it of items) {
    if (it.actorId) actorIds.add(it.actorId);
    if (it.resourceType && it.resourceId) {
      const t = normalizeType(it.resourceType);
      if (!byType.has(t)) byType.set(t, new Set());
      byType.get(t).add(it.resourceId);
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

  // Every other labelled type — table-driven (RESOURCE_LABELS), batched per type.
  for (const type of Object.keys(RESOURCE_LABELS)) {
    if (!byType.has(type)) continue;
    promises.push(
      lookupLabels(type, [...byType.get(type)], orgId)
        .then((map) => {
          lookups[type] = map;
        })
        .catch((err) => {
          // A label is cosmetic — never fail the list over it.
          logger.warn('auditService: label lookup failed', { resourceType: type, error: err.message });
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
    const rt = normalizeType(it.resourceType);
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
        default: {
          const spec = RESOURCE_LABELS[rt];
          if (spec) {
            label = lookups[rt]?.get(rid) ?? rt;
            link = spec.link(rid);
          } else {
            label = rt;
            link = null;
          }
        }
      }
      // Deleted, personal or unlabelled resource: fall back to the name
      // snapshot the writer stored in metadata (already in this row).
      if (label === rt) label = metadataName(it.metadata) ?? rt;
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
    const extraConditions = buildExtraConditions(filters);
    const searchFragment = await buildSearchFragment(orgId, search);
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
