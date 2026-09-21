/**
 * importService — bulk import of customers / servers / users / groups / policies
 * / memberships from CSV / JSON / ZIP, with a preview → conflict-resolution →
 * commit → background-onboarding pipeline.
 *
 * Refs are always by natural key (never uuid): customer by slug|name, user by
 * email, server by hostname, group by name, policy by name. Same-import refs
 * resolve against the upload itself, so order within the file does not matter.
 *
 * Idempotent: an already-present record is flagged as a conflict; the admin
 * chooses overwrite or skip (per-row or bulk).
 */

import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { parseUpload, resolveFile } from './importParsers.js';
import * as customerService from './customerService.js';
import * as serverService from './serverService.js';
import * as userService from './userService.js';
import * as groupService from './groupService.js';
import * as policyService from './policyService.js';
import * as userInviteService from './userInviteService.js';
import { resolveRole } from './roleService.js';
import * as keystoreService from './keystoreService.js';

// Dependency order for both planning and committing.
const ORDER = ['groups', 'customers', 'users', 'servers', 'policies', 'memberships'];
const ENTITY_SINGULAR = {
  groups: 'group',
  customers: 'customer',
  users: 'user',
  servers: 'server',
  policies: 'policy',
  memberships: 'membership',
};

// --- coercion helpers -------------------------------------------------------

const str = (v) => (v == null ? '' : String(v).trim());
const lower = (v) => str(v).toLowerCase();
function bool(v, dflt = false) {
  if (v == null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return ['true', '1', 'yes', 'y', 'on'].includes(lower(v));
}
function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : n;
}
function list(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  const s = str(v);
  if (s.startsWith('[')) {
    try {
      const a = JSON.parse(s);
      return Array.isArray(a) ? a.map(str).filter(Boolean) : [];
    } catch {
      /* fall through */
    }
  }
  return s.split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
}
function labelsToArray(v) {
  // Server.labels is a string[] of "key:value". Accept "k:v;k2:v2", JSON array,
  // or JSON object {k:v}.
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  const s = str(v);
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      return Object.entries(o).map(([k, val]) => `${k}:${val}`);
    } catch {
      /* ignore */
    }
  }
  return list(s);
}

// --- public: parse + plan ---------------------------------------------------

/**
 * Parse the upload and build a preview (ImportJob + ImportRows). Returns the
 * job id and a per-entity summary. Stores onboarding secrets only at commit.
 */
export async function createImportJob({ orgId, actorId, buffer, filename, declaredType }) {
  const { source, entities, files, warnings } = parseUpload(buffer, filename, declaredType);

  const job = await prisma.importJob.create({
    data: { orgId, actorId, status: 'preview_ready', source, summary: {} },
  });

  // Natural-key sets present in THIS upload, so same-import refs resolve.
  const inImport = {
    customers: new Set((entities.customers || []).map((r) => lower(r.slug || r.name))),
    customerNames: new Set((entities.customers || []).map((r) => lower(r.name))),
    users: new Set((entities.users || []).map((r) => lower(r.email))),
    groups: new Set((entities.groups || []).map((r) => lower(r.name))),
    servers: new Set((entities.servers || []).map((r) => lower(r.hostname))),
  };

  const summary = {};
  const rowsToCreate = [];

  for (const entity of ORDER) {
    const rows = entities[entity] || [];
    const counts = { create: 0, conflict: 0, error: 0, total: rows.length };
    for (let i = 0; i < rows.length; i++) {
      const planned = await planRow(orgId, entity, rows[i], inImport, files);
      counts[planned.action] = (counts[planned.action] || 0) + 1;

      // Capture onboarding secrets NOW (encrypted), while we still have the raw
      // values + zip key files. They are linked to the created server at commit
      // and wiped by the worker / TTL reaper. Skip rows that errored.
      if (entity === 'servers' && planned.action !== 'error') {
        await stageCredentialAtUpload(job.id, rows[i], files).catch((e) =>
          logger.warn('importService: stageCredential failed', { error: e.message })
        );
      }
      rowsToCreate.push({
        jobId: job.id,
        entity: ENTITY_SINGULAR[entity],
        rowIndex: i,
        raw: sanitizeRaw(rows[i]),
        resolved: planned.resolved || {},
        action: planned.action,
        // conflictReason doubles as a free-text note (e.g. "imported without onboarding").
        conflictReason: planned.conflictReason || planned.note || null,
        // Default conflict decision = skip (safe). create/error left null.
        decision: planned.action === 'conflict' ? 'skip' : null,
        status: 'pending',
        error: planned.error || null,
      });
    }
    if (rows.length) summary[entity] = counts;
  }

  if (rowsToCreate.length) {
    await prisma.importRow.createMany({ data: rowsToCreate });
  }
  if (warnings.length) summary.warnings = warnings;

  await prisma.importJob.update({ where: { id: job.id }, data: { summary } });
  return { jobId: job.id, summary, source };
}

