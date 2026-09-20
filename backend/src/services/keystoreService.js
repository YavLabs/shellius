/**
 * keystoreService.js
 *
 * CRUD + generate/import/export for stored SSH keys (SshKey) and reusable
 * identities (Credential — "Identity" in the UI). See
 * docs/keystore-and-quick-connect.md for the full contract.
 *
 * Security: DTOs returned to callers NEVER include secret material — only
 * derived metadata (hasPassphrase / hasPassword, public key, fingerprint).
 * Secrets are decrypted only for export (admin, audited) or connect/deploy.
 *
 * Scope (docs/personal-vault.md): ownerId null = organization Keystore,
 * ownerId set = that user's personal vault. Every function takes an
 * `ownerId` (default null) and only ever touches rows of that scope, so a
 * personal item is invisible from the org views and from other users.
 * Personal identities only use the owner's personal keys; org identities
 * only org keys.
 */

import crypto from 'crypto';

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import * as sshKeys from '../utils/sshKeys.js';
import * as sshConnect from './sshConnect.js';
import { log as auditLog } from './auditService.js';
import { assertNotProdHost, assertNotDeniedHost } from './quickConnectService.js';
import { isVaultEnabled } from './orgService.js';
import { UNSCOPED, assertServerInScope, serverScopeWhere, relationScopeWhere } from '../lib/scope.js';

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

export const scopeOf = (row) => (row?.ownerId ? 'personal' : 'org');

/** Names are unique per scope: org-wide for org items, per owner for personal ones. */
async function assertNameFree(model, orgId, ownerId, name, excludeId) {
  if (!name) return;
  const clash = await prisma[model].findFirst({
    where: { orgId, ownerId: ownerId || null, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (clash) {
    const what = model === 'sshKey' ? 'A key' : 'An identity';
    throw new ApiError(409, `${what} named "${name}" already exists${ownerId ? ' in your vault' : ''}`);
  }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/** Public summary of a stored certificate — never includes the cert text itself. */
function certificateSummary(certificateText) {
  if (!certificateText) return null;
  try {
    const parsed = sshKeys.parseCertificate(certificateText);
    return {
      type: parsed.type,
      keyId: parsed.keyId,
      principals: parsed.principals,
      validAfter: parsed.validAfter,
      validBefore: parsed.validBefore,
      expired: parsed.expired,
      caFingerprint: parsed.caFingerprint,
    };
  } catch (err) {
    logger.warn('keystoreService: stored certificate failed to parse', { error: err.message });
    return null;
  }
}

export function toSshKeyDTO(key, { createdBy, credentialCount, deploymentCount } = {}) {
  return {
    id: key.id,
    scope: scopeOf(key),
    name: key.name,
    description: key.description ?? null,
    keyType: key.keyType,
    bits: key.bits ?? null,
    publicKey: key.publicKey,
    fingerprint: key.fingerprint,
    comment: key.comment ?? null,
    source: key.source,
    hasPassphrase: !!key.passphraseEncrypted,
    originalFormat: key.originalFormat ?? null,
    certificate: certificateSummary(key.certificate),
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
    lastExportedAt: key.lastExportedAt ?? null,
    createdBy: createdBy ?? null,
    credentialCount: credentialCount ?? 0,
    deploymentCount: deploymentCount ?? 0,
  };
}

export function toCredentialDTO(cred, { sshKey, serverCount, createdBy } = {}) {
  return {
    id: cred.id,
    scope: scopeOf(cred),
    name: cred.name,
    description: cred.description ?? null,
    username: cred.username,
    authType: cred.authType,
    hasPassword: !!cred.passwordEncrypted,
    tags: cred.tags ?? [],
    lastUsedAt: cred.lastUsedAt ?? null,
    createdAt: cred.createdAt,
    updatedAt: cred.updatedAt,
    sshKey: sshKey ?? null,
    serverCount: serverCount ?? 0,
    createdBy: createdBy ?? null,
  };
}

/** Batch-fetch { id, name, email, avatarUrl } for a set of user ids (createdById/deployedById lookups). */
async function loadUsersById(orgId, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { orgId, id: { in: uniq } },
    select: { id: true, name: true, email: true, avatarUrl: true },
  });
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, email: r.email, avatarUrl: r.avatarUrl }]));
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export async function listKeys(orgId, { search, ownerId = null, scope = UNSCOPED } = {}) {
  const where = { orgId, ownerId };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { comment: { contains: search, mode: 'insensitive' } },
      { fingerprint: { contains: search, mode: 'insensitive' } },
    ];
  }
  const keys = await prisma.sshKey.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { credentials: true } } },
  });
  // `_count.deployments` would count deploys to servers this caller cannot
  // see — a number is a disclosure too (customer-scope spec §6.3), and the
  // key detail page already filters the list it belongs to. One groupBy
  // keeps this O(1) queries instead of one count per key.
  const deploymentCounts = new Map();
  if (keys.length > 0) {
    const grouped = await prisma.keyDeployment.groupBy({
      by: ['sshKeyId'],
      where: { orgId, sshKeyId: { in: keys.map((k) => k.id) }, ...relationScopeWhere(scope, 'server') },
      _count: { _all: true },
    });
    for (const row of grouped) deploymentCounts.set(row.sshKeyId, row._count._all);
  }
  const userMap = await loadUsersById(orgId, keys.map((k) => k.createdById));
  return {
    keys: keys.map((k) =>
      toSshKeyDTO(k, {
        createdBy: userMap.get(k.createdById) || null,
        credentialCount: k._count.credentials,
        deploymentCount: deploymentCounts.get(k.id) ?? 0,
      })
    ),
  };
}

