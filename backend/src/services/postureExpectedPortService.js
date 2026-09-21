/**
 * postureExpectedPortService.js
 *
 * Per-server "this port is meant to be public" entries.
 *
 * The org-wide list on PostureSettings answers "port 8080 is fine" for the
 * whole fleet, which is the wrong granularity for the common case: 8080 on a
 * demo box is routine, 8080 on a database host is worth a phone call. These
 * entries answer it per host, so silencing one server never silences the
 * others — and so the decision can be made from the finding you are looking
 * at instead of by editing a global list in Administration.
 *
 * Adding an entry resolves the matching open findings immediately rather than
 * waiting for the next snapshot: the whole point of doing this from the
 * finding modal is that the inbox visibly shrinks when you act on it.
 */

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { serverScopeWhere } from '../lib/scope.js';

const PROTOS = ['tcp', 'udp', 'any'];

/** Codes an expected-public declaration makes moot. */
const SUPERSEDED_CODES = ['PORT_EXPOSED', 'SENSITIVE_PORT_EXPOSED', 'DOCKER_FIREWALL_BYPASS'];

/**
 * Load the server, enforcing customer scope. 404 (never 403) when it is out
 * of scope — "exists but not yours" is itself a disclosure.
 */
async function assertServer(orgId, serverId, scope) {
  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId, ...serverScopeWhere(scope) },
    select: { id: true, hostname: true, displayName: true },
  });
  if (!server) throw new ApiError(404, 'Server not found');
  return server;
}

function dto(row) {
  return {
    id: row.id,
    serverId: row.serverId,
    port: row.port,
    proto: row.proto,
    note: row.note ?? null,
    createdAt: row.createdAt,
    createdBy: row.createdBy
      ? { id: row.createdBy.id, name: row.createdBy.name, email: row.createdBy.email }
      : null,
  };
}

export async function listForServer(orgId, serverId, scope) {
  await assertServer(orgId, serverId, scope);
  const rows = await prisma.serverExpectedPort.findMany({
    where: { orgId, serverId },
    orderBy: [{ port: 'asc' }, { proto: 'asc' }],
    include: { },
  });
  // createdById is a plain column (no relation), so resolve the names in one go.
  const ids = [...new Set(rows.map((r) => r.createdById).filter(Boolean))];
  const users = ids.length
    ? await prisma.user.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, name: true, email: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => dto({ ...r, createdBy: byId.get(r.createdById) || null }));
}

/**
 * Declare one or more ports expected on this server.
 *
 * @param {Array<{port:number, proto?:string, note?:string}>} entries
 * @returns {Promise<{added: number, skipped: number, resolvedFindings: number, items: object[]}>}
 */
export async function addForServer(orgId, serverId, entries, { actorId, scope } = {}) {
  await assertServer(orgId, serverId, scope);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ApiError(400, 'At least one port is required');
  }

  const normalized = entries.map((e) => {
    const port = Number(e.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApiError(400, `Invalid port: ${e.port}`);
    }
    const proto = String(e.proto || 'any').toLowerCase();
    if (!PROTOS.includes(proto)) throw new ApiError(400, `Invalid protocol: ${e.proto}`);
    const note = typeof e.note === 'string' ? e.note.trim() : '';
    // Same rule as muting: a suppression with no stated cause is
    // indistinguishable from a mistake when someone reviews it later.
    if (!note) throw new ApiError(400, 'A reason is required for each expected port');
    return { orgId, serverId, port, proto, note, createdById: actorId || null };
  });

  const result = await prisma.serverExpectedPort.createMany({
    data: normalized,
    skipDuplicates: true,
  });

  // Resolve what this declaration just made moot. `proto: 'any'` matches
  // findings on either protocol, which is why the filter is built per entry
  // rather than as one big IN.
  const now = new Date();
  let resolvedFindings = 0;
  for (const entry of normalized) {
    const where = {
      orgId,
      serverId,
      port: entry.port,
      resolvedAt: null,
      code: { in: SUPERSEDED_CODES },
      ...(entry.proto === 'any' ? {} : { proto: entry.proto }),
    };
    const { count } = await prisma.exposureFinding.updateMany({ where, data: { resolvedAt: now } });
    resolvedFindings += count;
  }

  logger.info('postureExpectedPort: entries added', {
    orgId,
    serverId,
    added: result.count,
    resolvedFindings,
  });

  return {
    added: result.count,
    skipped: normalized.length - result.count,
    resolvedFindings,
    items: await listForServer(orgId, serverId, scope),
  };
}

export async function removeForServer(orgId, serverId, id, { scope } = {}) {
  await assertServer(orgId, serverId, scope);
  const existing = await prisma.serverExpectedPort.findFirst({ where: { id, orgId, serverId } });
  if (!existing) throw new ApiError(404, 'Expected port not found');
  await prisma.serverExpectedPort.delete({ where: { id } });
  // The finding is NOT re-opened here. It will come back on the next
  // snapshot if the port is still listening, which is the only evidence that
  // actually justifies re-opening it.
  return { removed: true };
}

export default { listForServer, addForServer, removeForServer };