// Persisted import rows must never hold plaintext secrets. SSH onboarding
// creds (password/key/sudo) are dropped here — they live encrypted in
// OnboardingCredential. rdpPassword is needed on the Server record at commit,
// so it is stored ENCRYPTED under rdpPasswordEnc. Inline user passwords are not
// supported (bulk users are invite-only).
function sanitizeRaw(row) {
  const {
    password, privateKey, sshPrivateKey, sudoPassword, keyFile, rdpPassword, ...rest
  } = row || {};
  const out = { ...rest };
  if (password || privateKey || sshPrivateKey) out._hasOnboardSecret = true;
  if (keyFile) out._hasOnboardSecret = true;
  if (rdpPassword) out.rdpPasswordEnc = encrypt(String(rdpPassword));
  return out;
}

async function planRow(orgId, entity, row, inImport, files) {
  try {
    switch (entity) {
      case 'customers':
        return planCustomer(orgId, row);
      case 'groups':
        return planGroup(orgId, row);
      case 'users':
        return planUser(orgId, row, inImport);
      case 'servers':
        return planServer(orgId, row, inImport, files);
      case 'policies':
        return planPolicy(orgId, row);
      case 'memberships':
        return planMembership(orgId, row, inImport);
      default:
        return { action: 'error', error: `Unknown entity ${entity}` };
    }
  } catch (err) {
    return { action: 'error', error: err.message };
  }
}

async function planCustomer(orgId, row) {
  const name = str(row.name);
  if (!name) return { action: 'error', error: 'name is required' };
  const slug = lower(row.slug) || null;
  const existing = await prisma.customer.findFirst({
    where: { orgId, OR: [slug ? { slug } : undefined, { name }].filter(Boolean) },
  });
  if (existing) return { action: 'conflict', conflictReason: 'A customer with this name/slug already exists' };
  return { action: 'create', resolved: { name, slug } };
}

async function planGroup(orgId, row) {
  const name = str(row.name);
  if (!name) return { action: 'error', error: 'name is required' };
  const existing = await prisma.group.findFirst({ where: { orgId, name } });
  if (existing) return { action: 'conflict', conflictReason: 'A group with this name already exists' };
  return { action: 'create', resolved: { name } };
}

async function planUser(orgId, row, inImport) {
  const email = lower(row.email);
  const name = str(row.name);
  if (!email) return { action: 'error', error: 'email is required' };
  if (!name) return { action: 'error', error: 'name is required' };
  // Manager ref (by email) must exist in DB or in this import.
  const managerEmail = lower(row.manager || row.managerEmail);
  if (managerEmail && !inImport.users.has(managerEmail)) {
    const mgr = await prisma.user.findFirst({ where: { orgId, email: managerEmail } });
    if (!mgr) return { action: 'error', error: `Manager "${managerEmail}" not found` };
  }
  const existing = await prisma.user.findFirst({ where: { orgId, email } });
  if (existing) return { action: 'conflict', conflictReason: 'A user with this email already exists' };
  return { action: 'create', resolved: { email, name } };
}