export async function getKey(orgId, id, { ownerId = null, scope = UNSCOPED } = {}) {
  const key = await prisma.sshKey.findFirst({
    where: { id, orgId, ownerId },
    include: { _count: { select: { credentials: true } } },
  });
  if (!key) throw new ApiError(404, 'Key not found');

  // Scoped, for the same reason as listKeys: the raw relation count includes
  // servers outside this caller's customers.
  const scopedDeploymentCount = await prisma.keyDeployment.count({
    where: { orgId, sshKeyId: id, ...relationScopeWhere(scope, 'server') },
  });

  const [userMap, credentials, deployments, credentialServers, successfulDeployments] = await Promise.all([
    loadUsersById(orgId, [key.createdById]),
    prisma.credential.findMany({
      where: { orgId, sshKeyId: id },
      select: { id: true, name: true, username: true, authType: true },
    }),
    // A key detail page is effectively an inventory listing (spec §4.1 #15) —
    // scope every one of the three server-bearing relations below, and
    // compute serverCount/stats AFTER filtering so totals don't leak.
    prisma.keyDeployment.findMany({
      where: { orgId, sshKeyId: id, ...relationScopeWhere(scope, 'server') },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        server: { select: { id: true, hostname: true, displayName: true, environment: true } },
        sshKey: { select: { id: true, name: true, fingerprint: true } },
      },
    }),
    // Servers reachable through an identity that uses this key (authMode: credential).
    prisma.credential.findMany({
      where: { orgId, sshKeyId: id },
      select: {
        id: true,
        name: true,
        servers: { where: serverScopeWhere(scope), select: { id: true, hostname: true, displayName: true, environment: true } },
      },
    }),
    // Every *successful* deploy/remove/rotate for this key, oldest first — used to
    // derive "currently deployed on" (latest success per server whose action isn't 'remove').
    prisma.keyDeployment.findMany({
      where: { orgId, sshKeyId: id, status: 'success', ...relationScopeWhere(scope, 'server') },
      orderBy: { createdAt: 'asc' },
      select: {
        serverId: true,
        action: true,
        server: { select: { id: true, hostname: true, displayName: true, environment: true } },
      },
    }),
  ]);

  const deployedByMap = await loadUsersById(orgId, deployments.map((d) => d.deployedById));

  // Dedupe servers reached "via identity" (a server could theoretically be linked
  // through more than one identity using this key — keep the first).
  const serverMap = new Map();
  for (const cred of credentialServers) {
    for (const s of cred.servers) {
      if (!serverMap.has(s.id)) {
        serverMap.set(s.id, {
          id: s.id,
          hostname: s.hostname,
          displayName: s.displayName,
          environment: s.environment,
          via: 'identity',
          credential: { id: cred.id, name: cred.name },
        });
      }
    }
  }

  // Latest successful deployment per server (ascending order means the last
  // write for a given serverId wins).
  const latestByServer = new Map();
  for (const d of successfulDeployments) latestByServer.set(d.serverId, d);
  for (const d of latestByServer.values()) {
    if (d.action === 'remove') continue; // key was removed and never redeployed
    if (!serverMap.has(d.serverId) && d.server) {
      serverMap.set(d.serverId, {
        id: d.server.id,
        hostname: d.server.hostname,
        displayName: d.server.displayName,
        environment: d.server.environment,
        via: 'deployment',
        credential: null,
      });
    }
  }

  const servers = [...serverMap.values()];

  return {
    key: { ...toSshKeyDTO(key, {
      createdBy: userMap.get(key.createdById) || null,
      credentialCount: key._count.credentials,
      deploymentCount: scopedDeploymentCount,
    }), certificateText: key.certificate ?? null },
    credentials,
    deployments: deployments.map((d) => toKeyDeploymentDTO(d, deployedByMap)),
    servers,
    stats: {
      identityCount: key._count.credentials,
      serverCount: servers.length,
      deploymentCount: scopedDeploymentCount,
    },
  };
}

