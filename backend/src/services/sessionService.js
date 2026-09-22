import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { UNSCOPED, sessionScopeWhere, serverScopeWhere } from '../lib/scope.js';
import { endOfDayInclusive } from '../utils/dateRange.js';

// ---------------------------------------------------------------------------
// Shared include shape
// ---------------------------------------------------------------------------

const SESSION_INCLUDE = {
  user: { select: { id: true, name: true, email: true, avatarUrl: true } },
  // Null for Quick Connect sessions to hosts that aren't saved servers — the
  // caller should fall back to targetHost/targetPort/targetUser in that case.
  server: {
    select: {
      id: true,
      hostname: true,
      displayName: true,
      environment: true,
      ipAddress: true,
    },
  },
  // Include the originating access request so the Sessions detail
  // modal can render "alice → prod-db (reason)" instead of a raw id.
  accessRequest: {
    select: {
      id: true,
      reason: true,
      requestedPrincipal: true,
      requester: { select: { name: true, email: true } },
      server: { select: { id: true, hostname: true, displayName: true, environment: true } },
    },
  },
};

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create a new Session row with status=ACTIVE.
 *
 * @param {object} params
 * @param {string}  params.orgId
 * @param {string}  params.userId
 * @param {string|null} [params.serverId]  - null for Quick Connect to an unsaved host
 * @param {string}  [params.certificateId]
 * @param {string}  [params.accessRequestId]
 * @param {'SSH'|'RDP'} params.sessionType
 * @param {'certificate'|'credential'|'quick_connect'} [params.authMethod='certificate']
 * @param {string}  [params.targetHost]
 * @param {number}  [params.targetPort]
 * @param {string}  [params.targetUser]
 * @param {string}  [params.clientIp]
 * @param {string}  [params.userAgent]
 * @param {object}  [params.metadata]
 * @returns {Promise<object>}
 */
export async function create({
  orgId,
  userId,
  serverId,
  certificateId,
  accessRequestId,
  sessionType,
  authMethod,
  targetHost,
  targetPort,
  targetUser,
  clientIp,
  userAgent,
  metadata,
}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!userId) throw new ApiError(400, 'userId is required');
  if (!sessionType || !['SSH', 'RDP'].includes(sessionType)) {
    throw new ApiError(400, "sessionType must be 'SSH' or 'RDP'");
  }

  const session = await prisma.session.create({
    data: {
      orgId,
      userId,
      serverId: serverId ?? null,
      certificateId: certificateId ?? null,
      accessRequestId: accessRequestId ?? null,
      sessionType,
      authMethod: authMethod || 'certificate',
      targetHost: targetHost ?? null,
      targetPort: targetPort ?? null,
      targetUser: targetUser ?? null,
      status: 'ACTIVE',
      clientIp: clientIp ?? null,
      userAgent: userAgent ?? null,
      startedAt: new Date(),
      metadata: metadata ?? null,
    },
    include: SESSION_INCLUDE,
  });

  logger.info('sessionService.create: session started', {
    sessionId: session.id,
    orgId,
    userId,
    serverId,
    sessionType,
  });

  return session;
}

// ---------------------------------------------------------------------------
// end
// ---------------------------------------------------------------------------

/**
 * Mark a session as ended. Calculates durationSeconds from startedAt.
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {'ENDED'|'TERMINATED'} [opts.status='ENDED']
 * @param {object} [opts.metadataPatch] - merged into the existing Session.metadata JSON
 *   (e.g. `{ endReason: 'expired' }`) — never overwrites the whole field.
 * @returns {Promise<object>}
 */