async function planServer(orgId, row, inImport, files) {
  const hostname = str(row.hostname);
  const ipAddress = str(row.ipAddress || row.ip);
  const dynamicIp = bool(row.dynamicIp);
  if (!hostname) return { action: 'error', error: 'hostname is required' };
  // Non-static (dynamicIp) servers resolve their address at connect time, so an
  // ipAddress is not required at import. Static servers still require one.
  if (!ipAddress && !dynamicIp) return { action: 'error', error: 'ipAddress is required' };

  // Customer ref required (by slug or name), DB or same-import.
  const custRef = lower(row.customer || row.customerSlug || row.customerName);
  if (!custRef) return { action: 'error', error: 'customer (slug or name) is required' };
  if (!inImport.customers.has(custRef) && !inImport.customerNames.has(custRef)) {
    const cust = await prisma.customer.findFirst({
      where: { orgId, OR: [{ slug: custRef }, { name: { equals: custRef, mode: 'insensitive' } }] },
    });
    if (!cust) return { action: 'error', error: `Customer "${custRef}" not found` };
  }

  // Key-file reference (zip): if unresolved, the server still imports — only
  // the optional background onboarding for this host is skipped (warned below).
  const keyFile = str(row.keyFile);
  const keyMissing = keyFile && !resolveFile(files, keyFile);

  const notes = [];
  if (keyMissing) {
    notes.push(`Imported without onboarding — key file "${keyFile}" not found in the archive`);
  }
  // storeAsIdentity with nothing to store is almost always a filled-in
  // column on a row whose credentials were forgotten. Saying so at preview
  // is the difference between noticing now and noticing when a bulk install
  // skips the host weeks later.
  if (bool(row.storeAsIdentity ?? row.saveAsIdentity) && !str(row.password) && !keyFile && !row.privateKey) {
    notes.push('storeAsIdentity is set but this row has no password or key — nothing will be saved to the Keystore');
  }
  const note = notes.length > 0 ? notes.join('. ') : null;

  const existing = await prisma.server.findFirst({ where: { orgId, hostname } });
  if (existing) {
    const reason = existing.provisionStatus === 'provisioned'
      ? 'Server already exists and is onboarded (overwrite re-runs the idempotent bootstrap)'
      : 'A server with this hostname already exists';
    return { action: 'conflict', conflictReason: note ? `${reason}. ${note}` : reason };
  }
  return { action: 'create', resolved: { hostname, custRef }, note };
}

async function planPolicy(orgId, row) {
  const name = str(row.name);
  if (!name) return { action: 'error', error: 'name is required' };
  const existing = await prisma.accessPolicy.findFirst({ where: { orgId, name } });
  if (existing) return { action: 'conflict', conflictReason: 'A policy with this name already exists' };
  return { action: 'create', resolved: { name } };
}

async function planMembership(orgId, row, inImport) {
  const groupName = str(row.group || row.groupName);
  const email = lower(row.user || row.email);
  if (!groupName) return { action: 'error', error: 'group is required' };
  if (!email) return { action: 'error', error: 'user (email) is required' };
  if (!inImport.groups.has(lower(groupName))) {
    const g = await prisma.group.findFirst({ where: { orgId, name: groupName } });
    if (!g) return { action: 'error', error: `Group "${groupName}" not found` };
  }
  if (!inImport.users.has(email)) {
    const u = await prisma.user.findFirst({ where: { orgId, email } });
    if (!u) return { action: 'error', error: `User "${email}" not found` };
  }
  return { action: 'create', resolved: { groupName, email } };
}

// --- public: decisions ------------------------------------------------------

