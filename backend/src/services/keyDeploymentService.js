/**
 * keyDeploymentService.js
 *
 * Push / remove / rotate an SshKey's public key across one or more servers'
 * authorized_keys. Deployment rows are processed asynchronously by the
 * `key-deployments` BullMQ worker (see jobs/keyDeployment.js) — this module
 * holds both the batch-creation API and the actual per-server work
 * (`processDeployment`), so the worker file stays a thin BullMQ wrapper.
 *
 * Remote script:
 *   - Idempotent: append-if-missing on deploy, filter-out on remove, matched
 *     by exact key body (grep -xF).
 *   - Ownership is implicit: every filesystem operation runs AS the target
 *     user (directly, or via `sudo -u <user>`), so files/dirs end up
 *     correctly owned without an explicit chown.
 *   - The public key is validated against a strict OpenSSH public-key regex
 *     and then embedded as a single, properly shell-quoted literal — never
 *     concatenated unescaped, never placed in a shell variable that gets
 *     re-quoted downstream.
 *   - A sudo password (when needed) is piped over the exec channel's stdin
 *     to `sudo -S` — never placed on the command line, never logged.
 *
 * Batch metadata (useSudo, rotate options) that has no dedicated column on
 * KeyDeployment is kept in Redis under `keydeploy:batch:<batchId>` for the
 * life of the batch (30 days) so retries and the rotate finalize step can
 * read it back without a schema change.
 */

import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import redis from '../config/redis.js';
import { decrypt } from '../utils/crypto.js';
import * as sshKeysUtil from '../utils/sshKeys.js';
import * as sshConnect from './sshConnect.js';
import * as caService from './caService.js';
import { resolveCredentialAuth, toKeyDeploymentDTO } from './keystoreService.js';
import { log as auditLog } from './auditService.js';
import { createQueue } from '../config/queue.js';

const QUEUE_NAME = 'key-deployments';
export const deploymentQueue = createQueue(QUEUE_NAME);

const ACTIONS = ['deploy', 'remove', 'rotate'];
const OUTPUT_MAX = 4096; // truncate stored output/error to <= 4KB

const BATCH_META_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const batchMetaKey = (batchId) => `keydeploy:batch:${batchId}`;
const batchRepointedKey = (batchId) => `keydeploy:batch:${batchId}:repointed`;

// ---------------------------------------------------------------------------
// Shell command construction (exported for unit testing)
// ---------------------------------------------------------------------------

/** POSIX single-quote a string for safe embedding in a shell command. */
export function shQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

const USERNAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/;

/**
 * Build the inner idempotent authorized_keys script. Runs AS the target user
 * (directly, or already dropped-privilege via sudo -u).
 */
export function buildInnerScript({ action, publicKey }) {
  if (!sshKeysUtil.isValidOpenSshPublicKey(publicKey)) {
    throw new ApiError(400, 'publicKey is not a valid single-line OpenSSH public key');
  }
  const keyQ = shQuote(publicKey.trim());
  const lines = [
    'set -e',
    'HOME_DIR=$(cd ~ && pwd) || exit 3',
    '[ -n "$HOME_DIR" ] || exit 3',
    'mkdir -p "$HOME_DIR/.ssh" && chmod 700 "$HOME_DIR/.ssh"',
    'touch "$HOME_DIR/.ssh/authorized_keys" && chmod 600 "$HOME_DIR/.ssh/authorized_keys"',
    'AK="$HOME_DIR/.ssh/authorized_keys"',
  ];
  if (action === 'remove') {
    lines.push(
      `grep -vxF -- ${keyQ} "$AK" > "$AK.shellius.tmp" 2>/dev/null || true`,
      'mv -f "$AK.shellius.tmp" "$AK"',
      'chmod 600 "$AK"'
    );
  } else {
    lines.push(
      `grep -qxF -- ${keyQ} "$AK" 2>/dev/null || printf '%s\\n' ${keyQ} >> "$AK"`,
      'chmod 600 "$AK"'
    );
  }
  lines.push('echo shellius:ok');
  return lines.join('\n');
}

/**
 * Build the full remote command, wrapping the inner script in `sudo -u
 * <targetUser>` when useSudo is set. Returns { command, stdin } — stdin
 * carries the sudo password (sudo -S) when one is supplied; never appears on
 * the command line.
 */
