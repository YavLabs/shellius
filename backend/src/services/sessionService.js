import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

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
      server: { select: { hostname: true, environment: true } },
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
// list
// ---------------------------------------------------------------------------

/**
 * Paginated list of sessions scoped to the org.
 *
 * @param {object} params
 * @param {string}  params.orgId
 * @param {string}  [params.userId]
 * @param {string}  [params.serverId]
 * @param {'ACTIVE'|'ENDED'|'TERMINATED'} [params.status]
 * @param {number}  [params.page=1]
 * @param {number}  [params.limit=25]
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
export async function list({ orgId, userId, serverId, status, page = 1, limit = 25 }) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  page = parseInt(page, 10) || 1;
  limit = Math.min(parseInt(limit, 10) || 25, 100);

  const where = { orgId };
  if (userId) where.userId = userId;
  if (serverId) where.serverId = serverId;
  if (status) where.status = status;

  const [items, total] = await Promise.all([
    prisma.session.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { startedAt: 'desc' },
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
 * Return all ACTIVE sessions for an org.
 *
 * @param {string} orgId
 * @returns {Promise<object[]>}
 */
export async function listActive(orgId) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  return prisma.session.findMany({
    where: { orgId, status: 'ACTIVE' },
    orderBy: { startedAt: 'desc' },
    include: SESSION_INCLUDE,
  });
}

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

/**
 * Fetch a single session by ID, scoped to org.
 *
 * @param {string} orgId
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function getById(orgId, id) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!id) throw new ApiError(400, 'id is required');

  const session = await prisma.session.findFirst({
    where: { id, orgId },
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
 * Scoped to org + user: never another user's activity.
 *
 * @returns {Promise<Array<{ server, lastConnectedAt, connectCount }>>}
 */
export async function listRecentServersForUser(orgId, userId, { days = 7, limit = 8 } = {}) {
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
    take: Math.min(Math.max(limit, 1), 20),
  });
  if (rows.length === 0) return [];
  const servers = await prisma.server.findMany({
    where: { orgId, id: { in: rows.map((r) => r.serverId) } },
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