/** Set overwrite|skip on conflict rows. ids empty + applyAll => bulk. */
export async function setDecisions({ orgId, jobId, decision, rowIds, applyAll }) {
  if (!['overwrite', 'skip'].includes(decision)) {
    throw new Error('decision must be overwrite or skip');
  }
  const job = await prisma.importJob.findFirst({ where: { id: jobId, orgId } });
  if (!job) throw new Error('Import job not found');

  const where = { jobId, action: 'conflict' };
  if (!applyAll && Array.isArray(rowIds) && rowIds.length) where.id = { in: rowIds };
  const res = await prisma.importRow.updateMany({ where, data: { decision } });
  return { updated: res.count };
}

// --- public: commit ---------------------------------------------------------

export async function commitImportJob({ orgId, jobId, actorId, actor = null, req }) {
  const job = await prisma.importJob.findFirst({ where: { id: jobId, orgId } });
  if (!job) throw new Error('Import job not found');
  if (!['preview_ready', 'failed'].includes(job.status)) {
    throw new Error(`Import job cannot be committed (status: ${job.status})`);
  }

  await prisma.importJob.update({ where: { id: jobId }, data: { status: 'committing', error: null } });

  const rows = await prisma.importRow.findMany({ where: { jobId }, orderBy: { rowIndex: 'asc' } });
  const byEntity = (singular) => rows.filter((r) => r.entity === singular);

  // Caches mapping natural key -> id (DB + just-created).
  const cache = { customers: new Map(), groups: new Map(), users: new Map(), servers: new Map(), identities: new Map() };
  const result = { imported: 0, skipped: 0, failed: 0, onboarding: 0 };

  try {
    for (const entity of ORDER) {
      const singular = ENTITY_SINGULAR[entity];
      for (const row of byEntity(singular)) {
        await commitRow({ orgId, job, row, actorId, actor, req, cache, result });
      }
    }

    // Wipe credentials whose server row was skipped (still 'staged' = unlinked).
    await prisma.onboardingCredential.deleteMany({ where: { jobId, status: 'staged' } });

    // Kick off background onboarding for linked credentials.
    const pendingCreds = await prisma.onboardingCredential.count({ where: { jobId, status: 'pending' } });
    const finalStatus = pendingCreds > 0 ? 'onboarding' : 'completed';
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: finalStatus, summary: { ...(job.summary || {}), result } },
    });

    if (pendingCreds > 0) {
      const { enqueueOnboarding } = await import('../jobs/serverOnboarding.js');
      await enqueueOnboarding(jobId);
    }

    return { status: finalStatus, result };
  } catch (err) {
    await prisma.importJob.update({ where: { id: jobId }, data: { status: 'failed', error: err.message } });
    logger.error('importService.commit failed', { jobId, error: err.message });
    throw err;
  }
}

function safeDecrypt(v) {
  try {
    return decrypt(v);
  } catch {
    return undefined;
  }
}

async function markRow(rowId, data) {
  await prisma.importRow.update({ where: { id: rowId }, data });
}

// Permission each row type needs (on top of import.run). Overwrites of
// existing records need the matching edit permission too.
const ROW_PERMISSIONS = {
  customer: { create: 'customers.create', overwrite: 'customers.update' },
  group: { create: 'groups.manage', overwrite: 'groups.manage' },
  user: { create: 'users.invite', overwrite: 'users.update' },
  server: { create: 'servers.create', overwrite: 'servers.update' },
  policy: { create: 'policies.manage', overwrite: 'policies.manage' },
  membership: { create: 'groups.manage', overwrite: 'groups.manage' },
};