export function buildDeployCommand({ action, publicKey, targetUser, useSudo, sudoPassword }) {
  // action here is always 'deploy' or 'remove' at the script level — 'rotate'
  // is orchestrated as deploy-then-remove by the caller (processDeployment).
  if (!targetUser || !USERNAME_RE.test(targetUser)) {
    throw new ApiError(400, 'targetUser is not a valid username');
  }
  const inner = buildInnerScript({ action, publicKey });
  if (!useSudo) return { command: inner, stdin: undefined };

  const targetUserQ = shQuote(targetUser);
  const innerQ = shQuote(inner);
  if (sudoPassword) {
    return { command: `sudo -S -k -u ${targetUserQ} -H sh -c ${innerQ}`, stdin: `${sudoPassword}\n` };
  }
  return { command: `sudo -n -u ${targetUserQ} -H sh -c ${innerQ}`, stdin: undefined };
}

// ---------------------------------------------------------------------------
// Batch metadata (Redis) — useSudo + rotate options, keyed by batchId
// ---------------------------------------------------------------------------

async function saveBatchMeta(batchId, meta) {
  await redis.set(batchMetaKey(batchId), JSON.stringify(meta), 'EX', BATCH_META_TTL_SECONDS);
}

async function loadBatchMeta(batchId) {
  const raw = await redis.get(batchMetaKey(batchId));
  return raw ? JSON.parse(raw) : {};
}

// ---------------------------------------------------------------------------
// createBatch
// ---------------------------------------------------------------------------

/**
 * @param {string} orgId
 * @param {object} params
 * @param {string} params.sshKeyId
 * @param {string[]} params.serverIds
 * @param {'deploy'|'remove'|'rotate'} params.action
 * @param {string} [params.targetUser]
 * @param {{mode:'server'}|{mode:'credential', credentialId:string}} params.auth
 * @param {boolean} [params.useSudo=false]
 * @param {{oldSshKeyId:string, updateCredentials?:boolean}} [params.rotate]
 * @param {string} actorId
 * @returns {Promise<{ batchId: string, deployments: object[] }>}
 */
export async function createBatch(
  orgId,
  { sshKeyId, serverIds, action, targetUser, auth, useSudo = false, rotate },
  actorId
) {
  if (!ACTIONS.includes(action)) throw new ApiError(400, `action must be one of: ${ACTIONS.join(', ')}`);
  if (!Array.isArray(serverIds) || serverIds.length === 0) {
    throw new ApiError(400, 'serverIds must be a non-empty array');
  }
  if (!sshKeyId) throw new ApiError(400, 'sshKeyId is required');

  const sshKey = await prisma.sshKey.findFirst({ where: { id: sshKeyId, orgId } });
  if (!sshKey) throw new ApiError(404, 'Key not found');

  let oldSshKey = null;
  if (action === 'rotate') {
    if (!rotate?.oldSshKeyId) throw new ApiError(400, 'rotate.oldSshKeyId is required for action=rotate');
    oldSshKey = await prisma.sshKey.findFirst({ where: { id: rotate.oldSshKeyId, orgId } });
    if (!oldSshKey) throw new ApiError(404, 'rotate.oldSshKeyId not found');
  }

  const mode = auth?.mode === 'credential' ? 'credential' : 'server';
  let authCredential = null;
  if (mode === 'credential') {
    if (!auth.credentialId) throw new ApiError(400, 'auth.credentialId is required when auth.mode is "credential"');
    authCredential = await prisma.credential.findFirst({
      where: { id: auth.credentialId, orgId },
      include: { sshKey: true },
    });
    if (!authCredential) throw new ApiError(404, 'auth.credentialId not found');
  }

  // Refuse servers outside this org — defence in depth beyond the where clause.
  const servers = await prisma.server.findMany({
    where: { id: { in: serverIds }, orgId },
    include: { credential: { include: { sshKey: true } } },
  });
  const foundIds = new Set(servers.map((s) => s.id));
  const missing = serverIds.filter((id) => !foundIds.has(id));
  if (missing.length) {
    throw new ApiError(400, `Servers not found in this organization: ${missing.join(', ')}`);
  }

  const batchId = crypto.randomUUID();

  const rows = [];
  for (const server of servers) {
    const effectiveAuthMode =
      mode === 'credential' ? 'credential' : server.authMode === 'credential' ? 'server' : 'certificate';

    const defaultTargetUser =
      mode === 'credential'
        ? authCredential.username
        : server.authMode === 'credential'
          ? server.credential?.username
          : server.sshUser;

    const row = await prisma.keyDeployment.create({
      data: {
        orgId,
        batchId,
        sshKeyId,
        serverId: server.id,
        action,
        targetUser: targetUser || defaultTargetUser || 'root',
        authMode: effectiveAuthMode,
        authCredentialId: mode === 'credential' ? authCredential.id : null,
        status: 'pending',
        deployedById: actorId || null,
      },
      include: {
        server: { select: { id: true, hostname: true, displayName: true, environment: true } },
        sshKey: { select: { id: true, name: true, fingerprint: true } },
      },
    });
    rows.push(row);
  }

  await saveBatchMeta(batchId, {
    useSudo: !!useSudo,
    action,
    rotate: action === 'rotate' ? { oldSshKeyId: rotate.oldSshKeyId, updateCredentials: !!rotate.updateCredentials } : null,
  });

  for (const row of rows) {
    await deploymentQueue.add('deploy', { deploymentId: row.id }, { jobId: `deploy-${row.id}` });
  }

  await auditLog({
    orgId,
    actorId,
    action: 'keystore.deployment.create',
    resourceType: 'KeyDeployment',
    resourceId: batchId,
    metadata: { batchId, sshKeyId, action, serverCount: servers.length, useSudo: !!useSudo },
  });

  const deployedByMap = actorId
    ? new Map([[actorId, (await prisma.user.findUnique({ where: { id: actorId }, select: { id: true, name: true } })) || null]])
    : new Map();

  return {
    batchId,
    deployments: rows.map((r) => toKeyDeploymentDTO(r, deployedByMap)),
  };
}

