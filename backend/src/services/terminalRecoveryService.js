/**
 * terminalRecoveryService — "this terminal tab lost its session, what can the
 * user do now?"
 *
 * A workspace tab points at a hub session id. The live session can
 * disappear without the tab going away:
 *
 *   - backend restart / crash / deploy (hub is in-memory)       → server_restart | shutdown
 *   - access request expired or revoked                          → expired
 *   - admin terminated it, or the user's sessions were revoked   → terminated | revoked
 *   - left detached longer than TERMINAL_DETACH_TTL_SECONDS      → detached_timeout
 *   - remote shell exited, SSH connection dropped                → exit | error
 *
 * describe() explains what happened and picks the one next step that will
 * actually work, re-checking current access every time rather than trusting
 * the tab:
 *
 *   attach          still live (e.g. a network blip), so just reattach
 *   reconnect       open a new session with access the user still has: the same
 *                   (or another) approved, unexpired request for this server,
 *                   or a Quick Connect that used a saved Keystore identity
 *   pending         a request for this server is already awaiting approval
 *   request_access  access expired, was revoked, or was denied: request it again
 *   quick_connect   a one-off password or key, never stored, so it has to be
 *                   re-entered in the Quick Connect dialog (prefilled)
 *   none            nothing to recover to
 *
 * Only the session's owner can see or act on it (org + user scoped, so a
 * foreign id is a 404). reconnect() re-runs the same checks and returns a
 * connect spec. No secrets are returned: at most an access-request id or a
 * fresh single-use Quick Connect ticket, minted by the normal ticket path,
 * which re-applies the prod-host guard.
 */

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import * as hub from './terminalHub.js';
import * as quickConnectService from './quickConnectService.js';

const SERVER_SELECT = { id: true, displayName: true, hostname: true, environment: true };

async function loadOwnedSession(sessionId, { userId, orgId }) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, orgId, userId, sessionType: 'SSH' },
    include: {
      server: { select: SERVER_SELECT },
      accessRequest: {
        select: { id: true, status: true, expiresAt: true, requestedPrincipal: true, requestedDuration: true, reason: true },
      },
    },
  });
  if (!session) throw new ApiError(404, 'Session not found', { code: 'SESSION_NOT_FOUND' });
  return session;
}

/** Latest APPROVED + unexpired, else PENDING, request by this user for this server. */
async function findUsableRequest({ orgId, userId, serverId }) {
  const now = new Date();
  const approved = await prisma.accessRequest.findFirst({
    where: { orgId, requesterId: userId, serverId, status: 'APPROVED', expiresAt: { gt: now } },
    orderBy: { expiresAt: 'desc' },
    select: { id: true, status: true, expiresAt: true, requestedPrincipal: true },
  });
  if (approved) return approved;
  return prisma.accessRequest.findFirst({
    where: { orgId, requesterId: userId, serverId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, expiresAt: true, requestedPrincipal: true },
  });
}

function sessionKind(session) {
  if (session.authMethod === 'quick_connect') return 'quick_connect';
  if (session.accessRequestId || session.serverId) return 'access_request';
  return 'unknown';
}

/**
 * @returns {Promise<object>} {
 *   sessionId, live, status, endReason, endedAt, kind,
 *   target: { host, port, username }, server, accessRequest,
 *   action, actionDetail, connect?, prefill?, requestId?
 * }
 */