async function commitRow({ orgId, job, row, actorId, actor, req, cache, result }) {
  // Honor user decisions / planning outcomes.
  if (row.action === 'error') {
    await markRow(row.id, { status: 'failed' });
    result.failed++;
    return;
  }
  if (row.action === 'skip' || (row.action === 'conflict' && row.decision !== 'overwrite')) {
    await markRow(row.id, { status: 'skipped' });
    result.skipped++;
    return;
  }

  const overwrite = row.action === 'conflict' && row.decision === 'overwrite';
  const raw = row.raw || {};

  try {
    const needed = ROW_PERMISSIONS[row.entity]?.[overwrite ? 'overwrite' : 'create'];
    if (actor && needed && !actor.permissions.has(needed)) {
      throw new Error(`You don't have the ${needed} permission`);
    }
    switch (row.entity) {
      case 'customer':
        await commitCustomer(orgId, row, raw, overwrite, cache);
        break;
      case 'group':
        await commitGroup(orgId, row, raw, overwrite, cache);
        break;
      case 'user':
        await commitUser(orgId, row, raw, overwrite, actor, req, cache);
        break;
      case 'server':
        await commitServer(orgId, job, row, raw, overwrite, cache);
        break;
      case 'policy':
        await commitPolicy(orgId, row, raw, overwrite, cache);
        break;
      case 'membership':
        await commitMembership(orgId, row, raw, actorId, cache);
        break;
      default:
        throw new Error(`Unknown entity ${row.entity}`);
    }
    await markRow(row.id, { status: 'imported' });
    result.imported++;
  } catch (err) {
    await markRow(row.id, { status: 'failed', error: err.message?.slice(0, 500) });
    result.failed++;
  }
}

async function commitCustomer(orgId, row, raw, overwrite, cache) {
  const name = str(raw.name);
  const slug = lower(raw.slug) || undefined;
  let cust = await prisma.customer.findFirst({
    where: { orgId, OR: [slug ? { slug } : undefined, { name }].filter(Boolean) },
  });
  if (cust && overwrite) {
    cust = await customerService.updateCustomer(orgId, cust.id, {
      name,
      description: str(raw.description) || undefined,
    });
  } else if (!cust) {
    cust = await customerService.createCustomer(orgId, {
      name,
      slug,
      description: str(raw.description) || undefined,
    });
  }
  cache.customers.set(lower(cust.slug), cust.id);
  cache.customers.set(lower(cust.name), cust.id);
  await markRow(row.id, { resultId: cust.id });
}

async function commitGroup(orgId, row, raw, overwrite, cache) {
  const name = str(raw.name);
  let group = await prisma.group.findFirst({ where: { orgId, name } });
  if (group && overwrite) {
    group = await groupService.updateGroup(orgId, group.id, { description: str(raw.description) || undefined });
  } else if (!group) {
    group = await groupService.createGroup(orgId, { name, description: str(raw.description) || undefined });
  }
  cache.groups.set(lower(name), group.id);
  await markRow(row.id, { resultId: group.id });
}

async function resolveManagerId(orgId, raw, cache) {
  const managerEmail = lower(raw.manager || raw.managerEmail);
  if (!managerEmail) return undefined;
  if (cache.users.has(managerEmail)) return cache.users.get(managerEmail);
  const mgr = await prisma.user.findFirst({ where: { orgId, email: managerEmail } });
  return mgr?.id;
}

async function commitUser(orgId, row, raw, overwrite, actor, req, cache) {
  const email = lower(raw.email);
  const name = str(raw.name);
  // A role id, key or name ("Senior admin"); resolved by userService.
  const role = str(raw.role) || undefined;
  const managerId = await resolveManagerId(orgId, raw, cache);

  // Bulk users are always invite-based (no inline passwords stored). They
  // either set a password via the invite link or sign in with SSO.
  let user = await prisma.user.findFirst({ where: { orgId, email } });
  if (user && overwrite) {
    user = await userService.updateUser(orgId, user.id, { name, role, managerId }, actor);
  } else if (!user) {
    user = await userService.createUser(orgId, { email, name, role, managerId, status: 'invited' }, actor);
    if (bool(raw.sendInvite, true)) {
      await userInviteService.sendInvite({ orgId, user, req }).catch(() => {});
    }
  }
  cache.users.set(email, user.id);
  await markRow(row.id, { resultId: user.id });
}

