/**
 * quickConnectService.js
 *
 * Ad-hoc SSH sessions to a host that isn't (and may never be) saved as a
 * Server. A ticket is a short-lived (60s), single-use, encrypted bundle of
 * connection details stored in Redis and bound to the issuing user — the
 * WebSocket terminal (terminalService.js) consumes it exactly once.
 *
 * Settings live in Organization.settings.quickConnect ({ enabled, minRole }).
 *
 * Security:
 *   - Prod guard: any host matching a saved prod server's ipAddress/hostname
 *     is refused — users must go through the access-request approval flow.
 *   - Ticket payloads (which may carry a plaintext password/private key
 *     pasted ad hoc by the user) are AES-256-GCM encrypted at rest in Redis
 *     and GETDEL'd on consumption (single use). Never logged.
 */

import crypto from 'crypto';
import net from 'net';

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import redis from '../config/redis.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import * as sshKeysUtil from '../utils/sshKeys.js';
import { resolveCredentialAuth } from './keystoreService.js';
import { log as auditLog } from './auditService.js';

const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, member: 1 };
const VALID_ROLES = Object.keys(ROLE_RANK);
const TICKET_TTL_SECONDS = 60;

const HOSTNAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isValidHost(host) {
  if (!host || typeof host !== 'string' || /\s/.test(host)) return false;
  if (net.isIP(host) !== 0) return true;
  return HOSTNAME_RE.test(host) && host.length <= 253;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadQuickConnectSettings(orgId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  const qc = (org?.settings && org.settings.quickConnect) || {};
  return {
    enabled: qc.enabled !== undefined ? !!qc.enabled : true,
    minRole: VALID_ROLES.includes(qc.minRole) ? qc.minRole : 'manager',
  };
}

export async function getSettings(orgId, callerRole) {
  const { enabled, minRole } = await loadQuickConnectSettings(orgId);
  const allowed = enabled && (ROLE_RANK[callerRole] ?? 0) >= (ROLE_RANK[minRole] ?? 0);
  return { enabled, minRole, allowed };
}

export async function updateSettings(orgId, { enabled, minRole }, actorId) {
  if (!VALID_ROLES.includes(minRole)) {
    throw new ApiError(400, `minRole must be one of: ${VALID_ROLES.join(', ')}`);
  }
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  const settings = { ...(org?.settings || {}), quickConnect: { enabled: !!enabled, minRole } };
  await prisma.organization.update({ where: { id: orgId }, data: { settings } });

  await auditLog({
    orgId,
    actorId,
    action: 'quick_connect.settings.update',
    resourceType: 'Organization',
    resourceId: orgId,
    metadata: { enabled: !!enabled, minRole },
  });

  return { enabled: !!enabled, minRole, allowed: true };
}

// ---------------------------------------------------------------------------
// Prod guard
// ---------------------------------------------------------------------------

async function assertNotProdHost(orgId, host) {
  const match = await prisma.server.findFirst({
    where: {
      orgId,
      environment: 'prod',
      OR: [{ ipAddress: host }, { hostname: { equals: host, mode: 'insensitive' } }],
    },
    select: { id: true },
  });
  if (match) {
    throw new ApiError(
      403,
      'This host is a production server — use the access request flow instead of Quick Connect.',
      { code: 'PROD_HOST_REQUIRES_APPROVAL', details: { serverId: match.id } }
    );
  }
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

function validateAuthShape(auth) {
  if (!auth || typeof auth !== 'object') throw new ApiError(400, 'auth is required');
  if (auth.type === 'password') {
    if (!auth.password) throw new ApiError(400, 'auth.password is required for auth.type "password"');
  } else if (auth.type === 'key') {
    if (!auth.privateKey) throw new ApiError(400, 'auth.privateKey is required for auth.type "key"');
  } else if (auth.type === 'credential') {
    if (!auth.credentialId) throw new ApiError(400, 'auth.credentialId is required for auth.type "credential"');
  } else {
    throw new ApiError(400, 'auth.type must be one of: password, key, credential');
  }
}

export async function createTicket(orgId, user, { host, port, username, auth, expectedHostKey }) {
  const settings = await getSettings(orgId, user.role);
  if (!settings.enabled) {
    throw new ApiError(403, 'Quick Connect is disabled for this organization', { code: 'QUICK_CONNECT_DISABLED' });
  }
  if ((ROLE_RANK[user.role] ?? 0) < (ROLE_RANK[settings.minRole] ?? 0)) {
    throw new ApiError(403, 'Your role does not permit Quick Connect', { code: 'QUICK_CONNECT_FORBIDDEN' });
  }

  if (!isValidHost(host)) throw new ApiError(400, 'host must be a valid hostname, IPv4, or IPv6 address');
  const effectivePort = port || 22;
  if (effectivePort < 1 || effectivePort > 65535) throw new ApiError(400, 'port must be between 1 and 65535');

  validateAuthShape(auth);

  let effectiveUsername = username || null;
  if (auth.type === 'credential') {
    const cred = await prisma.credential.findFirst({ where: { id: auth.credentialId, orgId } });
    if (!cred) throw new ApiError(404, 'auth.credentialId not found in organization');
    effectiveUsername = username || cred.username;
  } else {
    if (!username || !USERNAME_RE.test(username)) {
      throw new ApiError(400, 'username is required and must be a valid SSH username');
    }
    if (auth.type === 'key') {
      // Fail fast on an obviously broken key/passphrase rather than at connect time.
      await sshKeysUtil.importPrivateKey({ privateKey: auth.privateKey, passphrase: auth.passphrase });
    }
  }

  await assertNotProdHost(orgId, host);

  const payload = {
    orgId,
    userId: user.id,
    host,
    port: effectivePort,
    username: effectiveUsername,
    auth,
    expectedHostKey: expectedHostKey || null,
  };

  const ticket = crypto.randomBytes(32).toString('hex');
  await redis.set(`qc:ticket:${ticket}`, encrypt(JSON.stringify(payload)), 'EX', TICKET_TTL_SECONDS);

  await auditLog({
    orgId,
    actorId: user.id,
    action: 'quick_connect.ticket',
    resourceType: 'QuickConnect',
    resourceId: null,
    metadata: { host, port: effectivePort, username: effectiveUsername, authType: auth.type },
  });

  return { ticket, expiresIn: TICKET_TTL_SECONDS };
}

/**
 * Consume (single-use) a Quick Connect ticket. Returns connect details ready
 * for sshConnect.connectSsh(), or throws if the ticket is missing/expired/
 * doesn't belong to the caller.
 *
 * @param {string} ticket
 * @param {{ userId: string, orgId: string }} caller
 */
export async function consumeTicket(ticket, { userId, orgId }) {
  if (!ticket) throw new ApiError(400, 'ticket is required');

  const raw = await redis.getdel(`qc:ticket:${ticket}`);
  if (!raw) throw new ApiError(410, 'Quick Connect ticket is invalid or has expired', { code: 'TICKET_EXPIRED' });

  let payload;
  try {
    payload = JSON.parse(decrypt(raw));
  } catch (err) {
    throw new ApiError(400, 'Quick Connect ticket could not be decoded');
  }

  if (payload.userId !== userId || payload.orgId !== orgId) {
    throw new ApiError(403, 'This Quick Connect ticket does not belong to your session');
  }

  const connect = { host: payload.host, port: payload.port, expectedFingerprint: payload.expectedHostKey || undefined };

  if (payload.auth.type === 'password') {
    connect.username = payload.username;
    connect.password = payload.auth.password;
  } else if (payload.auth.type === 'key') {
    connect.username = payload.username;
    connect.privateKey = payload.auth.privateKey;
    connect.passphrase = payload.auth.passphrase || undefined;
  } else if (payload.auth.type === 'credential') {
    const cred = await prisma.credential.findFirst({
      where: { id: payload.auth.credentialId, orgId },
      include: { sshKey: true },
    });
    if (!cred) throw new ApiError(404, 'The identity used for this Quick Connect no longer exists');
    const opts = resolveCredentialAuth(cred);
    connect.username = payload.username || cred.username;
    if (opts.password) connect.password = opts.password;
    if (opts.privateKey) { connect.privateKey = opts.privateKey; connect.passphrase = opts.passphrase; }
  }

  return connect;
}

// ---------------------------------------------------------------------------
// Save as server
// ---------------------------------------------------------------------------

export async function saveAsServer(orgId, actor, body) {
  const {
    host, port, username, hostname, displayName, customerId, environment, description,
    hostKeyFingerprint, hostKeyAlgorithm, identity,
  } = body;

  if (!isValidHost(host)) throw new ApiError(400, 'host must be a valid hostname, IPv4, or IPv6 address');
  if (!customerId) throw new ApiError(400, 'customerId is required');
  const customer = await prisma.customer.findFirst({ where: { id: customerId, orgId } });
  if (!customer) throw new ApiError(400, 'Customer not found in organization');
  if (!username || !USERNAME_RE.test(username)) throw new ApiError(400, 'username is required and must be valid');
  if (!identity || !identity.mode) throw new ApiError(400, 'identity is required');

  const isIp = net.isIP(host) !== 0;

  const result = await prisma.$transaction(async (tx) => {
    let credentialId = null;
    let authMode = 'certificate';

    if (identity.mode === 'existing') {
      if (!identity.credentialId) throw new ApiError(400, 'identity.credentialId is required for mode "existing"');
      const cred = await tx.credential.findFirst({ where: { id: identity.credentialId, orgId } });
      if (!cred) throw new ApiError(404, 'identity.credentialId not found in organization');
      credentialId = cred.id;
      authMode = 'credential';
    } else if (identity.mode === 'new') {
      if (!['admin', 'super_admin'].includes(actor.role)) {
        throw new ApiError(403, 'Creating a new identity requires an admin');
      }
      if (!identity.name) throw new ApiError(400, 'identity.name is required for mode "new"');
      if (!identity.auth || !['password', 'key'].includes(identity.auth.type)) {
        throw new ApiError(400, 'identity.auth.type must be "password" or "key"');
      }

      let sshKeyId = null;
      if (identity.auth.type === 'key') {
        const parsed = await sshKeysUtil.importPrivateKey({
          privateKey: identity.auth.privateKey,
          passphrase: identity.auth.passphrase,
        });
        const key = await tx.sshKey.create({
          data: {
            orgId,
            name: `${identity.name} key`,
            keyType: parsed.keyType,
            bits: parsed.bits,
            publicKey: parsed.publicKey,
            privateKeyEncrypted: encrypt(identity.auth.privateKey),
            passphraseEncrypted: identity.auth.passphrase ? encrypt(identity.auth.passphrase) : null,
            fingerprint: parsed.fingerprint,
            source: 'imported',
            createdById: actor.id,
          },
        });
        sshKeyId = key.id;
      }

      const cred = await tx.credential.create({
        data: {
          orgId,
          name: identity.name,
          username,
          authType: identity.auth.type === 'key' ? 'key' : 'password',
          passwordEncrypted: identity.auth.type === 'password' ? encrypt(identity.auth.password) : null,
          sshKeyId,
          createdById: actor.id,
        },
      });
      credentialId = cred.id;
      authMode = 'credential';
    } else if (identity.mode !== 'none') {
      throw new ApiError(400, 'identity.mode must be one of: existing, new, none');
    }

    const server = await tx.server.create({
      data: {
        orgId,
        customerId,
        hostname: hostname || host,
        displayName: displayName || null,
        description: description || null,
        ipAddress: isIp ? host : '',
        dynamicIp: !isIp,
        port: port || 22,
        protocol: 'ssh',
        environment: environment || 'dev',
        sshUser: username,
        authMode,
        credentialId,
        hostKeyFingerprint: hostKeyFingerprint || null,
        hostKeyAlgorithm: hostKeyAlgorithm || null,
        hostKeyPinnedAt: hostKeyFingerprint ? new Date() : null,
      },
      include: { customer: { select: { id: true, name: true, slug: true } } },
    });

    return server;
  });

  await auditLog({
    orgId,
    actorId: actor.id,
    action: 'quick_connect.save',
    resourceType: 'Server',
    resourceId: result.id,
    metadata: { host, port: port || 22, username, identityMode: identity.mode },
  });

  logger.info('quickConnectService: saved quick-connect target as server', { orgId, serverId: result.id });

  return { server: result };
}

export default { getSettings, updateSettings, createTicket, consumeTicket, saveAsServer };
