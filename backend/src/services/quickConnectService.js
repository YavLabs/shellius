/**
 * quickConnectService.js
 *
 * Ad-hoc SSH sessions to a host that isn't (and may never be) saved as a
 * Server. A ticket is a short-lived (60s), single-use, encrypted bundle of
 * connection details stored in Redis and bound to the issuing user — the
 * WebSocket terminal (terminalService.js) consumes it exactly once.
 *
 * Settings live in Organization.settings.quickConnect ({ enabled }); who may
 * use it is the quick_connect.use permission.
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
import dns from 'dns/promises';

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import redis from '../config/redis.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import * as sshKeysUtil from '../utils/sshKeys.js';
import * as sshConnect from './sshConnect.js';
import { resolveCredentialAuth } from './keystoreService.js';
import { log as auditLog } from './auditService.js';
import * as policyService from './policyService.js';
import { isVaultEnabled } from './orgService.js';

// Who may use Quick Connect is the `quick_connect.use` permission (the old
// settings.quickConnect.minRole was migrated onto the built-in roles by
// roleService.syncSystemRoles). `user` objects passed in here carry
// `permissions` (a Set from req.user.permissions).
function has(user, key) {
  const p = user?.permissions;
  if (!p) return false;
  return p instanceof Set ? p.has(key) : p.includes(key);
}
const TICKET_TTL_SECONDS = 60;
const HISTORY_RETENTION_DAYS = 7;

const HOSTNAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
export const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidHost(host) {
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
  };
}

/**
 * @param {string} orgId
 * @param {{ permissions: Set<string> }} caller
 */
export async function getSettings(orgId, caller) {
  const { enabled } = await loadQuickConnectSettings(orgId);
  const allowed = enabled && has(caller, 'quick_connect.use');
  const vaultEnabled = await isVaultEnabled(orgId);
  return {
    enabled,
    allowed,
    canUseStoredIdentity: allowed && has(caller, 'quick_connect.use_stored_identity'),
    // Personal vault identities (docs/personal-vault.md).
    canUsePersonalIdentity: allowed && vaultEnabled && has(caller, 'vault.use'),
    canSaveServer: has(caller, 'quick_connect.save_server'),
  };
}

export async function updateSettings(orgId, { enabled }, actorId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  const { minRole: _legacy, ...previous } = org?.settings?.quickConnect || {};
  const settings = { ...(org?.settings || {}), quickConnect: { ...previous, enabled: !!enabled } };
  await prisma.organization.update({ where: { id: orgId }, data: { settings } });

  await auditLog({
    orgId,
    actorId,
    action: 'quick_connect.settings.update',
    resourceType: 'Organization',
    resourceId: orgId,
    metadata: { enabled: !!enabled },
  });

  return { enabled: !!enabled };
}

// ---------------------------------------------------------------------------
// Prod guard
// ---------------------------------------------------------------------------

/**
 * Refuse a target that matches a saved prod server — by the exact
 * string (ipAddress/hostname, as before) AND by resolved IP, so
 * `prod-box.internal` can't be reached by IP and `10.0.0.5` can't be reached
 * by a hostname that happens to resolve to it. DNS failures for a prod
 * server's own hostname are tolerated (best-effort; the string check still
 * catches the common case).
 *
 * @param {string} orgId
 * @param {string} host
 * @param {string[]} resolvedIps  - every IP `host` resolved to (from resolveTarget)
 */