/**
 * Parse/validate a private key (and optional public key / certificate)
 * without storing anything. Manager+ only — used by the import wizard to
 * preview format/passphrase requirements before submitting.
 */
export async function inspectKey({ privateKey, passphrase }) {
  const parsed = await sshKeys.normalizePrivateKey({ privateKey, passphrase });
  return {
    format: parsed.format,
    encrypted: parsed.encrypted,
    keyType: parsed.keyType,
    bits: parsed.bits,
    fingerprint: parsed.fingerprint,
    publicKey: parsed.publicKey,
    comment: parsed.comment,
  };
}

/** Validate an optional certificate against a just-normalised private key; returns the cert text or null. */
function validateCertificateForKey(certificate, parsed) {
  if (!certificate) return null;
  const certInfo = sshKeys.parseCertificate(certificate); // throws CERT_INVALID
  if (certInfo.publicKeyFingerprint !== parsed.fingerprint) {
    throw new ApiError(400, 'This certificate does not certify the supplied key', {
      code: 'CERT_KEY_MISMATCH',
    });
  }
  return certificate;
}

export async function generateKey(orgId, { name, description, keyType, bits, comment, passphrase }, createdById, { ownerId = null } = {}) {
  if (!name) throw new ApiError(400, 'name is required');
  await assertNameFree('sshKey', orgId, ownerId, name);

  const generated = await sshKeys.generateKeyPair({ keyType, bits, comment, passphrase });

  let privateKeyBuf = Buffer.from(generated.privateKey, 'utf8');
  try {
    const data = {
      orgId,
      name,
      description: description || null,
      keyType: generated.keyType,
      bits: generated.bits,
      publicKey: generated.publicKey,
      privateKeyEncrypted: encrypt(generated.privateKey),
      passphraseEncrypted: passphrase ? encrypt(passphrase) : null,
      fingerprint: generated.fingerprint,
      comment: generated.comment || null,
      source: 'generated',
      originalFormat: 'openssh',
      createdById: createdById || null,
      ownerId,
    };

    const key = await createSshKeyRow(data);

    await auditLog({
      orgId,
      actorId: createdById,
      action: 'keystore.key.generate',
      resourceType: 'SshKey',
      resourceId: key.id,
      metadata: { name: key.name, keyType: key.keyType, fingerprint: key.fingerprint, scope: scopeOf(key) },
    });

    return { key: toSshKeyDTO(key, { credentialCount: 0, deploymentCount: 0 }) };
  } finally {
    privateKeyBuf.fill(0);
    privateKeyBuf = null;
  }
}

export async function importKey(orgId, { name, description, privateKey, passphrase, publicKey, certificate }, createdById, { ownerId = null } = {}) {
  if (!name) throw new ApiError(400, 'name is required');
  await assertNameFree('sshKey', orgId, ownerId, name);

  const parsed = await sshKeys.normalizePrivateKey({ privateKey, passphrase });

  if (publicKey && !sshKeys.publicKeyMatches(parsed, publicKey)) {
    throw new ApiError(400, 'The supplied public key does not match the private key', {
      code: 'KEY_PUBLIC_MISMATCH',
    });
  }
  const certificateToStore = validateCertificateForKey(certificate, parsed);

  const data = {
    orgId,
    name,
    description: description || null,
    keyType: parsed.keyType,
    bits: parsed.bits,
    publicKey: parsed.publicKey,
    privateKeyEncrypted: encrypt(parsed.privateKey),
    passphraseEncrypted: passphrase ? encrypt(passphrase) : null,
    fingerprint: parsed.fingerprint,
    comment: parsed.comment || null,
    source: 'imported',
    originalFormat: parsed.format,
    certificate: certificateToStore,
    createdById: createdById || null,
    ownerId,
  };

  const key = await createSshKeyRow(data);

  await auditLog({
    orgId,
    actorId: createdById,
    action: 'keystore.key.import',
    resourceType: 'SshKey',
    resourceId: key.id,
    metadata: { name: key.name, keyType: key.keyType, fingerprint: key.fingerprint, originalFormat: key.originalFormat, scope: scopeOf(key) },
  });

  return { key: toSshKeyDTO(key, { credentialCount: 0, deploymentCount: 0 }) };
}

async function createSshKeyRow(data) {
  try {
    return await prisma.sshKey.create({ data });
  } catch (err) {
    if (err.code === 'P2002') {
      throw new ApiError(409, `A key named "${data.name}" already exists`);
    }
    throw err;
  }
}