// ---------------------------------------------------------------------------
// list / batches / retry
// ---------------------------------------------------------------------------

export async function listDeployments(orgId, { batchId, sshKeyId, serverId, page = 1, pageSize = 25 } = {}) {
  const where = { orgId };
  if (batchId) where.batchId = batchId;
  if (sshKeyId) where.sshKeyId = sshKeyId;
  if (serverId) where.serverId = serverId;

  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25));

  const [items, total] = await Promise.all([
    prisma.keyDeployment.findMany({
      where,
      skip: (p - 1) * ps,
      take: ps,
      orderBy: { createdAt: 'desc' },
      include: {
        server: { select: { id: true, hostname: true, displayName: true, environment: true } },
        sshKey: { select: { id: true, name: true, fingerprint: true } },
      },
    }),
    prisma.keyDeployment.count({ where }),
  ]);

  const deployedByMap = await loadUsersById(orgId, items.map((d) => d.deployedById));
  return {
    deployments: items.map((d) => toKeyDeploymentDTO(d, deployedByMap)),
    meta: { total, page: p, pageSize: ps },
  };
}

async function loadUsersById(orgId, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { orgId, id: { in: uniq } },
    select: { id: true, name: true, email: true, avatarUrl: true },
  });
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, email: r.email, avatarUrl: r.avatarUrl }]));
}

