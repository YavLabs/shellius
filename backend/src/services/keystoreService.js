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
 */

import crypto from 'crypto';

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import * as sshKeys from '../utils/sshKeys.js';
import * as sshConnect from './sshConnect.js';
import { log as auditLog } from './auditService.js';

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

export function toCredentialDTO(cred, { sshKey, serverCount } = {}) {
  return {
    id: cred.id,
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
  };
}

/** Batch-fetch { id, name } for a set of user ids (createdById lookups). */
async function loadUsersById(orgId, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { orgId, id: { in: uniq } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name }]));
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export async function listKeys(orgId, { search } = {}) {
  const where = { orgId };
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
    include: { _count: { select: { credentials: true, deployments: true } } },
  });
  const userMap = await loadUsersById(orgId, keys.map((k) => k.createdById));
  return {
    keys: keys.map((k) =>
      toSshKeyDTO(k, {
        createdBy: userMap.get(k.createdById) || null,
        credentialCount: k._count.credentials,
        deploymentCount: k._count.deployments,
      })
    ),
  };
}

export async function getKey(orgId, id) {
  const key = await prisma.sshKey.findFirst({
    where: { id, orgId },
    include: { _count: { select: { credentials: true, deployments: true } } },
  });
  if (!key) throw new ApiError(404, 'Key not found');

  const [userMap, credentials, deployments] = await Promise.all([
    loadUsersById(orgId, [key.createdById]),
    prisma.credential.findMany({
      where: { orgId, sshKeyId: id },
      select: { id: true, name: true, username: true },
    }),
    prisma.keyDeployment.findMany({
      where: { orgId, sshKeyId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        server: { select: { id: true, hostname: true, displayName: true, environment: true } },
        sshKey: { select: { id: true, name: true, fingerprint: true } },
      },
    }),
  ]);

  const deployedByMap = await loadUsersById(orgId, deployments.map((d) => d.deployedById));

  return {
    key: { ...toSshKeyDTO(key, {
      createdBy: userMap.get(key.createdById) || null,
      credentialCount: key._count.credentials,
      deploymentCount: key._count.deployments,
    }), certificateText: key.certificate ?? null },
    credentials,
    deployments: deployments.map((d) => toKeyDeploymentDTO(d, deployedByMap)),
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

export async function generateKey(orgId, { name, description, keyType, bits, comment, passphrase }, createdById) {
  if (!name) throw new ApiError(400, 'name is required');

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
    };

    const key = await createSshKeyRow(data);

    await auditLog({
      orgId,
      actorId: createdById,
      action: 'keystore.key.generate',
      resourceType: 'SshKey',
      resourceId: key.id,
      metadata: { name: key.name, keyType: key.keyType, fingerprint: key.fingerprint },
    });

    return { key: toSshKeyDTO(key, { credentialCount: 0, deploymentCount: 0 }) };
  } finally {
    privateKeyBuf.fill(0);
    privateKeyBuf = null;
  }
}