export async function updateKey(orgId, id, { name, description, comment, certificate }, { ownerId = null } = {}) {
  const existing = await prisma.sshKey.findFirst({ where: { id, orgId, ownerId } });
  if (!existing) throw new ApiError(404, 'Key not found');
  if (name !== undefined && name !== existing.name) await assertNameFree('sshKey', orgId, ownerId, name, id);

  const data = {};
  if (name !== undefined) data.name = name;
  if (description !== undefined) data.description = description;
  if (comment !== undefined) data.comment = comment;
  if (certificate !== undefined) {
    if (certificate === null) {
      data.certificate = null;
    } else {
      const certInfo = sshKeys.parseCertificate(certificate); // throws CERT_INVALID
      if (certInfo.publicKeyFingerprint !== existing.fingerprint) {
        throw new ApiError(400, 'This certificate does not certify this key', { code: 'CERT_KEY_MISMATCH' });
      }
      data.certificate = certificate;
    }
  }

  let key;
  try {
    key = await prisma.sshKey.update({
      where: { id },
      data,
      include: { _count: { select: { credentials: true, deployments: true } } },
    });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, `A key named "${name}" already exists`);
    throw err;
  }

  const userMap = await loadUsersById(orgId, [key.createdById]);
  return {
    key: toSshKeyDTO(key, {
      createdBy: userMap.get(key.createdById) || null,
      credentialCount: key._count.credentials,
      deploymentCount: key._count.deployments,
    }),
  };
}

export async function deleteKey(orgId, id, { ownerId = null } = {}) {
  const existing = await prisma.sshKey.findFirst({
    where: { id, orgId, ownerId },
    include: { _count: { select: { credentials: true } } },
  });
  if (!existing) throw new ApiError(404, 'Key not found');
  if (existing._count.credentials > 0) {
    throw new ApiError(409, 'This key is referenced by one or more identities', { code: 'KEY_IN_USE' });
  }
  await prisma.sshKey.delete({ where: { id } });
  return { success: true };
}

export async function exportKey(orgId, id, actorId, { ownerId = null } = {}) {
  const key = await prisma.sshKey.findFirst({ where: { id, orgId, ownerId } });
  if (!key) throw new ApiError(404, 'Key not found');

  const privateKey = decrypt(key.privateKeyEncrypted);

  await prisma.sshKey.update({ where: { id }, data: { lastExportedAt: new Date() } });

  await auditLog({
    orgId,
    actorId,
    action: 'keystore.key.export',
    resourceType: 'SshKey',
    resourceId: id,
    metadata: { name: key.name, fingerprint: key.fingerprint, scope: scopeOf(key), severity: ownerId ? 'MEDIUM' : 'HIGH' },
  });

  logger.warn('keystoreService: private key exported', { orgId, keyId: id, actorId });

  return {
    publicKey: key.publicKey,
    privateKey,
    passphraseProtected: !!key.passphraseEncrypted,
    certificate: key.certificate || null,
  };
}

// ---------------------------------------------------------------------------
// Credentials ("Identities")
// ---------------------------------------------------------------------------

const AUTH_TYPES = ['password', 'key', 'key_password'];

async function resolveNewKey(orgId, name, newKey, createdById, ownerId = null) {
  if (!newKey) return null;
  let parsed;
  let privateKeyText;
  let passphrase = newKey.passphrase || null;

  let originalFormat;
  if (newKey.generate) {
    const generated = await sshKeys.generateKeyPair({
      keyType: newKey.keyType,
      bits: newKey.bits,
      passphrase: newKey.passphrase,
      comment: `${name} key`,
    });
    parsed = generated;
    privateKeyText = generated.privateKey;
    originalFormat = 'openssh';
  } else if (newKey.privateKey) {
    parsed = await sshKeys.normalizePrivateKey({ privateKey: newKey.privateKey, passphrase: newKey.passphrase });
    privateKeyText = parsed.privateKey;
    originalFormat = parsed.format;
  } else {
    throw new ApiError(400, 'newKey must be either { generate: true, ... } or { privateKey, passphrase? }');
  }

  let keyName = `${name} key`;
  // Org-scope names aren't unique in the DB (owner NULL) — pick a free one.
  if (await prisma.sshKey.findFirst({ where: { orgId, ownerId, name: keyName }, select: { id: true } })) {
    keyName = `${keyName} (${crypto.randomBytes(3).toString('hex')})`;
  }
  let created;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      created = await prisma.sshKey.create({
        data: {
          orgId,
          name: attempt === 0 ? keyName : `${keyName} (${crypto.randomBytes(3).toString('hex')})`,
          keyType: parsed.keyType,
          bits: parsed.bits,
          publicKey: parsed.publicKey,
          privateKeyEncrypted: encrypt(privateKeyText),
          passphraseEncrypted: passphrase ? encrypt(passphrase) : null,
          fingerprint: parsed.fingerprint,
          comment: parsed.comment || null,
          source: newKey.generate ? 'generated' : 'imported',
          originalFormat,
          createdById: createdById || null,
          ownerId,
        },
      });
      break;
    } catch (err) {
      if (err.code === 'P2002' && attempt < 2) continue;
      throw err;
    }
  }
  return created;
}