async function resolveCustomerId(orgId, custRef, cache) {
  const key = lower(custRef);
  if (cache.customers.has(key)) return cache.customers.get(key);
  const cust = await prisma.customer.findFirst({
    where: { orgId, OR: [{ slug: key }, { name: { equals: key, mode: 'insensitive' } }] },
  });
  return cust?.id;
}

async function commitServer(orgId, job, row, raw, overwrite, cache) {
  const hostname = str(raw.hostname);
  const ipAddress = str(raw.ipAddress || raw.ip);
  const custRef = str(raw.customer || raw.customerSlug || raw.customerName);
  const customerId = await resolveCustomerId(orgId, custRef, cache);
  if (!customerId) throw new Error(`Customer "${custRef}" could not be resolved`);

  const data = {
    hostname,
    ipAddress,
    displayName: str(raw.displayName) || undefined,
    description: str(raw.description) || undefined,
    port: int(raw.port, undefined),
    protocol: lower(raw.protocol) || undefined,
    environment: lower(raw.environment) || undefined,
    labels: labelsToArray(raw.labels),
    osType: str(raw.osType) || undefined,
    osVersion: str(raw.osVersion) || undefined,
    dynamicIp: bool(raw.dynamicIp) || undefined,
    sshUser: str(raw.sshUser) || undefined,
    rdpUsername: str(raw.rdpUsername) || undefined,
    ...(raw.rdpPasswordEnc ? { rdpPassword: safeDecrypt(raw.rdpPasswordEnc) } : {}),
    // Optional cloud provider metadata.
    cloudProvider: lower(raw.cloudProvider) || undefined,
    cloudInstanceId: str(raw.cloudInstanceId) || undefined,
    cloudRegion: str(raw.cloudRegion) || undefined,
  };

  let server = await prisma.server.findFirst({ where: { orgId, hostname } });
  if (server && overwrite) {
    server = await serverService.updateServer(orgId, server.id, data);
  } else if (!server) {
    server = await serverService.createServer(orgId, customerId, data);
  }
  cache.servers.set(lower(hostname), server.id);
  await markRow(row.id, { resultId: server.id });

  // Link the credential staged at upload (by hostname) to the created server
  // and mark it ready to onboard.
  await prisma.onboardingCredential.updateMany({
    where: { jobId: job.id, serverRef: hostname, status: 'staged' },
    data: { serverId: server.id, status: 'pending' },
  });

  // ...and, if the row asked for it, keep those credentials as a real
  // Keystore identity bound to this server.
  await materializeIdentity({ orgId, job, hostname, server, cache });
}

/**
 * Turn a row's staged bootstrap credentials into a Keystore identity.
 *
 * Import secrets are destroyed the moment onboarding reaches a terminal
 * state (jobs/serverOnboarding.js finalize()), and `server.credentialId` was
 * never set. The result: a fleet that has just been imported and
 * bootstrapped has nothing stored for any of its hosts, so every later bulk
 * action has to skip them for "no credentials". `storeAsIdentity` is the
 * opt-out of that.
 *
 * Deduplication is by `identityName`. Fifty servers behind one bastion key
 * name the same identity and get ONE Keystore entry between them; without
 * that the only other option is a name derived from the hostname, and fifty
 * near-identical entries is not a Keystore, it is a mess.
 *
 * `authMode` is deliberately untouched. A bootstrapped host should keep
 * authenticating by certificate for ordinary access — the stored identity is
 * there for installs and recovery, not as a downgrade of how people connect.
 */
