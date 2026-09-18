/**
 * terminalHub.js
 *
 * In-memory registry of *live* SSH terminal sessions (tmux-like). A hub
 * session survives WebSocket disconnects (page close, navigation, network
 * blip) for a grace period (`TERMINAL_DETACH_TTL_SECONDS`), can be attached
 * from more than one socket at a time (output fans out to all of them), and
 * is the single owner of the ssh2 `client`/`stream` handles once a shell has
 * been opened — see docs/terminal-workspace.md section 1.
 *
 * One process only: session state lives in this module's memory, so a
 * reattach must land on the backend instance that created the session
 * (documented limitation — sticky routing needed for multi-replica setups).
 *
 * Security:
 *   - Every session is scoped to (orgId, userId) at creation; attach/rename/
 *     duplicate/close all re-check ownership (`requireOwned`) and throw
 *     `HubError` (mapped to 404/403) rather than leaking existence.
 *   - `connectSpec` — the data needed to open an identical *new* session for
 *     "Duplicate" — is stored in memory only. For Quick Connect sessions it
 *     carries ad hoc auth material (password/private key), so it is
 *     AES-256-GCM encrypted at rest in this process's memory (utils/crypto)
 *     and dropped entirely when the session ends. It is NEVER persisted to
 *     the database and NEVER logged.
 *   - Output/replay buffers are plain session transcript (same content the
 *     recording already captures) — not treated as secret.
 */

import logger from '../utils/logger.js';
import prisma from '../config/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import * as sessionService from './sessionService.js';
import { log as auditLog, ACTIONS } from './auditService.js';

const RING_BUFFER_MAX_BYTES = 512 * 1024; // 512 KB of recent output per session
const DETACH_TTL_SECONDS = parseInt(process.env.TERMINAL_DETACH_TTL_SECONDS, 10) || 900; // 15 min
const AR_CHECK_INTERVAL_MS = 30000; // 30s

// A session ended via one of these reasons is a fault/administrative
// close — recorded as TERMINATED. Everything else (normal exit, explicit
// close, detach timeout, access-request expiry, graceful shutdown) is ENDED.
const TERMINATED_REASONS = new Set(['terminated', 'error']);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sessions = new Map(); // sessionId -> hub record

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class HubError extends Error {
  constructor(code, wsCode, message) {
    super(message);
    this.name = 'HubError';
    this.code = code; // 'SESSION_NOT_FOUND' | 'SESSION_FORBIDDEN'
    this.wsCode = wsCode; // WebSocket close code (4404 / 4403)
    this.httpStatus = wsCode === 4403 ? 403 : 404;
  }
}

function requireOwned(sessionId, userId, orgId) {
  const rec = sessions.get(sessionId);
  if (!rec || rec.ended) throw new HubError('SESSION_NOT_FOUND', 4404, 'Session not found');
  if (rec.userId !== userId || rec.orgId !== orgId) {
    throw new HubError('SESSION_FORBIDDEN', 4403, 'You do not have access to this session');
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Ring buffer — keeps the most recent RING_BUFFER_MAX_BYTES of output so a
// reattach can replay recent history.
// ---------------------------------------------------------------------------

class RingBuffer {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.size += buf.length;
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      this.size -= removed.length;
    }
    // A single chunk larger than the whole buffer — trim to the tail.
    if (this.size > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0];
      const trimmed = only.subarray(only.length - this.maxBytes);
      this.chunks[0] = trimmed;
      this.size = trimmed.length;
    }
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.size);
  }
}

// ---------------------------------------------------------------------------
// connectSpec encode/decode — see module header for the security rationale.
// ---------------------------------------------------------------------------

function encodeConnectSpec(spec) {
  if (!spec) return null;
  if (spec.type === 'quick_connect') {
    const { type, ...rest } = spec;
    return { type, encrypted: encrypt(JSON.stringify(rest)) };
  }
  // { type: 'access_request', requestId, principal } — no secret material.
  return { ...spec };
}