export function validateAuthMaterial({ authType, password, sshKeyId, newKey }) {
  if (!AUTH_TYPES.includes(authType)) {
    throw new ApiError(400, `authType must be one of: ${AUTH_TYPES.join(', ')}`);
  }
  const hasKey = !!(sshKeyId || newKey);
  if (authType === 'password' && !password) {
    throw new ApiError(400, 'password is required for authType "password"');
  }
  if (authType === 'key' && !hasKey) {
    throw new ApiError(400, 'sshKeyId or newKey is required for authType "key"');
  }
  if (authType === 'key_password' && (!hasKey || !password)) {
    throw new ApiError(400, 'authType "key_password" requires both a key (sshKeyId/newKey) and a password');
  }
}

export async function listCredentials(orgId, { search, ownerId = null, scope = UNSCOPED } = {}) {
  const where = { orgId, ownerId };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { username: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }
  const creds = await prisma.credential.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      sshKey: { select: { id: true, name: true, fingerprint: true, keyType: true } },
      // Filtered relation count — a scoped caller's serverCount must not
      // include servers they can't see (spec §4.1 #16).
      _count: { select: { servers: { where: serverScopeWhere(scope) } } },
    },
  });
  const userMap = await loadUsersById(orgId, creds.map((c) => c.createdById));
  return {
    credentials: creds.map((c) =>
      toCredentialDTO(c, { sshKey: c.sshKey, serverCount: c._count.servers, createdBy: userMap.get(c.createdById) || null })
    ),
  };
}

export async function getCredential(orgId, id, { ownerId = null, scope = UNSCOPED } = {}) {
  const cred = await prisma.credential.findFirst({
    where: { id, orgId, ownerId },
    include: {
      sshKey: { select: { id: true, name: true, fingerprint: true, keyType: true } },
      // Filtered relation count so the total matches the (also filtered)
      // `servers` list below — never a bigger number than what's shown.
      _count: { select: { servers: { where: serverScopeWhere(scope) } } },
      servers: {
        where: serverScopeWhere(scope),
        select: { id: true, hostname: true, displayName: true, environment: true, ipAddress: true },
      },
    },
  });
  if (!cred) throw new ApiError(404, 'Identity not found');
  const userMap = await loadUsersById(orgId, [cred.createdById]);
  return {
    credential: toCredentialDTO(cred, {
      sshKey: cred.sshKey,
      serverCount: cred._count.servers,
      createdBy: userMap.get(cred.createdById) || null,
    }),
    servers: cred.servers,
  };
}

export async function createCredential(
  orgId,
  { name, description, username, authType, password, sshKeyId, newKey, tags },
  createdById,
  { ownerId = null } = {}
) {
  if (!name) throw new ApiError(400, 'name is required');
  if (!username) throw new ApiError(400, 'username is required');
  validateAuthMaterial({ authType, password, sshKeyId, newKey });
  await assertNameFree('credential', orgId, ownerId, name);

  let resolvedSshKeyId = sshKeyId || null;
  if (sshKeyId && !newKey) {
    // Same scope only: personal identities use the owner's keys, org identities org keys.
    const key = await prisma.sshKey.findFirst({ where: { id: sshKeyId, orgId, ownerId } });
    if (!key) throw new ApiError(400, ownerId ? 'sshKeyId not found in your vault' : 'sshKeyId not found in organization');
  }
  if (newKey) {
    const created = await resolveNewKey(orgId, name, newKey, createdById, ownerId);
    resolvedSshKeyId = created.id;
  }

  const data = {
    orgId,
    name,
    description: description || null,
    username,
    authType,
    passwordEncrypted: password ? encrypt(password) : null,
    sshKeyId: resolvedSshKeyId,
    tags: tags || [],
    createdById: createdById || null,
    ownerId,
  };

  let cred;
  try {
    cred = await prisma.credential.create({
      data,
      include: { sshKey: { select: { id: true, name: true, fingerprint: true, keyType: true } } },
    });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, `An identity named "${name}" already exists`);
    throw err;
  }

  await auditLog({
    orgId,
    actorId: createdById,
    action: 'keystore.credential.create',
    resourceType: 'Credential',
    resourceId: cred.id,
    metadata: { name: cred.name, username: cred.username, authType: cred.authType, scope: scopeOf(cred) },
  });

  return { credential: toCredentialDTO(cred, { sshKey: cred.sshKey, serverCount: 0 }) };
}