export async function end(sessionId, { status = 'ENDED', metadataPatch } = {}) {
  if (!sessionId) throw new ApiError(400, 'sessionId is required');
  if (!['ENDED', 'TERMINATED'].includes(status)) {
    throw new ApiError(400, "status must be 'ENDED' or 'TERMINATED'");
  }

  const existing = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!existing) throw new ApiError(404, 'Session not found');

  const now = new Date();
  const durationSeconds = Math.floor((now.getTime() - existing.startedAt.getTime()) / 1000);

  const data = { status, endedAt: now, durationSeconds };
  if (metadataPatch && typeof metadataPatch === 'object') {
    data.metadata = { ...(existing.metadata ?? {}), ...metadataPatch };
  }

  const updated = await prisma.session.update({
    where: { id: sessionId },
    data,
    include: SESSION_INCLUDE,
  });

  logger.info('sessionService.end: session closed', {
    sessionId,
    status,
    durationSeconds,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// list() sort whitelist — every value here MUST also be enumerated in the
// route's Joi schema (routes/sessions.js `listQuerySchema.sortBy`), so an
// unrecognised column is rejected with a 400 before it ever reaches here.
// ---------------------------------------------------------------------------
function buildOrderBy(sortBy, sortDir) {
  const dir = sortDir === 'asc' ? 'asc' : 'desc';
  switch (sortBy) {
    case 'status':
      return { status: dir };
    case 'user':
      return { user: { name: dir } };
    case 'server':
      return { server: { hostname: dir } };
    case 'startedAt':
    default:
      return { startedAt: dir };
  }
}

/**
 * Extra AND-composed predicates shared by list() and listActive() — search,
 * customer scope (via the server relation), and the free-text filters. Kept
 * separate from the base `where` (which may already carry its own top-level
 * `OR` from `sessionScopeWhere`) so nothing here clobbers it.
 */
function buildExtraClauses({ serverId, userId, authMethod, protocol, environment, clientIp, customerId, search }) {
  const extra = [];
  if (userId) extra.push({ userId });
  if (serverId) extra.push({ serverId });
  if (authMethod) extra.push({ authMethod });
  if (protocol) extra.push({ sessionType: protocol });
  if (environment) extra.push({ server: { environment } });
  // Merged as its own AND element (never spread into an existing `server`
  // key) so it composes with `environment` above instead of clobbering it.
  if (customerId) extra.push({ server: { customerId } });
  if (clientIp) extra.push({ clientIp: { contains: clientIp, mode: 'insensitive' } });
  if (search) {
    const q = search.trim();
    if (q) {
      extra.push({
        OR: [
          { server: { hostname: { contains: q, mode: 'insensitive' } } },
          { server: { displayName: { contains: q, mode: 'insensitive' } } },
          { server: { ipAddress: { contains: q, mode: 'insensitive' } } },
          { targetHost: { contains: q, mode: 'insensitive' } },
          { user: { name: { contains: q, mode: 'insensitive' } } },
          { user: { email: { contains: q, mode: 'insensitive' } } },
          { clientIp: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
  }
  return extra;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * Paginated list of sessions scoped to the org (and, for scoped users, to
 * their customer set — via `sessionScopeWhere`'s OR-branch a scoped user
 * still sees their own Quick Connect sessions, which have no server).
 *
 * @param {object} params
 * @param {string}  params.orgId
 * @param {string}  [params.userId]
 * @param {string}  [params.serverId]
 * @param {'ACTIVE'|'ENDED'|'TERMINATED'} [params.status]
 * @param {string}  [params.search]   matches server name/hostname/ip, target host, user name/email, client IP
 * @param {string}  [params.customerId] via the server relation, ANDed with sessionScopeWhere
 * @param {string}  [params.clientIp]  contains match
 * @param {string}  [params.sortBy='startedAt']  one of startedAt|status|user|server
 * @param {string}  [params.sortDir='desc']
 * @param {number}  [params.page=1]
 * @param {number}  [params.limit=25]
 * @param {{mode: string, customerIds: string[]}} [params.scope=UNSCOPED]
 * @param {string}  [params.callerId] - the authenticated caller's own user id,
 *   NOT the `userId` filter above. `sessionScopeWhere`'s OR-branch keeps a
 *   scoped caller's own Quick Connect sessions visible; if we reused the
 *   `userId` filter here instead, an unfiltered request would pass
 *   `undefined`, which Prisma drops from the `where` and would silently
 *   surface *every* user's Quick Connect sessions to a scoped caller.
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
export async function list({
  orgId,
  userId,
  serverId,
  status,
  authMethod,
  protocol,
  environment,
  clientIp,
  customerId,
  search,
  sortBy = 'startedAt',
  sortDir = 'desc',
  startDate,
  endDate,
  page = 1,
  limit = 25,
  scope = UNSCOPED,
  callerId,
}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  page = parseInt(page, 10) || 1;
  limit = Math.min(parseInt(limit, 10) || 25, 100);

  const base = { orgId, ...sessionScopeWhere(scope, callerId) };
  if (status) base.status = status;
  if (startDate || endDate) {
    base.startedAt = {};
    if (startDate) base.startedAt.gte = new Date(startDate);
    if (endDate) base.startedAt.lte = endOfDayInclusive(endDate);
  }
  const extra = buildExtraClauses({ serverId, userId, authMethod, protocol, environment, clientIp, customerId, search });
  const where = extra.length > 0 ? { AND: [base, ...extra] } : base;

  const [items, total] = await Promise.all([
    prisma.session.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: buildOrderBy(sortBy, sortDir),
      include: SESSION_INCLUDE,
    }),
    prisma.session.count({ where }),
  ]);

  return { items, total, page, limit };
}

// ---------------------------------------------------------------------------
// listActive
// ---------------------------------------------------------------------------

/**
 * Return all ACTIVE sessions for an org, honoring the same filter set as
 * list() (minus `status`, which is forced to ACTIVE). Deliberately
 * unpaginated — this tab shows "what's live right now", which is expected to
 * be small; DataTable paginates the returned array client-side rather than
 * showing page counts for a server page it never actually fetched.
 *
 * @param {string} orgId
 * @param {{mode: string, customerIds: string[]}} [scope=UNSCOPED]
 * @param {string} [callerId] - the authenticated caller's own user id, so a
 *   scoped caller keeps seeing their own active Quick Connect sessions (no
 *   server) alongside sessions on servers in their customer scope.
 * @param {object} [filters] - serverId, userId, authMethod, protocol, environment, clientIp, customerId, search
 * @returns {Promise<object[]>}
 */
export async function listActive(orgId, scope = UNSCOPED, callerId, filters = {}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  const base = { orgId, status: 'ACTIVE', ...sessionScopeWhere(scope, callerId) };
  const extra = buildExtraClauses(filters);
  const where = extra.length > 0 ? { AND: [base, ...extra] } : base;

  return prisma.session.findMany({
    where,
    orderBy: { startedAt: 'desc' },
    include: SESSION_INCLUDE,
  });
}

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

/**
 * Fetch a single session by ID, scoped to org (and, for scoped callers, to
 * their customer set — out-of-scope is a 404, matching every other read).
 *
 * @param {string} orgId
 * @param {string} id
 * @param {{mode: string, customerIds: string[]}} [scope=UNSCOPED]
 * @param {string} [callerId] - the authenticated caller's own user id, so a
 *   scoped caller can still open their own Quick Connect session (no server).
 * @returns {Promise<object>}
 */
export async function getById(orgId, id, scope = UNSCOPED, callerId) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!id) throw new ApiError(400, 'id is required');

  const session = await prisma.session.findFirst({
    where: { id, orgId, ...sessionScopeWhere(scope, callerId) },
    include: SESSION_INCLUDE,
  });

  if (!session) throw new ApiError(404, 'Session not found');

  return session;
}

// ---------------------------------------------------------------------------
// terminate
// ---------------------------------------------------------------------------

/**
 * Mark a session as TERMINATED (administrative force-close).
 * Returns the updated session row; the caller (terminalService) is responsible
 * for closing the associated WebSocket and SSH connections.
 *
 * Org-scoped — a sessionId belonging to another org 404s rather than leaking
 * existence (B-4 hardening).
 *
 * @param {string} orgId
 * @param {string} sessionId
 * @param {string} byUserId  - ID of the admin performing the termination
 * @returns {Promise<object>}
 */
export async function terminate(orgId, sessionId, byUserId) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!sessionId) throw new ApiError(400, 'sessionId is required');

  const existing = await prisma.session.findFirst({ where: { id: sessionId, orgId } });
  if (!existing) throw new ApiError(404, 'Session not found');

  if (existing.status !== 'ACTIVE') {
    throw new ApiError(409, `Session is not active (current status: ${existing.status})`);
  }

  const now = new Date();
  const durationSeconds = Math.floor((now.getTime() - existing.startedAt.getTime()) / 1000);

  const updated = await prisma.session.update({
    where: { id: sessionId },
    data: {
      status: 'TERMINATED',
      endedAt: now,
      durationSeconds,
      metadata: {
        ...(existing.metadata ?? {}),
        terminatedBy: byUserId,
        terminatedAt: now.toISOString(),
      },
    },
    include: SESSION_INCLUDE,
  });

  logger.info('sessionService.terminate: session force-terminated', {
    sessionId,
    byUserId,
    durationSeconds,
  });

  return updated;
}

/**
 * The caller's own recently used servers (dashboard "Recent connections").
 * SSH sessions opened through access requests / saved servers in the last
 * `days` days, one row per server, newest first. Quick Connect sessions are
 * excluded (they have their own history, with auth type and identity).
 * Scoped to org + user: never another user's activity. Also customer-scoped
 * on the server hydrate step — a server that left the caller's scope since
 * the session happened must not linger in their recents (spec §4.1 #20).
 *
 * @param {{mode: string, customerIds: string[]}} [scope=UNSCOPED]
 * @returns {Promise<Array<{ server, lastConnectedAt, connectCount }>>}
 */
export async function listRecentServersForUser(orgId, userId, { days = 7, limit = 8 } = {}, scope = UNSCOPED) {
  if (!orgId || !userId) throw new ApiError(400, 'orgId and userId are required');
  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 30) * 86400 * 1000);
  const rows = await prisma.session.groupBy({
    by: ['serverId'],
    where: {
      orgId,
      userId,
      sessionType: 'SSH',
      serverId: { not: null },
      authMethod: { not: 'quick_connect' },
      startedAt: { gte: since },
    },
    _max: { startedAt: true },
    _count: { _all: true },
    orderBy: { _max: { startedAt: 'desc' } },
    take: Math.min(Math.max(limit, 1), 50),
  });
  if (rows.length === 0) return [];
  const servers = await prisma.server.findMany({
    where: { orgId, id: { in: rows.map((r) => r.serverId) }, ...serverScopeWhere(scope) },
    select: {
      id: true, displayName: true, hostname: true, ipAddress: true, port: true,
      environment: true, authMode: true, provisionStatus: true, protocol: true, agentId: true, agentLastSeen: true,
    },
  });
  const byId = new Map(servers.map((sv) => [sv.id, sv]));
  return rows
    .filter((r) => byId.has(r.serverId))
    .map((r) => ({ server: byId.get(r.serverId), lastConnectedAt: r._max.startedAt, connectCount: r._count._all }));
}

export default { create, end, list, listActive, getById, terminate, listRecentServersForUser };