export async function listBatches(orgId, { limit = 20 } = {}) {
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const batches = await prisma.keyDeployment.groupBy({
    by: ['batchId'],
    where: { orgId },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: 'desc' } },
    take: lim,
  });

  const results = [];
  for (const b of batches) {
    const rows = await prisma.keyDeployment.findMany({
      where: { orgId, batchId: b.batchId },
      include: { sshKey: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) continue;
    const first = rows[0];
    const counts = { pending: 0, running: 0, success: 0, failed: 0, total: rows.length };
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    const deployedByMap = await loadUsersById(orgId, [first.deployedById]);
    results.push({
      batchId: b.batchId,
      action: first.action,
      sshKey: first.sshKey,
      createdAt: first.createdAt,
      deployedBy: first.deployedById ? deployedByMap.get(first.deployedById) || null : null,
      counts,
    });
  }
  return { batches: results };
}

export async function retryDeployment(orgId, id, actorId) {
  const row = await prisma.keyDeployment.findFirst({ where: { id, orgId } });
  if (!row) throw new ApiError(404, 'Deployment not found');
  if (row.status === 'running') throw new ApiError(409, 'Deployment is already running');

  const updated = await prisma.keyDeployment.update({
    where: { id },
    data: { status: 'pending', error: null, output: null, startedAt: null, finishedAt: null },
    include: {
      server: { select: { id: true, hostname: true, displayName: true, environment: true } },
      sshKey: { select: { id: true, name: true, fingerprint: true } },
    },
  });

  await deploymentQueue.add('deploy', { deploymentId: id }, { jobId: `deploy-${id}-retry-${Date.now()}` });

  await auditLog({
    orgId,
    actorId,
    action: 'keystore.deployment.retry',
    resourceType: 'KeyDeployment',
    resourceId: id,
    metadata: { batchId: row.batchId },
  });

  const deployedByMap = await loadUsersById(orgId, [updated.deployedById]);
  return { deployment: toKeyDeploymentDTO(updated, deployedByMap) };
}

// ---------------------------------------------------------------------------
// processDeployment — the actual per-server work, invoked by the worker
// ---------------------------------------------------------------------------

function truncate(str) {
  if (!str) return str;
  return str.length > OUTPUT_MAX ? str.slice(0, OUTPUT_MAX) + '\n…(truncated)' : str;
}

/**
 * Defence-in-depth for KeyDeployment.output/error: the sudo password is only
 * ever sent over the exec channel's stdin (never placed on the command
 * line — see buildDeployCommand), so it should never appear in remote
 * stdout/stderr. But sudo prompts, shell tracing (`set -x` in a profile
 * script we don't control), or an unexpected remote error message could
 * still echo it back. Strip any literal occurrence of the known secrets
 * used for this deployment attempt before the text is ever persisted.
 */
function redactKnownSecrets(text, secrets = []) {
  if (!text) return text;
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

/**
 * Run one command against a server via ssh2 (credential / server-credential
 * auth) or by shelling out to the real `ssh` client with an ephemeral CA
 * cert (certificate-mode servers — ssh2 cannot do OpenSSH cert auth, see
 * terminalService.js for the same limitation).
 */
async function runOverSsh2({ server, authOpts, command, stdin }) {
  const { client, hostKey } = await sshConnect.connectSsh({
    host: server.ipAddress || server.hostname,
    port: server.port || 22,
    ...authOpts,
    readyTimeout: 20000,
  });
  try {
    if (hostKey) await sshConnect.checkAndPinHostKey(server, hostKey);
    const result = await sshConnect.execCommand(client, command, { stdin });
    return result;
  } finally {
    try { client.end(); } catch { /* ignore */ }
  }
}

/**
 * Resolve { authOpts } (ssh2 connect fragment) or a cert-mode descriptor for
 * one deployment row, based on its stored authMode.
 */
async function resolveDeployAuth(row, server) {
  if (row.authMode === 'credential') {
    const credential = await prisma.credential.findFirst({
      where: { id: row.authCredentialId, orgId: row.orgId },
      include: { sshKey: true },
    });
    if (!credential) throw new ApiError(400, 'Deployment auth credential no longer exists');
    const opts = resolveCredentialAuth(credential);
    return { kind: 'ssh2', authOpts: opts, sudoPassword: opts.password || null };
  }
  if (row.authMode === 'server') {
    const opts = await sshConnect.resolveServerAuth(server);
    return { kind: 'ssh2', authOpts: opts, sudoPassword: opts.password || null };
  }
  // certificate mode
  return { kind: 'certificate', principal: server.sshUser || 'root' };
}

/**
 * Execute the deploy/remove script for one row against its server, using
 * whichever auth the row was configured with. Returns { code, stdout, stderr }.
 */
async function execDeployStep({ row, server, action, publicKey, targetUser, useSudo }) {
  const auth = await resolveDeployAuth(row, server);

  if (auth.kind === 'ssh2') {
    const { command, stdin } = buildDeployCommand({
      action,
      publicKey,
      targetUser,
      useSudo,
      sudoPassword: useSudo ? auth.sudoPassword : null,
    });
    const result = await runOverSsh2({ server, authOpts: auth.authOpts, command, stdin });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }

  // certificate mode — sign a short-lived ephemeral cert for auth.principal
  // and connect via ssh2 (sshConnect.connectSsh's certificate auth path).
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellius-deploykey-'));
  let privateKeyBuf;
  try {
    const keyPath = path.join(tmpDir, 'id_ed25519');
    await new Promise((resolve, reject) => {
      const p = spawn('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-q']);
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ssh-keygen exited ${code}`))));
    });
    const [privateKeyText, publicKeyText] = await Promise.all([
      fs.readFile(keyPath, 'utf8'),
      fs.readFile(`${keyPath}.pub`, 'utf8'),
    ]);
    privateKeyBuf = Buffer.from(privateKeyText, 'utf8');

    const { signedCert } = await caService.signCertificate({
      orgId: server.orgId,
      publicKey: publicKeyText.trim(),
      principals: [auth.principal],
      validitySeconds: 300,
      certType: 'USER',
      keyId: `keydeploy-${server.id}-${Date.now()}`,
    });

    // Passwordless sudo only — no stored password exists for cert-mode auth.
    const { command } = buildDeployCommand({ action, publicKey, targetUser, useSudo, sudoPassword: null });

    const result = await runOverSsh2({
      server,
      authOpts: { username: auth.principal, privateKey: privateKeyText, certificate: signedCert },
      command,
    });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  } finally {
    if (privateKeyBuf) privateKeyBuf.fill(0);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Verify SSH login works with the freshly-deployed key (rotate's "verify"
 * step), connecting as targetUser with the new key — regardless of which
 * auth mode was used to deploy it.
 */
async function verifyNewKeyLogin({ server, targetUser, newSshKey }) {
  const privateKey = decrypt(newSshKey.privateKeyEncrypted);
  const passphrase = newSshKey.passphraseEncrypted ? decrypt(newSshKey.passphraseEncrypted) : undefined;
  const { client } = await sshConnect.connectSsh({
    host: server.ipAddress || server.hostname,
    port: server.port || 22,
    username: targetUser,
    privateKey,
    passphrase,
    readyTimeout: 15000,
  });
  try {
    const r = await sshConnect.execCommand(client, 'echo shellius:verify-ok');
    if (r.code !== 0 || !/shellius:verify-ok/.test(r.stdout)) {
      throw new Error('Login with the new key succeeded but the verification command failed');
    }
  } finally {
    try { client.end(); } catch { /* ignore */ }
  }
}

export async function processDeployment(deploymentId) {
  const row = await prisma.keyDeployment.findUnique({ where: { id: deploymentId } });
  if (!row) return; // finalized/deleted
  if (row.status === 'success') return; // idempotent — already done

  await prisma.keyDeployment.update({
    where: { id: deploymentId },
    data: { status: 'running', startedAt: new Date(), error: null },
  });

  const server = await prisma.server.findUnique({
    where: { id: row.serverId },
    include: { credential: { include: { sshKey: true } } },
  });
  if (!server) {
    await finishRow(row, 'failed', { error: 'Server no longer exists' });
    return;
  }
  if (server.orgId !== row.orgId) {
    // Defence in depth — never operate cross-tenant even if IDs collide.
    await finishRow(row, 'failed', { error: 'Server does not belong to this organization' });
    return;
  }

  const meta = await loadBatchMeta(row.batchId);
  const useSudo = !!meta.useSudo;

  // Resolved once, purely to know which literal secret values (sudo
  // password / SSH login password / passphrase) to strip from stored
  // output — never logged or persisted itself. Best-effort: if it fails,
  // deployment proceeds as normal via execDeployStep's own resolution.
  const secretsToRedact = [];
  try {
    const authForRedaction = await resolveDeployAuth(row, server);
    if (authForRedaction?.sudoPassword) secretsToRedact.push(authForRedaction.sudoPassword);
    if (authForRedaction?.authOpts?.password) secretsToRedact.push(authForRedaction.authOpts.password);
    if (authForRedaction?.authOpts?.passphrase) secretsToRedact.push(authForRedaction.authOpts.passphrase);
  } catch {
    /* best-effort — see comment above */
  }

  try {
    let output = '';

    if (row.action === 'rotate') {
      const newKey = await prisma.sshKey.findFirst({ where: { id: row.sshKeyId, orgId: row.orgId } });
      const oldKey = await prisma.sshKey.findFirst({ where: { id: meta.rotate?.oldSshKeyId, orgId: row.orgId } });
      if (!newKey || !oldKey) throw new Error('rotate: source or target key no longer exists');

      const deployRes = await execDeployStep({
        row, server, action: 'deploy', publicKey: newKey.publicKey, targetUser: row.targetUser, useSudo,
      });
      output += `--- deploy new key ---\n${deployRes.stdout}${deployRes.stderr}\n`;
      if (deployRes.code !== 0) throw new Error(`Failed to deploy new key (exit ${deployRes.code}): ${deployRes.stderr || deployRes.stdout}`);

      await verifyNewKeyLogin({ server, targetUser: row.targetUser, newSshKey: newKey });
      output += `--- verify login with new key: ok ---\n`;

      const removeRes = await execDeployStep({
        row, server, action: 'remove', publicKey: oldKey.publicKey, targetUser: row.targetUser, useSudo,
      });
      output += `--- remove old key ---\n${removeRes.stdout}${removeRes.stderr}\n`;
      if (removeRes.code !== 0) throw new Error(`Failed to remove old key (exit ${removeRes.code}): ${removeRes.stderr || removeRes.stdout}`);
    } else {
      const key = await prisma.sshKey.findFirst({ where: { id: row.sshKeyId, orgId: row.orgId } });
      if (!key) throw new Error('Key no longer exists');
      const res = await execDeployStep({
        row, server, action: row.action, publicKey: key.publicKey, targetUser: row.targetUser, useSudo,
      });
      output += res.stdout + res.stderr;
      if (res.code !== 0) throw new Error(`Command exited with code ${res.code}: ${res.stderr || res.stdout}`);
    }

    await finishRow(row, 'success', { output: redactKnownSecrets(output, secretsToRedact) });

    await auditLog({
      orgId: row.orgId,
      actorId: row.deployedById,
      action: `keystore.deployment.${row.action}.success`,
      resourceType: 'Server',
      resourceId: row.serverId,
      metadata: { deploymentId: row.id, batchId: row.batchId, sshKeyId: row.sshKeyId, targetUser: row.targetUser },
    });

    if (row.action === 'rotate') {
      await maybeFinalizeRotateBatch(row.batchId, row.orgId, meta);
    }
  } catch (err) {
    const safeErrorMessage = redactKnownSecrets(err.message, secretsToRedact);
    logger.warn('keyDeploymentService: deployment failed', {
      deploymentId, serverId: row.serverId, batchId: row.batchId, error: safeErrorMessage,
    });
    await finishRow(row, 'failed', { error: safeErrorMessage });
    await auditLog({
      orgId: row.orgId,
      actorId: row.deployedById,
      action: `keystore.deployment.${row.action}.failed`,
      resourceType: 'Server',
      resourceId: row.serverId,
      metadata: { deploymentId: row.id, batchId: row.batchId, error: safeErrorMessage },
    });
  }
}

async function finishRow(row, status, { output, error } = {}) {
  await prisma.keyDeployment.update({
    where: { id: row.id },
    data: {
      status,
      finishedAt: new Date(),
      ...(output !== undefined ? { output: truncate(output) } : {}),
      ...(error !== undefined ? { error: truncate(error) } : {}),
    },
  }).catch((e) => logger.warn('keyDeploymentService: finishRow update failed', { error: e.message }));
}

/**
 * After a rotate row succeeds, check whether the whole batch is done. If
 * every row succeeded and updateCredentials was requested, repoint every
 * Credential using the old key to the new one — exactly once (Redis SETNX).
 */
async function maybeFinalizeRotateBatch(batchId, orgId, meta) {
  if (!meta?.rotate?.updateCredentials) return;

  const rows = await prisma.keyDeployment.findMany({ where: { batchId, orgId } });
  const notDone = rows.filter((r) => r.status !== 'success');
  if (notDone.length > 0) return; // still in flight, or some failed — skip repoint

  const lockKey = batchRepointedKey(batchId);
  const acquired = await redis.set(lockKey, '1', 'EX', BATCH_META_TTL_SECONDS, 'NX');
  if (!acquired) return; // another row's completion already triggered this

  const { oldSshKeyId } = meta.rotate;
  const newSshKeyId = rows[0].sshKeyId;
  const result = await prisma.credential.updateMany({
    where: { orgId, sshKeyId: oldSshKeyId },
    data: { sshKeyId: newSshKeyId },
  });

  await auditLog({
    orgId,
    actorId: rows[0].deployedById,
    action: 'keystore.deployment.rotate_credentials_repointed',
    resourceType: 'SshKey',
    resourceId: newSshKeyId,
    metadata: { batchId, oldSshKeyId, newSshKeyId, credentialsUpdated: result.count },
  });

  logger.info('keyDeploymentService: rotate batch repointed credentials', {
    batchId, oldSshKeyId, newSshKeyId, credentialsUpdated: result.count,
  });
}

// ---------------------------------------------------------------------------
// Startup reaper — stale 'running' rows (worker crashed mid-job)
// ---------------------------------------------------------------------------

export async function reapStaleRunning() {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  const res = await prisma.keyDeployment.updateMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    data: { status: 'failed', error: 'Deployment worker restarted mid-job (stale running row)', finishedAt: new Date() },
  });
  if (res.count > 0) {
    logger.warn('keyDeploymentService: reaped stale running deployments', { count: res.count });
  }
  return res.count;
}

export default {
  shQuote,
  buildInnerScript,
  buildDeployCommand,
  createBatch,
  listDeployments,
  listBatches,
  retryDeployment,
  processDeployment,
  reapStaleRunning,
};