export async function updateCredential(
  orgId,
  id,
  { name, description, username, authType, password, clearPassword, sshKeyId, newKey, tags },
  actorId,
  { ownerId = null } = {}
) {
  const existing = await prisma.credential.findFirst({ where: { id, orgId, ownerId } });
  if (!existing) throw new ApiError(404, 'Identity not found');
  if (name !== undefined && name !== existing.name) await assertNameFree('credential', orgId, ownerId, name, id);

  const effectiveAuthType = authType || existing.authType;
  const effectiveSshKeyId = newKey ? 'PENDING' : sshKeyId !== undefined ? sshKeyId : existing.sshKeyId;
  const willHavePassword = clearPassword ? false : password ? true : !!existing.passwordEncrypted;
  validateAuthMaterial({
    authType: effectiveAuthType,
    password: willHavePassword ? 'x' : null,
    sshKeyId: effectiveSshKeyId,
    newKey,
  });

  const data = {};
  if (name !== undefined) data.name = name;
  if (description !== undefined) data.description = description;
  if (username !== undefined) data.username = username;
  if (authType !== undefined) data.authType = authType;
  if (tags !== undefined) data.tags = tags;

  if (clearPassword) {
    data.passwordEncrypted = null;
  } else if (password) {
    data.passwordEncrypted = encrypt(password);
  }

  if (newKey) {
    const created = await resolveNewKey(orgId, name || existing.name, newKey, actorId, ownerId);
    data.sshKeyId = created.id;
  } else if (sshKeyId !== undefined) {
    if (sshKeyId) {
      const key = await prisma.sshKey.findFirst({ where: { id: sshKeyId, orgId, ownerId } });
      if (!key) throw new ApiError(400, ownerId ? 'sshKeyId not found in your vault' : 'sshKeyId not found in organization');
    }
    data.sshKeyId = sshKeyId || null;
  }

  let cred;
  try {
    cred = await prisma.credential.update({
      where: { id },
      data,
      include: {
        sshKey: { select: { id: true, name: true, fingerprint: true, keyType: true } },
        _count: { select: { servers: true } },
      },
    });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, `An identity named "${data.name}" already exists`);
    throw err;
  }

  await auditLog({
    orgId,
    actorId,
    action: 'keystore.credential.update',
    resourceType: 'Credential',
    resourceId: cred.id,
    metadata: { name: cred.name, scope: scopeOf(cred) },
  });

  return { credential: toCredentialDTO(cred, { sshKey: cred.sshKey, serverCount: cred._count.servers }) };
}