export async function assertNotProdHost(orgId, host, resolvedIps = []) {
  const prodServers = await prisma.server.findMany({
    where: { orgId, environment: 'prod' },
    select: { id: true, ipAddress: true, hostname: true },
  });
  if (prodServers.length === 0) return;

  const resolvedSet = new Set(resolvedIps);

  const stringMatch = prodServers.find(
    (s) => (s.ipAddress && s.ipAddress === host) || (s.hostname && s.hostname.toLowerCase() === host.toLowerCase())
  );
  if (stringMatch) {
    throw new ApiError(
      403,
      'This host is a production server — use the access request flow instead of Quick Connect.',
      { code: 'PROD_HOST_REQUIRES_APPROVAL', details: { serverId: stringMatch.id } }
    );
  }

  if (resolvedSet.size === 0) return;

  // Cache resolved IPs per prod server's own ipAddress/hostname for the life
  // of this single guard call (a batch import could otherwise re-resolve the
  // same prod hostnames repeatedly).
  const dnsCache = new Map();
  const resolveHostname = async (hostname) => {
    if (dnsCache.has(hostname)) return dnsCache.get(hostname);
    let ips = [];
    try {
      const records = await dns.lookup(hostname, { all: true, verbatim: true });
      ips = records.map((r) => r.address);
    } catch (err) {
      logger.debug('quickConnectService: prod guard DNS lookup failed (tolerated)', { hostname, error: err.message });
    }
    dnsCache.set(hostname, ips);
    return ips;
  };

  for (const server of prodServers) {
    if (server.ipAddress && resolvedSet.has(server.ipAddress)) {
      throw new ApiError(
        403,
        'This host resolves to a production server — use the access request flow instead of Quick Connect.',
        { code: 'PROD_HOST_REQUIRES_APPROVAL', details: { serverId: server.id } }
      );
    }
    if (server.hostname) {
      const prodIps = await resolveHostname(server.hostname);
      if (prodIps.some((ip) => resolvedSet.has(ip))) {
        throw new ApiError(
          403,
          'This host resolves to a production server — use the access request flow instead of Quick Connect.',
          { code: 'PROD_HOST_REQUIRES_APPROVAL', details: { serverId: server.id } }
        );
      }
    }
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
    // auth.password is optional alongside a key — covers hosts that require
    // BOTH (AuthenticationMethods publickey,password).
  } else if (auth.type === 'credential') {
    if (!auth.credentialId) throw new ApiError(400, 'auth.credentialId is required for auth.type "credential"');
  } else {
    throw new ApiError(400, 'auth.type must be one of: password, key, credential');
  }
}

/**
 * Load a stored identity the caller may see: an org identity, or one of the
 * caller's own personal identities. Someone else's personal identity is a 404.
 */
async function findUsableCredential(orgId, userId, credentialId, { includeKey = false } = {}) {
  return prisma.credential.findFirst({
    where: { id: credentialId, orgId, OR: [{ ownerId: null }, { ownerId: userId }] },
    ...(includeKey ? { include: { sshKey: true } } : {}),
  });
}

/**
 * @param {object} [opts]
 * @param {'quick_connect'|'personal_host'} [opts.via] - personal hosts (My
 *   hosts) are gated by vault.hosts + the vault switch instead of Quick
 *   Connect's permission/switch; every target guard below still runs.
 * @param {string} [opts.personalHostId]
 */
