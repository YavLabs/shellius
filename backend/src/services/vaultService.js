/**
 * vaultService.js — "My hosts": each user's private list of SSH targets.
 * See docs/personal-vault.md.
 *
 * A PersonalHost is NOT a Server: it never enters the inventory, policies,
 * approvals, metrics or search, and only its owner can see it. Connecting
 * goes through quickConnectService.createTicket({ via: 'personal_host' }),
 * so the target guard, the production-host refusal, DENY policies, audit,
 * sessions and recording all behave exactly as for Quick Connect.
 *
 * Every query here is scoped to (orgId, ownerId = caller). Another user's
 * host id is a 404.
 */

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { log as auditLog } from './auditService.js';
import { isVaultEnabled } from './orgService.js';
import * as sshConnect from './sshConnect.js';
import * as keystoreService from './keystoreService.js';
import * as quickConnectService from './quickConnectService.js';

const MAX_HOSTS_PER_USER = 500;

function has(user, key) {
  const p = user?.permissions;
  if (!p) return false;
  return p instanceof Set ? p.has(key) : p.includes(key);
}

const credentialSelect = { id: true, name: true, username: true, authType: true, ownerId: true };

export function toHostDTO(h) {
  return {
    id: h.id,
    name: h.name,
    host: h.host,
    port: h.port,
    username: h.username ?? null,
    description: h.description ?? null,
    tags: h.tags ?? [],
    credential: h.credential
      ? {
          id: h.credential.id,
          name: h.credential.name,
          username: h.credential.username,
          authType: h.credential.authType,
          scope: h.credential.ownerId ? 'personal' : 'org',
        }
      : null,
    hostKeyFingerprint: h.hostKeyFingerprint ?? null,
    hostKeyAlgorithm: h.hostKeyAlgorithm ?? null,
    hostKeyPinnedAt: h.hostKeyPinnedAt ?? null,
    lastConnectedAt: h.lastConnectedAt ?? null,
    lastStatus: h.lastStatus ?? null,
    lastError: h.lastError ?? null,
    connectCount: h.connectCount ?? 0,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

async function assertVaultOn(orgId) {
  if (!(await isVaultEnabled(orgId))) {
    throw new ApiError(403, 'The personal vault is turned off for this organization', { code: 'VAULT_DISABLED' });
  }
}

function denied(missing, message) {
  return new ApiError(403, message, { code: 'PERMISSION_DENIED', details: { missing: [missing] } });
}

/** Callers of every /api/vault/hosts endpoint: switch on + vault.hosts. */
export async function assertCanUseHosts(orgId, user) {
  await assertVaultOn(orgId);
  if (!has(user, 'vault.hosts')) throw denied('vault.hosts', 'Your role does not permit My hosts');
}

/**
 * An identity a personal host may use: the caller's own personal identity
 * (vault.use) or an org identity (quick_connect.use_stored_identity).
 */
async function assertUsableCredential(orgId, user, credentialId) {
  const cred = await prisma.credential.findFirst({
    where: { id: credentialId, orgId, OR: [{ ownerId: null }, { ownerId: user.id }] },
    select: credentialSelect,
  });
  if (!cred) throw new ApiError(400, 'Identity not found');
  if (cred.ownerId && !has(user, 'vault.use')) throw denied('vault.use', 'Your role does not permit your personal vault');
  if (!cred.ownerId && !has(user, 'quick_connect.use_stored_identity')) {
    throw denied('quick_connect.use_stored_identity', 'Your role does not permit using organization identities');
  }
  return cred;
}

/** Target checks at save time — the same ones re-run on every connect. */
async function assertTarget(orgId, user, host) {
  if (!quickConnectService.isValidHost(host)) {
    throw new ApiError(400, 'host must be a valid hostname, IPv4, or IPv6 address');
  }
  const resolved = await sshConnect.resolveTarget(host);
  await quickConnectService.assertNotProdHost(orgId, host, resolved.addresses);
  await quickConnectService.assertNotDeniedHost(orgId, user.id, host, resolved.addresses);
}

function assertUsername(username) {
  if (username && !quickConnectService.USERNAME_RE.test(username)) {
    throw new ApiError(400, 'username must be a valid SSH username');
  }
}

async function loadOwned(orgId, userId, id) {
  const host = await prisma.personalHost.findFirst({
    where: { id, orgId, ownerId: userId },
    include: { credential: { select: credentialSelect } },
  });
  if (!host) throw new ApiError(404, 'Host not found');
  return host;
}

async function assertNameFree(orgId, userId, name, excludeId) {
  const clash = await prisma.personalHost.findFirst({
    where: { orgId, ownerId: userId, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ApiError(409, `You already have a host named "${name}"`);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function getStatus(orgId, user) {
  const enabled = await isVaultEnabled(orgId);
  return {
    enabled,
    canUseVault: enabled && has(user, 'vault.use'),
    canUseHosts: enabled && has(user, 'vault.hosts'),
    canUseOrgIdentities: has(user, 'quick_connect.use_stored_identity'),
  };
}

export async function listHosts(orgId, user) {
  await assertCanUseHosts(orgId, user);
  const hosts = await prisma.personalHost.findMany({
    where: { orgId, ownerId: user.id },
    orderBy: [{ name: 'asc' }],
    include: { credential: { select: credentialSelect } },
  });
  return { hosts: hosts.map(toHostDTO) };
}

/** newIdentity.auth → keystoreService.createCredential body. */
function identityBodyFrom(name, username, auth) {
  if (auth.type === 'password') {
    return { name, username, authType: 'password', password: auth.password };
  }
  return {
    name,
    username,
    authType: auth.password ? 'key_password' : 'key',
    password: auth.password || undefined,
    newKey: { privateKey: auth.privateKey, passphrase: auth.passphrase || undefined },
  };
}

export async function createHost(orgId, user, body) {
  await assertCanUseHosts(orgId, user);
  const { name, host, port = 22, username, credentialId, description, tags, newIdentity } = body;

  const count = await prisma.personalHost.count({ where: { orgId, ownerId: user.id } });
  if (count >= MAX_HOSTS_PER_USER) throw new ApiError(409, `You can keep up to ${MAX_HOSTS_PER_USER} hosts`);

  assertUsername(username);
  if (credentialId && newIdentity) throw new ApiError(400, 'Pass either credentialId or newIdentity, not both');
  if (!username && !credentialId && !newIdentity) {
    throw new ApiError(400, 'username is required when the host has no identity');
  }
  await assertNameFree(orgId, user.id, name);
  await assertTarget(orgId, user, host);
  if (credentialId) await assertUsableCredential(orgId, user, credentialId);

  let linkedCredentialId = credentialId || null;
  let createdCredentialId = null;
  if (newIdentity) {
    if (!has(user, 'vault.use')) throw denied('vault.use', 'Saving an identity needs the Personal vault permission');
    if (!username) throw new ApiError(400, 'username is required to save an identity');
    const { credential } = await keystoreService.createCredential(
      orgId,
      identityBodyFrom(newIdentity.name, username, newIdentity.auth),
      user.id,
      { ownerId: user.id }
    );
    linkedCredentialId = credential.id;
    createdCredentialId = credential.id;
  }

  let row;
  try {
    row = await prisma.personalHost.create({
      data: {
        orgId,
        ownerId: user.id,
        name,
        host,
        port,
        username: username || null,
        credentialId: linkedCredentialId,
        description: description || null,
        tags: tags || [],
      },
      include: { credential: { select: credentialSelect } },
    });
  } catch (err) {
    if (createdCredentialId) {
      await prisma.credential.delete({ where: { id: createdCredentialId } }).catch(() => {});
    }
    if (err.code === 'P2002') throw new ApiError(409, `You already have a host named "${name}"`);
    throw err;
  }

  await auditLog({
    orgId,
    actorId: user.id,
    action: 'vault.host.create',
    resourceType: 'PersonalHost',
    resourceId: row.id,
    metadata: { name, host, port, identity: linkedCredentialId ? (createdCredentialId ? 'new' : 'existing') : 'none' },
  });
  return { host: toHostDTO(row) };
}

export async function updateHost(orgId, user, id, body) {
  await assertCanUseHosts(orgId, user);
  const existing = await loadOwned(orgId, user.id, id);
  const data = {};

  if (body.name !== undefined && body.name !== existing.name) {
    await assertNameFree(orgId, user.id, body.name, id);
    data.name = body.name;
  }
  const hostChanged = body.host !== undefined && body.host !== existing.host;
  if (hostChanged) {
    await assertTarget(orgId, user, body.host);
    data.host = body.host;
  }
  if (body.port !== undefined) data.port = body.port;
  // A different address or port is a different machine: drop the pinned key.
  if (hostChanged || (body.port !== undefined && body.port !== existing.port)) {
    data.hostKeyFingerprint = null;
    data.hostKeyAlgorithm = null;
    data.hostKeyPinnedAt = null;
  }
  if (body.username !== undefined) {
    assertUsername(body.username);
    data.username = body.username || null;
  }
  if (body.credentialId !== undefined) {
    if (body.credentialId && body.credentialId !== existing.credentialId) {
      await assertUsableCredential(orgId, user, body.credentialId);
    }
    data.credentialId = body.credentialId || null;
  }
  if (body.description !== undefined) data.description = body.description || null;
  if (body.tags !== undefined) data.tags = body.tags;

  const nextUsername = data.username !== undefined ? data.username : existing.username;
  const nextCredential = data.credentialId !== undefined ? data.credentialId : existing.credentialId;
  if (!nextUsername && !nextCredential) {
    throw new ApiError(400, 'username is required when the host has no identity');
  }

  let row;
  try {
    row = await prisma.personalHost.update({
      where: { id },
      data,
      include: { credential: { select: credentialSelect } },
    });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, `You already have a host named "${data.name}"`);
    throw err;
  }
  await auditLog({
    orgId,
    actorId: user.id,
    action: 'vault.host.update',
    resourceType: 'PersonalHost',
    resourceId: id,
    metadata: { name: row.name, fields: Object.keys(data) },
  });
  return { host: toHostDTO(row) };
}

export async function deleteHost(orgId, user, id) {
  await assertCanUseHosts(orgId, user);
  const existing = await loadOwned(orgId, user.id, id);
  await prisma.personalHost.delete({ where: { id } });
  await auditLog({
    orgId,
    actorId: user.id,
    action: 'vault.host.delete',
    resourceType: 'PersonalHost',
    resourceId: id,
    metadata: { name: existing.name, host: existing.host },
  });
  return { id };
}

export async function resetHostKey(orgId, user, id) {
  await assertCanUseHosts(orgId, user);
  const existing = await loadOwned(orgId, user.id, id);
  const row = await prisma.personalHost.update({
    where: { id },
    data: { hostKeyFingerprint: null, hostKeyAlgorithm: null, hostKeyPinnedAt: null },
    include: { credential: { select: credentialSelect } },
  });
  await auditLog({
    orgId,
    actorId: user.id,
    action: 'vault.host.reset_host_key',
    resourceType: 'PersonalHost',
    resourceId: id,
    metadata: { name: existing.name, previousFingerprint: existing.hostKeyFingerprint },
  });
  return { host: toHostDTO(row) };
}

/**
 * Mint a single-use terminal ticket for one of the caller's hosts. `auth` is
 * a one-off secret (never stored) for hosts without an identity — or to
 * override the identity for this one connection.
 */
export async function connectHost(orgId, user, id, { auth } = {}) {
  await assertCanUseHosts(orgId, user);
  const host = await loadOwned(orgId, user.id, id);

  let ticketAuth = auth || null;
  if (!ticketAuth) {
    if (!host.credentialId || !host.credential) {
      throw new ApiError(409, 'This host asks for a password or key each time', { code: 'SECRET_REQUIRED' });
    }
    ticketAuth = { type: 'credential', credentialId: host.credentialId };
  }
  const username = host.username || host.credential?.username || null;

  const result = await quickConnectService.createTicket(
    orgId,
    user,
    {
      host: host.host,
      port: host.port,
      username,
      auth: ticketAuth,
      expectedHostKey: host.hostKeyFingerprint || null,
    },
    { via: 'personal_host', personalHostId: host.id }
  );

  await auditLog({
    orgId,
    actorId: user.id,
    action: 'vault.host.connect',
    resourceType: 'PersonalHost',
    resourceId: host.id,
    metadata: { name: host.name, host: host.host, port: host.port, username, authType: ticketAuth.type },
  });
  return result;
}

export default {
  getStatus,
  listHosts,
  createHost,
  updateHost,
  deleteHost,
  resetHostKey,
  connectHost,
  assertCanUseHosts,
  toHostDTO,
};