function decodeConnectSpec(spec) {
  if (!spec) return null;
  if (spec.type === 'quick_connect') {
    return { type: 'quick_connect', ...JSON.parse(decrypt(spec.encrypted)) };
  }
  return { ...spec };
}

// ---------------------------------------------------------------------------
// Wire fan-out
// ---------------------------------------------------------------------------

function sendJson(ws, obj) {
  try {
    if (ws.readyState === ws.constructor.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

function fanoutRaw(rec, chunk) {
  for (const ws of rec.sockets) {
    try {
      if (ws.readyState === ws.constructor.OPEN) ws.send(chunk);
    } catch {
      /* ignore */
    }
  }
}

function wireStream(rec) {
  const { stream, client, id } = rec;

  const onData = (chunk) => {
    rec.lastActivityAt = new Date();
    rec.buffer.push(chunk);
    if (rec.recordingWriter) rec.recordingWriter.write(chunk);
    fanoutRaw(rec, chunk);
  };

  stream.on('data', onData);
  stream.stderr?.on('data', onData);

  stream.on('close', () => {
    end(id, 'exit').catch((err) => logger.warn('terminalHub: end(exit) failed', { sessionId: id, error: err.message }));
  });
  stream.on('error', (err) => {
    logger.warn('terminalHub: ssh2 stream error', { sessionId: id, error: err.message });
    end(id, 'error').catch(() => {});
  });

  client.on('error', (err) => {
    logger.warn('terminalHub: ssh2 client error', { sessionId: id, error: err.message });
    end(id, 'error').catch(() => {});
  });
  client.on('close', () => {
    // Also fires after a clean client.end() — end() is idempotent.
    end(id, 'exit').catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Public shape (safe to return over the REST API)
// ---------------------------------------------------------------------------

function toPublicShape(rec) {
  const detachDeadline = rec.detachedAt
    ? new Date(rec.detachedAt.getTime() + DETACH_TTL_SECONDS * 1000)
    : null;
  const arDeadline = rec.accessRequestExpiresAt || null;

  let endsAt = null;
  if (detachDeadline && arDeadline) endsAt = detachDeadline < arDeadline ? detachDeadline : arDeadline;
  else endsAt = detachDeadline || arDeadline || null;

  return {
    id: rec.id,
    label: rec.meta.label || null,
    host: rec.meta.targetHost || null,
    port: rec.meta.targetPort || null,
    username: rec.meta.targetUser || null,
    authMethod: rec.meta.authMethod || null,
    server: rec.meta.server || null,
    accessRequestId: rec.meta.accessRequestId || null,
    attachedCount: rec.sockets.size,
    state: rec.sockets.size > 0 ? 'attached' : 'detached',
    startedAt: rec.startedAt,
    lastActivityAt: rec.lastActivityAt,
    detachedAt: rec.detachedAt,
    endsAt,
    canDuplicate: !!rec.connectSpec,
  };
}

// ---------------------------------------------------------------------------
// create — register a brand-new live session (ssh2 shell already open)
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {string} params.id                  - Session.id (from sessionService.create)
 * @param {string} params.orgId
 * @param {string} params.userId
 * @param {import('ssh2').Client} params.client
 * @param {import('ssh2').ClientChannel} params.stream
 * @param {number} params.rows
 * @param {number} params.cols
 * @param {object|null} [params.recordingWriter]
 * @param {object} params.meta                - { targetHost, targetPort, targetUser, authMethod, serverId, accessRequestId, server, label }
 * @param {object|null} [params.connectSpec]   - { type:'quick_connect', host, port, username, auth, expectedHostKey } | { type:'access_request', requestId, principal }
 * @param {Date|null} [params.accessRequestExpiresAt]
 * @returns {object} public shape
 */
export function create({
  id,
  orgId,
  userId,
  client,
  stream,
  rows,
  cols,
  recordingWriter,
  meta,
  connectSpec,
  accessRequestExpiresAt,
}) {
  const rec = {
    id,
    orgId,
    userId,
    client,
    stream,
    rows,
    cols,
    sockets: new Set(),
    buffer: new RingBuffer(RING_BUFFER_MAX_BYTES),
    recordingWriter: recordingWriter || null,
    meta: { ...meta },
    connectSpec: encodeConnectSpec(connectSpec),
    accessRequestExpiresAt: accessRequestExpiresAt || null,
    ended: false,
    detachedAt: null,
    detachTimer: null,
    startedAt: new Date(),
    lastActivityAt: new Date(),
  };

  sessions.set(id, rec);
  wireStream(rec);

  logger.info('terminalHub: session created', {
    sessionId: id,
    orgId,
    userId,
    authMethod: meta?.authMethod,
  });

  return toPublicShape(rec);
}

// ---------------------------------------------------------------------------
// addSocket — register the *initiating* socket of a new session. No
// 'attached' control frame / replay — the caller already sent 'connected'.
// ---------------------------------------------------------------------------

export function addSocket(sessionId, ws) {
  const rec = sessions.get(sessionId);
  if (!rec || rec.ended) return;
  rec.sockets.add(ws);
  if (rec.detachTimer) {
    clearTimeout(rec.detachTimer);
    rec.detachTimer = null;
  }
  rec.detachedAt = null;
}

// ---------------------------------------------------------------------------
// attach — reattach an owned socket to a live session; sends 'attached' +
// buffered replay.
// ---------------------------------------------------------------------------

export function attach(sessionId, ws, { userId, orgId }, { rows, cols } = {}) {
  const rec = requireOwned(sessionId, userId, orgId);

  if (rec.detachTimer) {
    clearTimeout(rec.detachTimer);
    rec.detachTimer = null;
  }
  rec.detachedAt = null;
  rec.sockets.add(ws);
  rec.lastActivityAt = new Date();

  if (rows && cols) resize(sessionId, rows, cols);

  const replay = rec.buffer.toBuffer();
  sendJson(ws, { type: 'attached', sessionId, replayBytes: replay.length });
  if (replay.length) {
    try {
      if (ws.readyState === ws.constructor.OPEN) ws.send(replay);
    } catch {
      /* ignore */
    }
  }

  auditLog({
    orgId: rec.orgId,
    actorId: userId,
    action: ACTIONS.session.attach,
    resourceType: 'Session',
    resourceId: sessionId,
  }).catch(() => {});

  return toPublicShape(rec);
}

// ---------------------------------------------------------------------------
// detach — socket drop / page close. Session keeps running; starts the
// detach-TTL timer once the last socket leaves.
// ---------------------------------------------------------------------------

export function detach(sessionId, ws) {
  const rec = sessions.get(sessionId);
  if (!rec) return;
  const had = rec.sockets.delete(ws);
  if (!had) return;

  if (rec.sockets.size === 0 && !rec.ended) {
    rec.detachedAt = new Date();
    if (rec.detachTimer) clearTimeout(rec.detachTimer);
    rec.detachTimer = setTimeout(() => {
      end(sessionId, 'detached_timeout').catch((err) =>
        logger.warn('terminalHub: detach-timeout end failed', { sessionId, error: err.message })
      );
    }, DETACH_TTL_SECONDS * 1000);
    rec.detachTimer.unref?.();

    auditLog({
      orgId: rec.orgId,
      actorId: rec.userId,
      action: ACTIONS.session.detach,
      resourceType: 'Session',
      resourceId: sessionId,
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// write / resize — input from any attached socket
// ---------------------------------------------------------------------------

export function write(sessionId, data) {
  const rec = sessions.get(sessionId);
  if (!rec || rec.ended || !rec.stream || rec.stream.destroyed) return;
  rec.lastActivityAt = new Date();
  try {
    rec.stream.write(data);
  } catch {
    /* ignore */
  }
}

export function resize(sessionId, rows, cols) {
  const rec = sessions.get(sessionId);
  if (!rec || rec.ended) return;
  const r = Math.max(1, parseInt(rows, 10) || rec.rows);
  const c = Math.max(1, parseInt(cols, 10) || rec.cols);
  rec.rows = r;
  rec.cols = c;
  try {
    rec.stream?.setWindow?.(r, c, 0, 0);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// end — terminate a live session for any reason. Idempotent.
// ---------------------------------------------------------------------------

/**
 * @param {string} sessionId
 * @param {'exit'|'closed'|'detached_timeout'|'expired'|'terminated'|'error'|'shutdown'} reason
 * @param {object} [extraMetadata] - merged into Session.metadata (e.g. { terminatedBy })
 * @returns {Promise<object|null>} updated Session row, or null if the session was already gone
 */
export async function end(sessionId, reason, extraMetadata = {}) {
  const rec = sessions.get(sessionId);
  if (!rec || rec.ended) return null;
  rec.ended = true;
  if (rec.detachTimer) {
    clearTimeout(rec.detachTimer);
    rec.detachTimer = null;
  }
  sessions.delete(sessionId);

  sendJsonToAll(rec, { type: 'ended', reason });
  for (const ws of rec.sockets) {
    try {
      ws.close(1000, `session ${reason}`);
    } catch {
      /* ignore */
    }
  }
  rec.sockets.clear();

  try {
    rec.stream?.close?.();
  } catch {
    /* ignore */
  }
  try {
    rec.client?.end?.();
  } catch {
    /* ignore */
  }

  if (rec.recordingWriter) {
    try {
      rec.recordingWriter.close();
      const uploaded = await rec.recordingWriter.waitUpload();
      if (uploaded) {
        await prisma.session.update({
          where: { id: sessionId },
          data: { recordingKey: rec.recordingWriter.recordingKey },
        });
      }
    } catch (err) {
      logger.warn('terminalHub: failed to finalize recording', { sessionId, error: err.message });
    }
    rec.recordingWriter = null;
  }

  const status = TERMINATED_REASONS.has(reason) ? 'TERMINATED' : 'ENDED';
  let updated = null;
  try {
    updated = await sessionService.end(sessionId, {
      status,
      metadataPatch: { endReason: reason, ...extraMetadata },
    });
  } catch (err) {
    logger.warn('terminalHub: session end write failed', { sessionId, error: err.message });
  }

  auditLog({
    orgId: rec.orgId,
    actorId: rec.userId,
    action: ACTIONS.session.end,
    resourceType: 'Session',
    resourceId: sessionId,
    metadata: { reason },
  }).catch(() => {});

  // Drop the (possibly secret-bearing) connectSpec — never persisted.
  rec.connectSpec = null;

  logger.info('terminalHub: session ended', { sessionId, reason });
  return updated;
}

function sendJsonToAll(rec, obj) {
  const payload = JSON.stringify(obj);
  for (const ws of rec.sockets) {
    try {
      if (ws.readyState === ws.constructor.OPEN) ws.send(payload);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// closeOwned — ownership-checked wrapper for the REST "close" endpoint
// ---------------------------------------------------------------------------

export async function closeOwned(sessionId, { userId, orgId }) {
  requireOwned(sessionId, userId, orgId);
  return end(sessionId, 'closed');
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

export function rename(sessionId, { userId, orgId }, label) {
  const rec = requireOwned(sessionId, userId, orgId);
  rec.meta.label = String(label).slice(0, 60);
  return toPublicShape(rec);
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Raw lookup, no ownership check — for admin/internal use (e.g. admin terminate). */
export function get(sessionId) {
  return sessions.get(sessionId);
}

export function has(sessionId) {
  const rec = sessions.get(sessionId);
  return !!rec && !rec.ended;
}

export function getPublic(sessionId, { userId, orgId }) {
  const rec = requireOwned(sessionId, userId, orgId);
  return toPublicShape(rec);
}

/** Decrypted connectSpec for "Duplicate" — internal use only, never serialize as-is. */
export function getConnectSpec(sessionId, { userId, orgId }) {
  const rec = requireOwned(sessionId, userId, orgId);
  return decodeConnectSpec(rec.connectSpec);
}

export function list(userId, orgId) {
  const out = [];
  for (const rec of sessions.values()) {
    if (rec.ended) continue;
    if (rec.userId !== userId || rec.orgId !== orgId) continue;
    out.push(toPublicShape(rec));
  }
  out.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  return out;
}

// ---------------------------------------------------------------------------
// Access-request expiry watcher — ends sessions whose backing access request
// has expired or been revoked, even while nobody is attached.
// ---------------------------------------------------------------------------

async function checkExpiries() {
  const now = Date.now();
  const withAr = [];

  for (const rec of sessions.values()) {
    if (rec.ended) continue;
    if (rec.accessRequestExpiresAt && rec.accessRequestExpiresAt.getTime() <= now) {
      end(rec.id, 'expired').catch((err) =>
        logger.warn('terminalHub: expiry end failed', { sessionId: rec.id, error: err.message })
      );
      continue;
    }
    if (rec.meta.accessRequestId) withAr.push(rec);
  }

  if (withAr.length === 0) return;

  try {
    const ars = await prisma.accessRequest.findMany({
      where: { id: { in: withAr.map((r) => r.meta.accessRequestId) } },
      select: { id: true, status: true, expiresAt: true },
    });
    const byId = new Map(ars.map((a) => [a.id, a]));

    for (const rec of withAr) {
      if (rec.ended) continue;
      const ar = byId.get(rec.meta.accessRequestId);
      if (!ar) continue;
      if (ar.status === 'REVOKED' || ar.status === 'DENIED' || ar.status === 'EXPIRED') {
        end(rec.id, 'expired').catch(() => {});
        continue;
      }
      if (ar.expiresAt) {
        rec.accessRequestExpiresAt = ar.expiresAt; // refresh cache
        if (ar.expiresAt.getTime() <= now) end(rec.id, 'expired').catch(() => {});
      }
    }
  } catch (err) {
    logger.warn('terminalHub: checkExpiries DB lookup failed', { error: err.message });
  }
}

let expiryTimer = null;

export function startExpiryWatcher() {
  if (expiryTimer) return;
  expiryTimer = setInterval(() => {
    checkExpiries().catch((err) => logger.warn('terminalHub: checkExpiries failed', { error: err.message }));
  }, AR_CHECK_INTERVAL_MS);
  expiryTimer.unref?.();
}

export function stopExpiryWatcher() {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}

// Auto-start in normal operation. Tests can call stopExpiryWatcher() and
// drive checkExpiries()/timers explicitly.
startExpiryWatcher();

// ---------------------------------------------------------------------------
// endAll — graceful shutdown
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// endAllForUser — kill every live hub (SSH) session belonging to a user,
// e.g. on suspend/deactivate/delete/role-change/revoke-sessions/password
// change/reset. Scoped to orgId when provided (defense in depth — userId is
// already globally unique). Does NOT touch RDP sessions (those aren't
// tracked in this module) — see terminalService.endAllSessionsForUser.
// ---------------------------------------------------------------------------

export async function endAllForUser(userId, orgId, reason = 'revoked') {
  const ids = [];
  for (const rec of sessions.values()) {
    if (rec.ended) continue;
    if (rec.userId !== userId) continue;
    if (orgId && rec.orgId !== orgId) continue;
    ids.push(rec.id);
  }
  await Promise.all(
    ids.map((id) =>
      end(id, reason).catch((err) => logger.warn('terminalHub: endAllForUser failed', { sessionId: id, error: err.message }))
    )
  );
  if (ids.length) {
    logger.info('terminalHub: ended all sessions for user', { userId, orgId, reason, count: ids.length });
  }
  return ids.length;
}

export async function endAll(reason) {
  const ids = [...sessions.keys()];
  await Promise.all(
    ids.map((id) =>
      end(id, reason).catch((err) => logger.warn('terminalHub: endAll failed', { sessionId: id, error: err.message }))
    )
  );
}

export default {
  HubError,
  create,
  addSocket,
  attach,
  detach,
  write,
  resize,
  end,
  closeOwned,
  rename,
  get,
  has,
  getPublic,
  getConnectSpec,
  list,
  endAllForUser,
  startExpiryWatcher,
  stopExpiryWatcher,
  endAll,
};

// Exported for tests only.
export const __testing = { checkExpiries, RING_BUFFER_MAX_BYTES, DETACH_TTL_SECONDS };