export async function createTicket(orgId, user, { host, port, username, auth, expectedHostKey }, { via = 'quick_connect', personalHostId = null } = {}) {
  const vaultEnabled = await isVaultEnabled(orgId);
  if (via === 'personal_host') {
    if (!vaultEnabled) throw new ApiError(403, 'The personal vault is turned off for this organization', { code: 'VAULT_DISABLED' });
    if (!has(user, 'vault.hosts')) {
      throw new ApiError(403, 'Your role does not permit My hosts', { code: 'PERMISSION_DENIED', details: { missing: ['vault.hosts'] } });
    }
  } else {
    const settings = await getSettings(orgId, user);
    if (!settings.enabled) {
      throw new ApiError(403, 'Quick Connect is disabled for this organization', { code: 'QUICK_CONNECT_DISABLED' });
    }
    if (!settings.allowed) {
      throw new ApiError(403, 'Your role does not permit Quick Connect', { code: 'QUICK_CONNECT_FORBIDDEN' });
    }
  }

  if (!isValidHost(host)) throw new ApiError(400, 'host must be a valid hostname, IPv4, or IPv6 address');
  const effectivePort = port || 22;
  if (effectivePort < 1 || effectivePort > 65535) throw new ApiError(400, 'port must be between 1 and 65535');

  validateAuthShape(auth);

  let effectiveUsername = username || null;
  if (auth.type === 'credential') {
    const cred = await findUsableCredential(orgId, user.id, auth.credentialId);
    if (!cred) throw new ApiError(404, 'auth.credentialId not found in organization');
    if (cred.ownerId) {
      if (!vaultEnabled || !has(user, 'vault.use')) {
        throw new ApiError(403, 'Your role does not permit using your personal vault', {
          code: 'QUICK_CONNECT_FORBIDDEN',
        });
      }
    } else if (!has(user, 'quick_connect.use_stored_identity')) {
      throw new ApiError(403, 'Your role does not permit using stored identities in Quick Connect', {
        code: 'QUICK_CONNECT_FORBIDDEN',
      });
    }
    effectiveUsername = username || cred.username;
  } else {
    if (!username || !USERNAME_RE.test(username)) {
      throw new ApiError(400, 'username is required and must be a valid SSH username');
    }
    if (auth.type === 'key') {
      // Fail fast on a broken key/passphrase, and normalise any supported
      // input format (PKCS#8, PuTTY v2/v3, …) to OpenSSH so ssh2 can use it
      // at redemption. The normalised key keeps the same passphrase.
      const normalized = await sshKeysUtil.normalizePrivateKey({
        privateKey: auth.privateKey,
        passphrase: auth.passphrase,
      });
      auth = { ...auth, privateKey: normalized.privateKey };
    }
  }

  // Resolve once here; the same resolved IP is what we'll actually connect
  // to on redemption (no re-resolution / DNS-rebinding window).
  const resolved = await sshConnect.resolveTarget(host);
  await assertNotProdHost(orgId, host, resolved.addresses);
  await assertNotDeniedHost(orgId, user.id, host, resolved.addresses);

  const payload = {
    orgId,
    userId: user.id,
    host,
    resolvedIp: resolved.ip,
    port: effectivePort,
    username: effectiveUsername,
    auth,
    expectedHostKey: expectedHostKey || null,
    via,
    personalHostId,
  };

  const ticket = crypto.randomBytes(32).toString('hex');
  await redis.set(`qc:ticket:${ticket}`, encrypt(JSON.stringify(payload)), 'EX', TICKET_TTL_SECONDS);

  await auditLog({
    orgId,
    actorId: user.id,
    action: 'quick_connect.ticket',
    resourceType: 'QuickConnect',
    resourceId: null,
    metadata: { host, port: effectivePort, username: effectiveUsername, authType: auth.type, via, ...(personalHostId ? { personalHostId } : {}) },
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

  // Connect to the IP resolved at ticket-creation time — never re-resolved —
  // so there's no DNS-rebinding window between the target-guard check and
  // the actual connection. `host` (the original hostname) is kept separately
  // by callers for display / Server matching.
  const connect = {
    host: payload.resolvedIp || payload.host,
    port: payload.port,
    expectedFingerprint: payload.expectedHostKey || undefined,
  };

  if (payload.auth.type === 'password') {
    connect.username = payload.username;
    connect.password = payload.auth.password;
  } else if (payload.auth.type === 'key') {
    connect.username = payload.username;
    connect.privateKey = payload.auth.privateKey;
    connect.passphrase = payload.auth.passphrase || undefined;
    if (payload.auth.password) connect.password = payload.auth.password;
  } else if (payload.auth.type === 'credential') {
    const cred = await findUsableCredential(orgId, userId, payload.auth.credentialId, { includeKey: true });
    if (!cred) throw new ApiError(404, 'The identity used for this Quick Connect no longer exists');
    const opts = resolveCredentialAuth(cred);
    connect.username = payload.username || cred.username;
    if (opts.password) connect.password = opts.password;
    if (opts.privateKey) { connect.privateKey = opts.privateKey; connect.passphrase = opts.passphrase; }
    if (cred.sshKey?.certificate) connect.certificate = cred.sshKey.certificate;
  }

  return {
    ...connect,
    displayHost: payload.host,
    // Exposed so callers (terminalService quick-connect history) can record
    // what kind of auth was used without re-parsing the (already consumed,
    // single-use) ticket payload themselves.
    authType: payload.auth.type,
    credentialId: payload.auth.type === 'credential' ? payload.auth.credentialId : null,
    // Raw ticket auth + the original (unresolved) host, for terminalHub's
    // "Duplicate" flow ONLY — it keeps this encrypted in memory (never
    // persisted, never logged) so a follow-on createTicketFromSpec() call
    // can re-mint a single-use ticket without ever re-touching the DB/redis
    // for the original secret. Callers other than terminalHub must not
    // retain this.
    rawAuth: payload.auth,
    expectedHostKey: payload.expectedHostKey || null,
    via: payload.via || 'quick_connect',
    personalHostId: payload.personalHostId || null,
  };
}

/**
 * Mint a fresh single-use ticket from connection details already known to
 * the caller (terminalHub's "Duplicate" flow, reconstructed from a live
 * session's stored connectSpec). Thin wrapper around createTicket() so every
 * guard (permissions, target validation, prod/DENY guards) re-runs exactly as it
 * would for a brand-new Quick Connect.
 */
export async function createTicketFromSpec(orgId, user, { host, port, username, auth, expectedHostKey, via, personalHostId }) {
  if (via === 'personal_host') {
    // The host must still exist and still be the caller's.
    const owned = await prisma.personalHost.findFirst({ where: { id: personalHostId || '', orgId, ownerId: user.id }, select: { id: true } });
    if (!owned) throw new ApiError(409, 'This host is no longer in My hosts', { code: 'CANNOT_DUPLICATE' });
  }
  return createTicket(orgId, user, { host, port, username, auth, expectedHostKey }, { via, personalHostId });
}

/**
 * A saved (non-prod) server's DENY policies must also apply when someone
 * reaches it through Quick Connect (G6) — otherwise Quick Connect is a way
 * around "this group may never touch that host".
 */
export async function assertNotDeniedHost(orgId, userId, host, resolvedIps = []) {
  const candidates = [host, ...resolvedIps];
  const servers = await prisma.server.findMany({
    where: {
      orgId,
      OR: [{ ipAddress: { in: candidates } }, { hostname: { in: candidates, mode: 'insensitive' } }],
    },
    select: { id: true, hostname: true },
    take: 20,
  });
  for (const server of servers) {
    const result = await policyService.evaluate({ orgId, userId, serverId: server.id });
    if (!result.allowed && result.policyId && /^Denied by policy/.test(result.reason || '')) {
      throw new ApiError(403, `A policy denies you access to ${server.hostname}`, {
        code: 'QUICK_CONNECT_DENIED_BY_POLICY',
        details: { serverId: server.id },
      });
    }
  }
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
  await sshConnect.resolveTarget(host);
  if (!customerId) throw new ApiError(400, 'customerId is required');
  const customer = await prisma.customer.findFirst({ where: { id: customerId, orgId } });
  if (!customer) throw new ApiError(400, 'Customer not found in organization');
  if (!username || !USERNAME_RE.test(username)) throw new ApiError(400, 'username is required and must be valid');
  if (!identity || !identity.mode) throw new ApiError(400, 'identity is required');

  const isIp = net.isIP(host) !== 0;

  if (identity.mode === 'new' && identity.name) {
    const clash = await prisma.credential.findFirst({ where: { orgId, ownerId: null, name: identity.name }, select: { id: true } });
    if (clash) throw new ApiError(409, `An identity named "${identity.name}" already exists`);
  }

  const result = await prisma.$transaction(async (tx) => {
    let credentialId = null;
    let authMode = 'certificate';

    if (identity.mode !== 'none' && !has(actor, 'servers.manage_credentials')) {
      throw new ApiError(403, "You don't have permission to bind identities to servers", { code: 'PERMISSION_DENIED' });
    }
    if (identity.mode === 'existing') {
      if (!identity.credentialId) throw new ApiError(400, 'identity.credentialId is required for mode "existing"');
      // Org identities only — a personal identity can never be bound to an org server.
      const cred = await tx.credential.findFirst({ where: { id: identity.credentialId, orgId, ownerId: null } });
      if (!cred) throw new ApiError(404, 'identity.credentialId not found in organization');
      credentialId = cred.id;
      authMode = 'credential';
    } else if (identity.mode === 'new') {
      if (!has(actor, 'keystore.manage')) {
        throw new ApiError(403, "Creating a new identity requires the Manage Keystore permission");
      }
      if (!identity.name) throw new ApiError(400, 'identity.name is required for mode "new"');
      if (!identity.auth || !['password', 'key'].includes(identity.auth.type)) {
        throw new ApiError(400, 'identity.auth.type must be "password" or "key"');
      }

      let sshKeyId = null;
      if (identity.auth.type === 'key') {
        const parsed = await sshKeysUtil.normalizePrivateKey({
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
            // Store the normalised OpenSSH text (same passphrase), never the raw input.
            privateKeyEncrypted: encrypt(parsed.privateKey),
            passphraseEncrypted: identity.auth.passphrase ? encrypt(identity.auth.passphrase) : null,
            fingerprint: parsed.fingerprint,
            originalFormat: parsed.format,
            source: 'imported',
            createdById: actor.id,
          },
        });
        sshKeyId = key.id;
      }

      const hasPassword = !!identity.auth.password;
      const authType =
        identity.auth.type === 'key' ? (hasPassword ? 'key_password' : 'key') : 'password';

      const cred = await tx.credential.create({
        data: {
          orgId,
          name: identity.name,
          username,
          authType,
          passwordEncrypted:
            identity.auth.type === 'password' || hasPassword ? encrypt(identity.auth.password) : null,
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

// ---------------------------------------------------------------------------
// History — per-user "Recent Quick Connects" (no secrets, 7-day retention)
// ---------------------------------------------------------------------------

/**
 * Upsert one row per (user, host, port, username) when a Quick Connect
 * ticket is redeemed by the terminal WebSocket. `connectCount` is only
 * incremented for an actual new session (status 'connected', i.e. the ssh2
 * connection came up and a Session row was created) — a 'failed' call is
 * just a status update on the existing row (or a fresh row with
 * connectCount 0 if this host has never been reached successfully).
 *
 * Never pass secret material here — only ids/metadata.
 */
export async function recordHistory({
  orgId, userId, host, port, username, authType, credentialId, serverId, sessionId, status, error,
}) {
  if (!orgId || !userId || !host || !port || !username || !authType) {
    logger.warn('quickConnectService: recordHistory called with missing required fields — skipping');
    return null;
  }
  const isNewSession = status === 'connected' && !!sessionId;
  const lastError = status === 'failed' ? (error ? String(error).slice(0, 500) : null) : null;
  const now = new Date();

  try {
    return await prisma.quickConnectHistory.upsert({
      where: { userId_host_port_username: { userId, host, port, username } },
      create: {
        orgId,
        userId,
        host,
        port,
        username,
        authType,
        credentialId: credentialId || null,
        serverId: serverId || null,
        lastSessionId: sessionId || null,
        lastStatus: status || 'connected',
        lastError,
        connectCount: isNewSession ? 1 : 0,
        lastConnectedAt: now,
      },
      update: {
        authType,
        credentialId: credentialId || null,
        serverId: serverId || null,
        lastSessionId: sessionId || null,
        lastStatus: status || 'connected',
        lastError,
        lastConnectedAt: now,
        ...(isNewSession ? { connectCount: { increment: 1 } } : {}),
      },
    });
  } catch (err) {
    // History is best-effort — never let a recording failure break a live
    // terminal session.
    logger.warn('quickConnectService: recordHistory failed', { error: err.message });
    return null;
  }
}

export async function listHistory(orgId, userId, { limit = 10 } = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const cutoff = new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const rows = await prisma.quickConnectHistory.findMany({
    where: { orgId, userId, lastConnectedAt: { gte: cutoff } },
    orderBy: { lastConnectedAt: 'desc' },
    take,
  });
  if (rows.length === 0) return [];

  const credentialIds = [...new Set(rows.map((r) => r.credentialId).filter(Boolean))];
  const serverIds = [...new Set(rows.map((r) => r.serverId).filter(Boolean))];

  const [credentials, servers] = await Promise.all([
    credentialIds.length
      ? prisma.credential.findMany({
          where: { id: { in: credentialIds }, orgId, OR: [{ ownerId: null }, { ownerId: userId }] },
          select: { id: true, name: true },
        })
      : [],
    serverIds.length
      ? prisma.server.findMany({
          where: { id: { in: serverIds }, orgId },
          select: { id: true, displayName: true, hostname: true, environment: true },
        })
      : [],
  ]);
  const credentialById = new Map(credentials.map((c) => [c.id, c]));
  const serverById = new Map(servers.map((s) => [s.id, s]));

  return rows.map((r) => ({
    id: r.id,
    host: r.host,
    port: r.port,
    username: r.username,
    authType: r.authType,
    // Gracefully handle a deleted identity/server — just null it out rather
    // than throwing (the reference is a soft link, not an FK).
    credential: r.credentialId ? credentialById.get(r.credentialId) || null : null,
    server: r.serverId ? serverById.get(r.serverId) || null : null,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    connectCount: r.connectCount,
    lastConnectedAt: r.lastConnectedAt,
    lastSessionId: r.lastSessionId,
  }));
}

export async function deleteHistory(orgId, userId, id) {
  const row = await prisma.quickConnectHistory.findFirst({ where: { id, orgId, userId } });
  if (!row) throw new ApiError(404, 'Quick Connect history entry not found');
  await prisma.quickConnectHistory.delete({ where: { id } });
  return { id };
}

export async function clearHistory(orgId, userId) {
  const result = await prisma.quickConnectHistory.deleteMany({ where: { orgId, userId } });
  return { count: result.count };
}

/**
 * Re-issue a ticket for a history entry — only possible when the original
 * connection used a stored identity (nothing else is retained). Reuses
 * createTicket() end to end so every existing guard (permissions, target
 * guard, prod/DENY guards) re-runs exactly as it would for a fresh Quick Connect.
 */
export async function reconnectFromHistory(orgId, user, id) {
  const row = await prisma.quickConnectHistory.findFirst({ where: { id, orgId, userId: user.id } });
  if (!row) throw new ApiError(404, 'Quick Connect history entry not found');

  if (row.authType !== 'credential' || !row.credentialId) {
    throw new ApiError(
      409,
      'This Quick Connect used a one-off password or key that was never stored — reconnect from the Quick Connect dialog.',
      { code: 'SECRET_REQUIRED' }
    );
  }

  const cred = await findUsableCredential(orgId, user.id, row.credentialId);
  if (!cred) {
    throw new ApiError(
      409,
      'The identity used for this connection no longer exists — reconnect from the Quick Connect dialog.',
      { code: 'SECRET_REQUIRED' }
    );
  }

  return createTicket(orgId, user, {
    host: row.host,
    port: row.port,
    username: row.username,
    auth: { type: 'credential', credentialId: row.credentialId },
  });
}

export default {
  getSettings,
  updateSettings,
  createTicket,
  createTicketFromSpec,
  consumeTicket,
  saveAsServer,
  assertNotProdHost,
  recordHistory,
  listHistory,
  deleteHistory,
  clearHistory,
  reconnectFromHistory,
};