async function materializeIdentity({ orgId, job, hostname, server, cache }) {
  const staged = await prisma.onboardingCredential.findFirst({
    where: { jobId: job.id, serverRef: hostname, storeAsIdentity: true },
  });
  if (!staged) return;

  const name = staged.identityName || `Imported — ${hostname}`;
  const username = staged.sshUser || 'root';
  const key = lower(name);

  // Already built in this same commit (another row named the same identity).
  let credentialId = cache.identities.get(key);

  if (!credentialId) {
    const existing = await prisma.credential.findFirst({
      where: { orgId, ownerId: null, name },
      select: { id: true, username: true },
    });
    if (existing) {
      // Reuse only when it is plausibly the same account. Silently pointing
      // a server at an identity that differs from the one the file
      // described is worse than refusing.
      if (lower(existing.username) !== lower(username)) {
        throw new Error(
          `Identity "${name}" already exists for user "${existing.username}", but this row is for "${username}". ` +
            'Use a different identityName, or remove the conflict in the Keystore.'
        );
      }
      credentialId = existing.id;
    }
  }

  if (!credentialId) {
    const privateKey =
      staged.secretEncrypted && staged.authMethod !== 'password'
        ? decrypt(staged.secretEncrypted)
        : null;
    const password = staged.passwordEncrypted ? decrypt(staged.passwordEncrypted) : null;
    const passphrase = staged.passphraseEncrypted ? decrypt(staged.passphraseEncrypted) : null;
    if (!privateKey && !password) return;

    let sshKeyId = null;
    if (privateKey) {
      const { key: created } = await keystoreService.importKey(
        orgId,
        { name, description: `Imported by bulk import job ${job.id}`, privateKey, passphrase },
        job.actorId || null
      );
      sshKeyId = created.id;
    }

    const authType = privateKey && password ? 'key_password' : privateKey ? 'key' : 'password';
    const { credential } = await keystoreService.createCredential(
      orgId,
      {
        name,
        description: `Imported by bulk import job ${job.id}`,
        username,
        authType,
        password: password || undefined,
        sshKeyId,
        tags: ['imported'],
      },
      job.actorId || null
    );
    credentialId = credential.id;
  }

  cache.identities.set(key, credentialId);
  // Bind it, without touching authMode — see the note above.
  await prisma.server.update({ where: { id: server.id }, data: { credentialId } });
}

/**
 * Encrypt + persist a server's bootstrap credential at UPLOAD time (status
 * 'staged'). Linked to the server at commit; deleted if the row is skipped.
 */