export async function describe(sessionId, { userId, orgId }) {
  const session = await loadOwnedSession(sessionId, { userId, orgId });
  const meta = session.metadata && typeof session.metadata === 'object' ? session.metadata : {};
  const kind = sessionKind(session);

  const base = {
    sessionId: session.id,
    live: false,
    status: session.status,
    // Still ACTIVE in the DB but not in the hub: the process that owned it is
    // gone and the startup sweep hasn't reached it yet.
    endReason: meta.endReason || (session.status === 'ACTIVE' ? 'server_restart' : null),
    endedAt: session.endedAt,
    kind,
    target: {
      host: session.targetHost || meta.host || null,
      port: session.targetPort || meta.port || null,
      username: session.targetUser || meta.username || null,
    },
    server: session.server || null,
    accessRequest: session.accessRequest
      ? {
          id: session.accessRequest.id,
          status: session.accessRequest.status,
          expiresAt: session.accessRequest.expiresAt,
        }
      : null,
  };

  if (hub.has(session.id)) {
    try {
      hub.getPublic(session.id, { userId, orgId });
      return { ...base, live: true, status: 'ACTIVE', endReason: null, action: 'attach', connect: { attach: session.id } };
    } catch {
      /* not ours; fall through (can't happen given the owned lookup) */
    }
  }

  if (kind === 'access_request') {
    if (!session.serverId || !session.server) {
      return { ...base, action: 'none', actionDetail: 'The server for this session no longer exists.' };
    }
    const usable = await findUsableRequest({ orgId, userId, serverId: session.serverId });
    if (usable?.status === 'APPROVED') {
      // Keep the original principal when reconnecting on the same request.
      const principal = usable.id === session.accessRequestId ? meta.principal || null : null;
      return {
        ...base,
        action: 'reconnect',
        actionDetail:
          usable.id === session.accessRequestId
            ? 'Your access to this server is still valid.'
            : 'You have another approved request for this server.',
        requestId: usable.id,
        accessExpiresAt: usable.expiresAt,
        ...(principal ? { principal } : {}),
      };
    }
    if (usable?.status === 'PENDING') {
      return {
        ...base,
        action: 'pending',
        actionDetail: 'A request for this server is waiting for approval.',
        requestId: usable.id,
      };
    }
    const arStatus = session.accessRequest?.status;
    let detail = 'Your access to this server has ended. Request access again to reconnect.';
    if (arStatus === 'REVOKED') detail = 'Your access to this server was revoked. Request access again to reconnect.';
    else if (arStatus === 'EXPIRED' || (arStatus === 'APPROVED' && session.accessRequest?.expiresAt <= new Date())) {
      detail = 'Your access to this server expired. Request access again to reconnect.';
    }
    return { ...base, action: 'request_access', actionDetail: detail };
  }

  if (kind === 'quick_connect') {
    const qc = meta.quickConnect || {};
    const prefill = {
      host: base.target.host,
      port: base.target.port || 22,
      username: base.target.username,
      authTab: qc.authType === 'key' ? 'key' : qc.authType === 'credential' ? 'credential' : 'password',
      ...(qc.credentialId ? { credentialId: qc.credentialId } : {}),
    };
    if (qc.authType === 'credential' && qc.credentialId) {
      const cred = await prisma.credential.findFirst({ where: { id: qc.credentialId, orgId }, select: { id: true } });
      if (cred) {
        return {
          ...base,
          action: 'reconnect',
          actionDetail: 'This connection used a saved identity, so it can reconnect directly.',
          prefill,
        };
      }
      return {
        ...base,
        action: 'quick_connect',
        actionDetail: 'The saved identity used for this connection no longer exists. Choose another in Quick Connect.',
        prefill: { ...prefill, credentialId: undefined },
      };
    }
    return {
      ...base,
      action: 'quick_connect',
      actionDetail: 'This connection used a one-off password or key that Shellius never stores. Enter it again to reconnect.',
      prefill,
    };
  }

  return { ...base, action: 'none', actionDetail: 'This session can’t be restored.' };
}

/**
 * Connect spec for the `reconnect` / `attach` actions, for TerminalView.
 * @returns {Promise<{ connect: object }>}
 */
export async function reconnect(sessionId, { userId, orgId, role, permissions }) {
  const info = await describe(sessionId, { userId, orgId });
  if (info.action === 'attach') return { connect: { attach: sessionId } };
  if (info.action !== 'reconnect') {
    throw new ApiError(409, info.actionDetail || 'This session can’t be reconnected', {
      code: 'CANNOT_RECONNECT',
      details: { action: info.action },
    });
  }
  if (info.kind === 'access_request') {
    return { connect: { requestId: info.requestId, ...(info.principal ? { principal: info.principal } : {}) } };
  }
  // Quick Connect with a saved identity: the regular ticket path (prod-host
  // guard, identity lookup, org scoping) mints a fresh single-use ticket.
  const ticket = await quickConnectService.createTicket(orgId, { id: userId, role, permissions }, {
    host: info.prefill.host,
    port: info.prefill.port,
    username: info.prefill.username,
    auth: { type: 'credential', credentialId: info.prefill.credentialId },
  });
  return { connect: { ticket: ticket.ticket } };
}

export default { describe, reconnect };