export async function deleteCredential(orgId, id, { force = false, ownerId = null } = {}, actorId) {
  const existing = await prisma.credential.findFirst({
    where: { id, orgId, ownerId },
    include: { _count: { select: { servers: true } } },
  });
  if (!existing) throw new ApiError(404, 'Identity not found');

  if (existing._count.servers > 0 && !force) {
    throw new ApiError(409, 'This identity is assigned to one or more servers', { code: 'CREDENTIAL_IN_USE' });
  }

  if (existing._count.servers > 0 && force) {
    // Detach servers and flip them back to certificate auth mode.
    await prisma.server.updateMany({
      where: { orgId, credentialId: id },
      data: { credentialId: null, authMode: 'certificate' },
    });
  }

  await prisma.credential.delete({ where: { id } });

  await auditLog({
    orgId,
    actorId,
    action: 'keystore.credential.delete',
    resourceType: 'Credential',
    resourceId: id,
    metadata: { name: existing.name, forced: !!force, scope: scopeOf(existing) },
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// Move personal → organization (one-way, audited). The route checks the
// caller owns the item AND holds keystore.manage.
// ---------------------------------------------------------------------------

export async function moveKeyToOrg(orgId, id, ownerId) {
  const key = await prisma.sshKey.findFirst({
    where: { id, orgId, ownerId },
    include: { _count: { select: { credentials: true } } },
  });
  if (!key) throw new ApiError(404, 'Key not found');
  if (key._count.credentials > 0) {
    throw new ApiError(
      409,
      'Personal identities use this key — move those identities instead (their key moves with them) or switch them to another key first',
      { code: 'KEY_IN_USE' }
    );
  }
  await assertNameFree('sshKey', orgId, null, key.name);
  const moved = await prisma.sshKey.update({ where: { id }, data: { ownerId: null } });
  await auditLog({
    orgId,
    actorId: ownerId,
    action: 'keystore.key.move_to_org',
    resourceType: 'SshKey',
    resourceId: id,
    metadata: { name: key.name, fingerprint: key.fingerprint },
  });
  return { key: toSshKeyDTO(moved, { credentialCount: 0, deploymentCount: 0 }) };
}

export async function moveCredentialToOrg(orgId, id, ownerId) {
  const cred = await prisma.credential.findFirst({
    where: { id, orgId, ownerId },
    include: { sshKey: { include: { _count: { select: { credentials: true } } } } },
  });
  if (!cred) throw new ApiError(404, 'Identity not found');
  // The key moves with the identity — unless another personal identity uses
  // it, which would leave that identity pointing at an org key.
  if (cred.sshKey && cred.sshKey._count.credentials > 1) {
    throw new ApiError(
      409,
      `Other identities in your vault also use the key "${cred.sshKey.name}" — give this identity its own key first`,
      { code: 'KEY_SHARED' }
    );
  }
  await assertNameFree('credential', orgId, null, cred.name);
  if (cred.sshKey) await assertNameFree('sshKey', orgId, null, cred.sshKey.name);

  const moved = await prisma.$transaction(async (tx) => {
    if (cred.sshKey) await tx.sshKey.update({ where: { id: cred.sshKey.id }, data: { ownerId: null } });
    return tx.credential.update({
      where: { id },
      data: { ownerId: null },
      include: { sshKey: { select: { id: true, name: true, fingerprint: true, keyType: true } } },
    });
  });
  await auditLog({
    orgId,
    actorId: ownerId,
    action: 'keystore.credential.move_to_org',
    resourceType: 'Credential',
    resourceId: id,
    metadata: { name: cred.name, username: cred.username, keyMoved: cred.sshKey ? cred.sshKey.id : null },
  });
  return { credential: toCredentialDTO(moved, { sshKey: moved.sshKey, serverCount: 0 }) };
}

/**
 * Decrypt a Credential's auth material into ssh2 connect() options.
 * (Distinct from sshConnect.resolveServerAuth, which reads via a Server row.)
 */
export function resolveCredentialAuth(credential) {
  const opts = { username: credential.username };
  if (credential.passwordEncrypted && (credential.authType === 'password' || credential.authType === 'key_password')) {
    opts.password = decrypt(credential.passwordEncrypted);
  }
  if (credential.sshKey && (credential.authType === 'key' || credential.authType === 'key_password')) {
    opts.privateKey = decrypt(credential.sshKey.privateKeyEncrypted);
    if (credential.sshKey.passphraseEncrypted) {
      opts.passphrase = decrypt(credential.sshKey.passphraseEncrypted);
    }
    if (credential.sshKey.certificate) {
      opts.certificate = credential.sshKey.certificate;
    }
  }
  return opts;
}

/**
 * Load a stored identity the caller may use, and decrypt it for an SSH
 * connection. Scope rules mirror Quick Connect: an org identity needs
 * `keystore.view`, one of the caller's own personal identities needs the
 * vault switch plus `vault.use`, and somebody else's personal identity is a
 * 404 (never a 403 — its existence is not disclosed).
 *
 * @param {object} actor - req.user ({ userId, permissions })
 * @returns {Promise<{credential: object, auth: object}>} auth is an ssh2
 *   connect fragment: { username, password?, privateKey?, passphrase? }
 */
export async function resolveCredentialForActor(orgId, actor, credentialId) {
  const credential = await prisma.credential.findFirst({
    where: { id: credentialId, orgId, OR: [{ ownerId: null }, { ownerId: actor.userId }] },
    include: { sshKey: true },
  });
  if (!credential) throw new ApiError(404, 'Identity not found');

  const holds = (key) => {
    const p = actor?.permissions;
    if (!p) return false;
    return p instanceof Set ? p.has(key) : p.includes(key);
  };

  if (credential.ownerId) {
    if (!(await isVaultEnabled(orgId))) {
      throw new ApiError(403, 'The personal vault is turned off for this organization', { code: 'VAULT_DISABLED' });
    }
    if (!holds('vault.use')) {
      throw new ApiError(403, 'Your role does not permit using your personal vault', {
        code: 'PERMISSION_DENIED',
        details: { missing: ['vault.use'] },
      });
    }
  } else if (!holds('keystore.view')) {
    throw new ApiError(403, 'Your role does not permit using stored identities', {
      code: 'PERMISSION_DENIED',
      details: { missing: ['keystore.view'] },
    });
  }

  return { credential, auth: resolveCredentialAuth(credential) };
}

export async function testCredential(orgId, id, { serverId, host, port }, actorId, { ownerId = null, scope = UNSCOPED } = {}) {
  const cred = await prisma.credential.findFirst({
    where: { id, orgId, ownerId },
    include: { sshKey: true },
  });
  if (!cred) throw new ApiError(404, 'Identity not found');
  if (ownerId && serverId) {
    throw new ApiError(400, 'Personal identities can only be tested against a host, not a saved server');
  }

  let targetHost = host;
  let targetPort = port || 22;
  let server = null;
  if (serverId) {
    server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
    if (!server) throw new ApiError(404, 'Server not found');
    // Testing a credential sends the stored secret to the target — same
    // guard as a real connect, not just a read.
    assertServerInScope(scope, server);
    targetHost = server.ipAddress || server.hostname;
    targetPort = server.port || 22;
  }
  if (!targetHost) throw new ApiError(400, 'Provide serverId or host');

  // Ad-hoc {host} tests (no serverId) go through the same target guard as
  // Quick Connect — a saved server was already vetted when it was created.
  let connectHost = targetHost;
  if (!server) {
    const resolved = await sshConnect.resolveTarget(targetHost);
    connectHost = resolved.ip;
    // A stored secret sent to a prod server (or one a DENY policy keeps
    // you from) is a login without an approval — same guards as Quick Connect.
    await assertNotProdHost(orgId, targetHost, resolved.addresses);
    await assertNotDeniedHost(orgId, actorId, targetHost, resolved.addresses);
  }

  const start = Date.now();
  const authOpts = resolveCredentialAuth(cred);
  let hostKeyInfo = null;

  try {
    const { client } = await sshConnect.connectSsh({
      host: connectHost,
      port: targetPort,
      ...authOpts,
      readyTimeout: 10000,
      onHostKey: (hk) => { hostKeyInfo = hk; },
    });
    try { client.end(); } catch { /* ignore */ }

    const durationMs = Date.now() - start;

    if (server && !server.hostKeyFingerprint && hostKeyInfo) {
      // TOFU — pin only when nothing is pinned yet; never overwrite here.
      await prisma.server.update({
        where: { id: server.id },
        data: {
          hostKeyFingerprint: hostKeyInfo.fingerprint,
          hostKeyAlgorithm: hostKeyInfo.algorithm,
          hostKeyPinnedAt: new Date(),
        },
      }).catch(() => {});
    }

    await prisma.credential.update({ where: { id }, data: { lastUsedAt: new Date() } }).catch(() => {});

    await auditLog({
      orgId,
      actorId,
      action: 'keystore.credential.test',
      resourceType: 'Credential',
      resourceId: id,
      metadata: { serverId: serverId || null, host: targetHost, port: targetPort, ok: true },
    });

    return {
      ok: true,
      message: 'Connected successfully',
      hostKeyFingerprint: hostKeyInfo?.fingerprint || null,
      hostKeyAlgorithm: hostKeyInfo?.algorithm || null,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    await auditLog({
      orgId,
      actorId,
      action: 'keystore.credential.test',
      resourceType: 'Credential',
      resourceId: id,
      metadata: { serverId: serverId || null, host: targetHost, port: targetPort, ok: false, error: err.message },
    });
    return {
      ok: false,
      message: err.message || 'Connection failed',
      hostKeyFingerprint: hostKeyInfo?.fingerprint || null,
      hostKeyAlgorithm: hostKeyInfo?.algorithm || null,
      durationMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Shared: KeyDeployment DTO (used here for getKey(), and by keyDeploymentService)
// ---------------------------------------------------------------------------

export function toKeyDeploymentDTO(dep, deployedByMap = new Map()) {
  return {
    id: dep.id,
    batchId: dep.batchId,
    action: dep.action,
    status: dep.status,
    targetUser: dep.targetUser,
    authMode: dep.authMode,
    error: dep.error ?? null,
    output: dep.output ?? null,
    startedAt: dep.startedAt ?? null,
    finishedAt: dep.finishedAt ?? null,
    createdAt: dep.createdAt,
    server: dep.server || null,
    sshKey: dep.sshKey || null,
    deployedBy: dep.deployedById ? deployedByMap.get(dep.deployedById) || null : null,
  };
}

export default {
  listKeys,
  getKey,
  inspectKey,
  generateKey,
  importKey,
  updateKey,
  deleteKey,
  exportKey,
  listCredentials,
  getCredential,
  createCredential,
  updateCredential,
  deleteCredential,
  resolveCredentialAuth,
  resolveCredentialForActor,
  validateAuthMaterial,
  testCredential,
  moveKeyToOrg,
  moveCredentialToOrg,
  scopeOf,
  toKeyDeploymentDTO,
  toSshKeyDTO,
  toCredentialDTO,
};