async function stageCredentialAtUpload(jobId, raw, files) {
  const hostname = str(raw.hostname);
  if (!hostname) return;

  // `onboard=false` → import into inventory only, do not stage credentials or
  // run onboarding. The server can be onboarded later from Server Details.
  const onboard = str(raw.onboard).trim().toLowerCase();
  if (onboard && ['false', 'no', '0', 'n', 'off'].includes(onboard)) return;

  const password = str(raw.password);
  const passphrase = str(raw.passphrase || raw.keyPassphrase);
  let privateKey = raw.privateKey || raw.sshPrivateKey || '';
  const keyFile = str(raw.keyFile);
  if (!privateKey && keyFile && files) {
    const buf = resolveFile(files, keyFile);
    if (buf) privateKey = buf.toString('utf8');
  }
  const sudoPassword = str(raw.sudoPassword);
  if (!password && !privateKey) return; // nothing to onboard with

  // Store key and password independently so a host that needs BOTH (or a
  // passphrase-protected key) can be onboarded.
  const authMethod = privateKey && password ? 'key+password' : privateKey ? 'key' : 'password';
  const ttlMs = 6 * 60 * 60 * 1000; // 6h to complete onboarding

  // Opt-in, per row: keep this secret as a reusable Keystore identity rather
  // than wiping it when onboarding finishes. Default stays off — an import
  // must not quietly turn one-shot bootstrap material into stored access.
  const storeAsIdentity = bool(raw.storeAsIdentity ?? raw.saveAsIdentity);
  const identityName = str(raw.identityName);

  await prisma.onboardingCredential.create({
    data: {
      jobId,
      serverRef: hostname,
      serverId: null,
      sshUser: str(raw.sshUser) || 'root',
      authMethod,
      storeAsIdentity,
      identityName: identityName || null,
      secretEncrypted: privateKey ? encrypt(String(privateKey)) : null,
      passwordEncrypted: password ? encrypt(password) : null,
      passphraseEncrypted: passphrase ? encrypt(passphrase) : null,
      sudoPasswordEncrypted: sudoPassword ? encrypt(sudoPassword) : null,
      status: 'staged',
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
}

async function commitPolicy(orgId, row, raw, overwrite, cache) {
  const name = str(raw.name);
  const subjects = [];
  for (const g of list(raw.subjectGroups)) {
    const id = cache.groups.get(lower(g)) || (await prisma.group.findFirst({ where: { orgId, name: g } }))?.id;
    if (id) subjects.push({ subjectType: 'GROUP', subjectId: id });
  }
  for (const r of list(raw.subjectRoles)) {
    const role = await resolveRole(orgId, r);
    if (!role) throw new Error(`Unknown role "${r}" in subjectRoles`);
    subjects.push({ subjectType: 'ROLE', subjectId: role.key });
  }
  for (const e of list(raw.subjectUsers)) {
    const id = cache.users.get(lower(e)) || (await prisma.user.findFirst({ where: { orgId, email: lower(e) } }))?.id;
    if (id) subjects.push({ subjectType: 'USER', subjectId: id });
  }

  const approverGroupName = str(raw.approverGroup);
  const approverGroupId = approverGroupName
    ? cache.groups.get(lower(approverGroupName)) ||
      (await prisma.group.findFirst({ where: { orgId, name: approverGroupName } }))?.id ||
      null
    : null;

  const data = {
    name,
    description: str(raw.description) || undefined,
    effect: (str(raw.effect) || 'ALLOW').toUpperCase(),
    targetEnvironments: list(raw.targetEnvironments).map(lower),
    allowedPrincipals: list(raw.allowedPrincipals),
    maxSessionDuration: int(raw.maxSessionDuration, 3600),
    requireApproval: bool(raw.requireApproval),
    autoApprove: bool(raw.autoApprove),
    priority: int(raw.priority, 100),
    allowKeyDownload: bool(raw.allowKeyDownload),
    approverGroupId,
    approverRoles: await Promise.all(
      list(raw.approverRoles).map(async (r) => {
        const role = await resolveRole(orgId, r);
        if (!role) throw new Error(`Unknown role "${r}" in approverRoles`);
        return role.key;
      })
    ),
    subjects,
  };

  const existing = await prisma.accessPolicy.findFirst({ where: { orgId, name } });
  let policy;
  if (existing && overwrite) {
    policy = await policyService.update(orgId, existing.id, data);
  } else if (!existing) {
    policy = await policyService.create(orgId, data);
  } else {
    policy = existing;
  }
  await markRow(row.id, { resultId: policy.id });
}

async function commitMembership(orgId, row, raw, actorId, cache) {
  const groupName = str(raw.group || raw.groupName);
  const email = lower(raw.user || raw.email);
  const groupId = cache.groups.get(lower(groupName)) ||
    (await prisma.group.findFirst({ where: { orgId, name: groupName } }))?.id;
  const userId = cache.users.get(email) ||
    (await prisma.user.findFirst({ where: { orgId, email } }))?.id;
  if (!groupId) throw new Error(`Group "${groupName}" not found`);
  if (!userId) throw new Error(`User "${email}" not found`);
  await groupService.addMember(orgId, groupId, userId, actorId).catch((err) => {
    // Already a member is fine (idempotent).
    if (!/already/i.test(err.message)) throw err;
  });
}

// --- public: read -----------------------------------------------------------

export async function getJob(orgId, jobId) {
  const job = await prisma.importJob.findFirst({ where: { id: jobId, orgId } });
  if (!job) return null;
  const rows = await prisma.importRow.findMany({
    where: { jobId },
    orderBy: [{ entity: 'asc' }, { rowIndex: 'asc' }],
  });
  const onboarding = await prisma.onboardingCredential.findMany({
    where: { jobId },
    select: { id: true, serverRef: true, status: true, attempts: true },
  });
  return { job, rows, onboarding };
}

export default { createImportJob, setDecisions, commitImportJob, getJob };