export async function importKey(orgId, { name, description, privateKey, passphrase, publicKey, certificate }, createdById) {
  if (!name) throw new ApiError(400, 'name is required');

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
  };

  const key = await createSshKeyRow(data);

  await auditLog({
    orgId,
    actorId: createdById,
    action: 'keystore.key.import',
    resourceType: 'SshKey',
    resourceId: key.id,
    metadata: { name: key.name, keyType: key.keyType, fingerprint: key.fingerprint, originalFormat: key.originalFormat },
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

export async function updateKey(orgId, id, { name, description, comment, certificate }) {
  const existing = await prisma.sshKey.findFirst({ where: { id, orgId } });
  if (!existing) throw new ApiError(404, 'Key not found');

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

export async function deleteKey(orgId, id) {
  const existing = await prisma.sshKey.findFirst({
    where: { id, orgId },
    include: { _count: { select: { credentials: true } } },
  });
  if (!existing) throw new ApiError(404, 'Key not found');
  if (existing._count.credentials > 0) {
    throw new ApiError(409, 'This key is referenced by one or more identities', { code: 'KEY_IN_USE' });
  }
  await prisma.sshKey.delete({ where: { id } });
  return { success: true };
}

export async function exportKey(orgId, id, actorId) {
  const key = await prisma.sshKey.findFirst({ where: { id, orgId } });
  if (!key) throw new ApiError(404, 'Key not found');

  const privateKey = decrypt(key.privateKeyEncrypted);

  await prisma.sshKey.update({ where: { id }, data: { lastExportedAt: new Date() } });

  await auditLog({
    orgId,
    actorId,
    action: 'keystore.key.export',
    resourceType: 'SshKey',
    resourceId: id,
    metadata: { name: key.name, fingerprint: key.fingerprint, severity: 'HIGH' },
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

async function resolveNewKey(orgId, name, newKey, createdById) {
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

export async function listCredentials(orgId, { search } = {}) {
  const where = { orgId };
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
      _count: { select: { servers: true } },
    },
  });
  return {
    credentials: creds.map((c) => toCredentialDTO(c, { sshKey: c.sshKey, serverCount: c._count.servers })),
  };
}

export async function getCredential(orgId, id) {
  const cred = await prisma.credential.findFirst({
    where: { id, orgId },
    include: {
      sshKey: { select: { id: true, name: true, fingerprint: true, keyType: true } },
      _count: { select: { servers: true } },
      servers: {
        select: { id: true, hostname: true, displayName: true, environment: true, ipAddress: true },
      },
    },
  });
  if (!cred) throw new ApiError(404, 'Identity not found');
  return {
    credential: toCredentialDTO(cred, { sshKey: cred.sshKey, serverCount: cred._count.servers }),
    servers: cred.servers,
  };
}

export async function createCredential(
  orgId,
  { name, description, username, authType, password, sshKeyId, newKey, tags },
  createdById
) {
  if (!name) throw new ApiError(400, 'name is required');
  if (!username) throw new ApiError(400, 'username is required');
  validateAuthMaterial({ authType, password, sshKeyId, newKey });

  let resolvedSshKeyId = sshKeyId || null;
  if (newKey) {
    const created = await resolveNewKey(orgId, name, newKey, createdById);
    resolvedSshKeyId = created.id;
  } else if (sshKeyId) {
    const key = await prisma.sshKey.findFirst({ where: { id: sshKeyId, orgId } });
    if (!key) throw new ApiError(400, 'sshKeyId not found in organization');
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
    metadata: { name: cred.name, username: cred.username, authType: cred.authType },
  });

  return { credential: toCredentialDTO(cred, { sshKey: cred.sshKey, serverCount: 0 }) };
}

export async function updateCredential(
  orgId,
  id,
  { name, description, username, authType, password, clearPassword, sshKeyId, newKey, tags },
  actorId
) {
  const existing = await prisma.credential.findFirst({ where: { id, orgId } });
  if (!existing) throw new ApiError(404, 'Identity not found');

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
    const created = await resolveNewKey(orgId, name || existing.name, newKey, actorId);
    data.sshKeyId = created.id;
  } else if (sshKeyId !== undefined) {
    if (sshKeyId) {
      const key = await prisma.sshKey.findFirst({ where: { id: sshKeyId, orgId } });
      if (!key) throw new ApiError(400, 'sshKeyId not found in organization');
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
    metadata: { name: cred.name },
  });

  return { credential: toCredentialDTO(cred, { sshKey: cred.sshKey, serverCount: cred._count.servers }) };
}

export async function deleteCredential(orgId, id, { force = false } = {}, actorId) {
  const existing = await prisma.credential.findFirst({
    where: { id, orgId },
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
    metadata: { name: existing.name, forced: !!force },
  });

  return { success: true };
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

export async function testCredential(orgId, id, { serverId, host, port }, actorId) {
  const cred = await prisma.credential.findFirst({
    where: { id, orgId },
    include: { sshKey: true },
  });
  if (!cred) throw new ApiError(404, 'Identity not found');

  let targetHost = host;
  let targetPort = port || 22;
  let server = null;
  if (serverId) {
    server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
    if (!server) throw new ApiError(404, 'Server not found');
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
  validateAuthMaterial,
  testCredential,
  toKeyDeploymentDTO,
  toSshKeyDTO,
  toCredentialDTO,
};
