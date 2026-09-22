/**
 * directorySyncService.js — reconciling Shellius accounts against the IdP.
 *
 * This is the only code in Shellius that can disable a person's account
 * without a human deciding to, so it is written to be timid. The governing
 * idea is a single distinction:
 *
 *     "the directory says this person has left"
 *   is not the same as
 *     "I could not find this person in the directory".
 *
 * Almost every way this feature could hurt someone is a case of the second
 * being mistaken for the first — an expired client secret, a paging bug, a
 * changed tenant, an identifier that never matched in the first place. So the
 * run aborts rather than acts whenever what it read looks untrustworthy, and
 * when it does act it acts on the smallest defensible set.
 *
 * The valves, in the order they apply:
 *
 *   1. The credential is TESTED before the directory is even listed. A run
 *      that cannot authenticate never reaches the part that suspends people.
 *   2. An empty directory aborts. Nobody works at a company with no staff.
 *   3. A directory that has shrunk by more than half since the last good run
 *      aborts. Real attrition does not look like that; broken paging does.
 *   4. A user is only ever judged through a UserIdentity belonging to THIS
 *      config. Local accounts and other providers' users are invisible here.
 *   5. A user whose directory id we do not know is never judged. Null is not
 *      absence — see externalId.js for why Entra makes this essential.
 *   6. A user who still has an identity with another ACTIVE provider is left
 *      alone; they can still legitimately sign in.
 *   7. Absence must persist for `graceHours` before anything happens, so one
 *      bad read cannot suspend anyone even if it slips past the valves above.
 *   8. The run aborts if the number of candidates exceeds either
 *      `maxSuspendPercent` of active users or `maxSuspendCount` outright.
 *   9. The last active super admin is never suspended.
 *  10. `dryRun` is on by default and turning it off is a deliberate act.
 *
 * Findings survive between runs, which is what makes the grace period real
 * and what lets the UI show "missing since Tuesday" rather than a number.
 */

import prisma from '../../config/db.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { encrypt, decrypt } from '../../utils/crypto.js';
import { ACTIONS, log as auditLog } from '../auditService.js';
import * as notificationService from '../notificationService.js';
import { revokeAllAccessFor } from '../userService.js';
import { usersWithPermission } from '../roleService.js';
import { getAdapter, ADAPTER_TYPES, adapterForConfig, describeAdapters } from './adapters/index.js';

const RESOURCE = 'DirectorySync';
const HOUR_MS = 60 * 60 * 1000;

/** A directory that lost more than this fraction since the last good run is not believed. */
export const MAX_SHRINK_RATIO = 0.5;

export const ACTIONS_ALLOWED = ['flag', 'suspend'];

/**
 * Below this many candidates the percentage limit is not applied.
 *
 * A percentage is meaningless for a handful of people: in a five-person team
 * one leaver is 20% of the company, so a 10% limit would block every genuine
 * deprovision they ever needed. The absolute count limit still applies, and it
 * is the one doing the work at this scale. The percentage exists to catch the
 * shape of a run that has gone wrong across a whole org, which cannot happen
 * with one or two people.
 */
export const PERCENT_FLOOR_CANDIDATES = 2;

// ---------------------------------------------------------------------------
// Config encryption and masking — same rules as the audit sinks
// ---------------------------------------------------------------------------

function decryptConfig(row) {
  if (!row?.configEncrypted) return {};
  try {
    return JSON.parse(decrypt(row.configEncrypted));
  } catch (err) {
    logger.error('directorySync: could not decrypt config', { syncId: row.id, error: err.message });
    return {};
  }
}

const encryptConfig = (config) => encrypt(JSON.stringify(config ?? {}));

/** Keep any secret the caller did not resend, so "save" never wipes one. */
export function mergeConfig(adapterType, stored, incoming) {
  const adapter = getAdapter(adapterType);
  const merged = { ...stored, ...(incoming || {}) };
  for (const field of adapter.secretFields) {
    const given = incoming?.[field];
    if (given === undefined || given === null || given === '') {
      if (stored?.[field] !== undefined) merged[field] = stored[field];
      else delete merged[field];
    }
  }
  return merged;
}

export function toPublic(row, config = null) {
  if (!row) return row;
  const adapter = ADAPTER_TYPES.includes(row.adapter) ? getAdapter(row.adapter) : null;
  const cfg = config ?? decryptConfig(row);

  const publicConfig = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (adapter?.secretFields.includes(k)) continue;
    publicConfig[k] = v;
  }
  for (const k of adapter?.secretFields ?? []) publicConfig[k] = { set: !!cfg[k] };

  return {
    id: row.id,
    orgId: row.orgId,
    ssoConfigId: row.ssoConfigId,
    adapter: row.adapter,
    adapterLabel: adapter?.label ?? row.adapter,
    reportsDisabled: adapter?.reportsDisabled ?? false,
    isActive: row.isActive,
    action: row.action,
    dryRun: row.dryRun,
    intervalHours: row.intervalHours,
    maxSuspendPercent: row.maxSuspendPercent,
    maxSuspendCount: row.maxSuspendCount,
    graceHours: row.graceHours,
    lastRunAt: row.lastRunAt,
    lastRunStatus: row.lastRunStatus,
    lastError: row.lastError,
    config: publicConfig,
    ssoConfig: row.ssoConfig
      ? { id: row.ssoConfig.id, name: row.ssoConfig.name, provider: row.ssoConfig.provider, presetId: row.ssoConfig.presetId, isActive: row.ssoConfig.isActive }
      : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export const listAdapters = () => describeAdapters();

/**
 * What directory sync is available for each of this org's sign-in providers.
 * A provider with no adapter is reported explicitly, so the UI can say why
 * rather than simply not offering the option.
 */
export async function listForOrg(orgId) {
  const configs = await prisma.ssoConfig.findMany({
    where: { orgId },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    include: { directorySync: true },
  });

  return configs.map((cfg) => {
    const supported = adapterForConfig(cfg);
    return {
      ssoConfigId: cfg.id,
      name: cfg.name,
      provider: cfg.provider,
      presetId: cfg.presetId,
      isActive: cfg.isActive,
      supportedAdapter: supported,
      unsupportedReason: supported
        ? null
        : 'This provider has no directory API Shellius can read, so accounts here cannot be reconciled automatically.',
      sync: cfg.directorySync ? toPublic({ ...cfg.directorySync, ssoConfig: cfg }) : null,
    };
  });
}

export async function get(orgId, id) {
  const row = await prisma.directorySync.findFirst({ where: { id, orgId }, include: { ssoConfig: true } });
  if (!row) throw new ApiError(404, 'Directory sync not found');
  return row;
}

function normalizeSettings(data) {
  const out = {};
  if (data.isActive !== undefined) out.isActive = !!data.isActive;
  if (data.dryRun !== undefined) out.dryRun = !!data.dryRun;
  if (data.action !== undefined) {
    if (!ACTIONS_ALLOWED.includes(data.action)) throw new ApiError(400, "action must be 'flag' or 'suspend'");
    out.action = data.action;
  }
  if (data.intervalHours !== undefined) {
    const h = Number(data.intervalHours);
    if (!Number.isInteger(h) || h < 1 || h > 168) throw new ApiError(400, 'Interval must be between 1 and 168 hours');
    out.intervalHours = h;
  }
  if (data.maxSuspendPercent !== undefined) {
    const p = Number(data.maxSuspendPercent);
    if (!Number.isInteger(p) || p < 1 || p > 100) throw new ApiError(400, 'The percentage limit must be between 1 and 100');
    out.maxSuspendPercent = p;
  }
  if (data.maxSuspendCount !== undefined) {
    const c = Number(data.maxSuspendCount);
    if (!Number.isInteger(c) || c < 1 || c > 10_000) throw new ApiError(400, 'The count limit must be between 1 and 10000');
    out.maxSuspendCount = c;
  }
  if (data.graceHours !== undefined) {
    const g = Number(data.graceHours);
    if (!Number.isInteger(g) || g < 0 || g > 720) throw new ApiError(400, 'The grace period must be between 0 and 720 hours');
    out.graceHours = g;
  }
  return out;
}

export async function create(orgId, data, actor = null) {
  const ssoConfig = await prisma.ssoConfig.findFirst({ where: { id: data.ssoConfigId, orgId } });
  if (!ssoConfig) throw new ApiError(404, 'Sign-in provider not found');

  const expected = adapterForConfig(ssoConfig);
  if (!expected) {
    throw new ApiError(400, `Directory sync is not available for ${ssoConfig.name} — this provider has no directory API Shellius can read`);
  }
  const adapterType = data.adapter || expected;
  if (adapterType !== expected) {
    throw new ApiError(400, `${ssoConfig.name} must use the '${expected}' directory adapter`);
  }

  const adapter = getAdapter(adapterType);
  const config = adapter.validateConfig(data.config || {});

  const row = await prisma.directorySync.create({
    data: {
      orgId,
      ssoConfigId: ssoConfig.id,
      adapter: adapterType,
      configEncrypted: encryptConfig(config),
      createdById: actor?.userId ?? null,
      ...normalizeSettings(data),
    },
    include: { ssoConfig: true },
  });

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.directory_sync.create,
    resourceType: RESOURCE,
    resourceId: row.id,
    metadata: { adapter: adapterType, provider: ssoConfig.name, action: row.action, dryRun: row.dryRun },
  });

  return row;
}

export async function update(orgId, id, data, actor = null) {
  const existing = await get(orgId, id);
  const patch = normalizeSettings(data);

  if (data.config !== undefined) {
    const adapter = getAdapter(existing.adapter);
    const merged = mergeConfig(existing.adapter, decryptConfig(existing), data.config);
    patch.configEncrypted = encryptConfig(adapter.validateConfig(merged));
    // A changed credential invalidates the last test result: it must be
    // proven again before a run is allowed to act on what it returns.
    patch.lastError = null;
  }

  const row = await prisma.directorySync.update({ where: { id }, data: patch, include: { ssoConfig: true } });

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.directory_sync.update,
    resourceType: RESOURCE,
    resourceId: id,
    metadata: {
      fields: Object.keys(patch),
      action: row.action,
      dryRun: row.dryRun,
      isActive: row.isActive,
      // The transition that deserves to be findable later.
      ...(existing.dryRun && !row.dryRun ? { armed: true } : {}),
    },
  });

  return row;
}

export async function remove(orgId, id, actor = null) {
  const existing = await get(orgId, id);
  await prisma.directorySync.delete({ where: { id } });
  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.directory_sync.delete,
    resourceType: RESOURCE,
    resourceId: id,
    metadata: { adapter: existing.adapter },
  });
  return { id };
}

/** Prove the credential works, and say so on the row. */
export async function test(orgId, id, actor = null) {
  const row = await get(orgId, id);
  const adapter = getAdapter(row.adapter);
  try {
    const result = await adapter.test(decryptConfig(row));
    await prisma.directorySync.update({ where: { id }, data: { lastError: null } });
    await auditLog({
      orgId,
      actorId: actor?.userId ?? null,
      action: ACTIONS.directory_sync.test,
      resourceType: RESOURCE,
      resourceId: id,
      metadata: { ok: true, adapter: row.adapter },
    });
    return { ok: true, detail: result?.detail ?? 'Connected' };
  } catch (err) {
    await prisma.directorySync.update({ where: { id }, data: { lastError: err.message?.slice(0, 2000) ?? null } });
    await auditLog({
      orgId,
      actorId: actor?.userId ?? null,
      action: ACTIONS.directory_sync.test,
      resourceType: RESOURCE,
      resourceId: id,
      metadata: { ok: false, adapter: row.adapter, error: err.message?.slice(0, 500) },
    });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Everything a run decided, written whether it acted or not. */
async function finishRun(row, run, patch, { orgId }) {
  const finishedAt = new Date();
  const saved = await prisma.directorySyncRun.update({
    where: { id: run.id },
    data: { ...patch, finishedAt, durationMs: finishedAt.getTime() - run.startedAt.getTime() },
  });
  await prisma.directorySync.update({
    where: { id: row.id },
    data: {
      lastRunAt: finishedAt,
      lastRunStatus: saved.status,
      lastError: saved.status === 'ok' ? null : (saved.abortReason || saved.error || null)?.slice(0, 2000) ?? null,
    },
  });
  logger.info('directorySync: run finished', {
    orgId,
    syncId: row.id,
    status: saved.status,
    candidates: saved.candidates,
    suspended: saved.suspended,
  });
  return saved;
}

/**
 * Tell the people who can do something about it — which is the people who
 * hold the permission that gates this feature, not a hardcoded list of role
 * names. A custom role with `settings.sso` gets told too.
 */
async function notifyAdmins(orgId, { title, body, metadata }) {
  const admins = await usersWithPermission(orgId, 'settings.sso');
  for (const admin of admins) {
    await notificationService.create({
      orgId,
      userId: admin.id,
      type: 'DIRECTORY_SYNC',
      title,
      body,
      metadata,
    });
  }
}

/**
 * Run one reconciliation.
 *
 * @param {object} row - the DirectorySync row
 * @param {object} [ctx]
 * @param {object} [ctx.adapter] - overrides the registry. The injection seam
 *   that lets the tests drive a directory without a live IdP; ESM namespace
 *   objects are frozen, so there is no monkey-patching a module here.
 * @param {boolean} [ctx.force] - run even when the row is inactive (the
 *   "Run now" button), still honouring dryRun and every safety valve.
 */
export async function runSync(row, ctx = {}) {
  const { orgId } = row;
  const adapter = ctx.adapter ?? getAdapter(row.adapter);
  const run = await prisma.directorySyncRun.create({
    data: { orgId, syncId: row.id, status: 'running', dryRun: row.dryRun },
  });

  const abort = async (reason, extra = {}) => {
    await auditLog({
      orgId,
      action: ACTIONS.directory_sync.aborted,
      resourceType: RESOURCE,
      resourceId: row.id,
      metadata: { reason, ...extra },
    });
    await notifyAdmins(orgId, {
      title: 'Directory sync stopped without making changes',
      body: reason,
      metadata: { syncId: row.id, runId: run.id, ...extra },
    });
    return finishRun(row, run, { status: 'aborted', abortReason: reason, ...extra }, { orgId });
  };

  let entries;
  try {
    const config = decryptConfig(row);

    // Valve 1. Authenticate before listing. A run that cannot prove its
    // credential must never reach the code that acts on an empty answer.
    await adapter.test(config);
    entries = await adapter.listUsers(config);
  } catch (err) {
    logger.warn('directorySync: could not read the directory', { orgId, syncId: row.id, error: err.message });
    await auditLog({
      orgId,
      action: ACTIONS.directory_sync.failed,
      resourceType: RESOURCE,
      resourceId: row.id,
      metadata: { error: err.message?.slice(0, 500) },
    });
    await notifyAdmins(orgId, {
      title: 'Directory sync could not reach the directory',
      body: `${err.message}. No accounts were changed.`,
      metadata: { syncId: row.id, runId: run.id },
    });
    return finishRun(row, run, { status: 'failed', error: err.message?.slice(0, 2000) ?? null }, { orgId });
  }

  // Valve 2. An empty directory is never the truth.
  if (!entries.length) {
    return abort('The directory returned no users at all, which is never a real answer. Nothing was changed.');
  }

  // Valve 3. A directory that halved since the last good run is not believed.
  const lastGood = await prisma.directorySyncRun.findFirst({
    where: { syncId: row.id, status: 'ok', directoryCount: { gt: 0 } },
    orderBy: { startedAt: 'desc' },
    select: { directoryCount: true, startedAt: true },
  });
  if (lastGood && entries.length < lastGood.directoryCount * MAX_SHRINK_RATIO) {
    return abort(
      `The directory returned ${entries.length} users, down from ${lastGood.directoryCount} on the last successful run. ` +
        'A drop that large is far more often a paging or permission problem than real attrition, so nothing was changed.',
      { directoryCount: entries.length }
    );
  }

  const byExternalId = new Map();
  const byEmail = new Map();
  for (const e of entries) {
    if (e.externalId) byExternalId.set(String(e.externalId), e);
    if (e.email) byEmail.set(String(e.email).toLowerCase(), e);
  }
  // GitHub gives no emails. Where a directory carries none, an identity with
  // no known directory id simply cannot be judged.
  const directoryHasEmails = byEmail.size > 0;

  const identities = await prisma.userIdentity.findMany({
    where: { ssoConfigId: row.ssoConfigId, orgId },
    include: {
      user: {
        select: { id: true, email: true, name: true, role: true, status: true, kind: true, deletedAt: true },
      },
    },
  });

  // Valve 6 needs to know who else could still let these people in.
  const otherActiveConfigIds = (
    await prisma.ssoConfig.findMany({
      where: { orgId, isActive: true, id: { not: row.ssoConfigId } },
      select: { id: true },
    })
  ).map((c) => c.id);
  const alsoElsewhere = otherActiveConfigIds.length
    ? new Set(
        (
          await prisma.userIdentity.findMany({
            where: { orgId, ssoConfigId: { in: otherActiveConfigIds } },
            select: { userId: true },
          })
        ).map((i) => i.userId)
      )
    : new Set();

  let matchedByExternalId = 0;
  let matchedByEmail = 0;
  let unknownIdentities = 0;
  const candidates = [];
  const stillPresent = [];

  for (const identity of identities) {
    const user = identity.user;
    // Valve 4/5 territory: only active humans, judged only through this config.
    if (!user || user.deletedAt || user.status !== 'active' || user.kind !== 'human') continue;

    const email = identity.email ? String(identity.email).toLowerCase() : null;
    let entry = null;
    if (identity.externalId && byExternalId.has(identity.externalId)) {
      entry = byExternalId.get(identity.externalId);
      matchedByExternalId += 1;
    } else if (email && byEmail.has(email)) {
      entry = byEmail.get(email);
      matchedByEmail += 1;
    }

    if (entry) {
      if (entry.enabled === false && adapter.reportsDisabled) {
        candidates.push({ identity, user, reason: 'disabled' });
      } else {
        stillPresent.push(user.id);
      }
      continue;
    }

    // Valve 5. No directory id, and nothing to match on: this is "I cannot
    // tell", not "they have gone".
    if (!identity.externalId && (!directoryHasEmails || !email)) {
      unknownIdentities += 1;
      continue;
    }
    candidates.push({ identity, user, reason: 'missing' });
  }

  // People who turned up again close their open findings, which is what makes
  // the grace period forgiving rather than merely slow.
  if (stillPresent.length) {
    const reopened = await prisma.directorySyncFinding.updateMany({
      where: { syncId: row.id, userId: { in: stillPresent }, status: 'open' },
      data: { status: 'resolved', resolvedAt: new Date() },
    });
    if (reopened.count) {
      await auditLog({
        orgId,
        action: ACTIONS.directory_sync.resolved,
        resourceType: RESOURCE,
        resourceId: row.id,
        metadata: { count: reopened.count },
      });
    }
  }

  const now = new Date();
  const findings = [];
  for (const c of candidates) {
    const finding = await prisma.directorySyncFinding.upsert({
      where: { syncId_userId: { syncId: row.id, userId: c.user.id } },
      // firstSeenAt is deliberately not touched: it is the clock the grace
      // period runs on, and resetting it would make the period unreachable.
      update: { lastSeenAt: now, runId: run.id, reason: c.reason, status: 'open', resolvedAt: null },
      create: { orgId, syncId: row.id, runId: run.id, userId: c.user.id, reason: c.reason, status: 'open' },
    });
    findings.push({ ...c, finding });
  }

  const counters = {
    directoryCount: entries.length,
    matchedByExternalId,
    matchedByEmail,
    unknownIdentities,
    candidates: candidates.length,
  };

  // Valve 8. Two limits, because a percentage alone is useless in a small org
  // and a count alone is useless in a large one.
  const activeUsers = await prisma.user.count({
    where: { orgId, status: 'active', deletedAt: null, kind: 'human' },
  });
  const percent = activeUsers ? Math.round((candidates.length / activeUsers) * 100) : 0;
  if (candidates.length > row.maxSuspendCount) {
    return abort(
      `${candidates.length} accounts look absent from the directory, more than the limit of ${row.maxSuspendCount}. ` +
        'Nothing was changed — review the findings before raising the limit.',
      counters
    );
  }
  if (candidates.length > PERCENT_FLOOR_CANDIDATES && percent > row.maxSuspendPercent) {
    return abort(
      `${candidates.length} of ${activeUsers} active accounts (${percent}%) look absent from the directory, over the ${row.maxSuspendPercent}% limit. ` +
        'Nothing was changed.',
      counters
    );
  }

  // Valve 7. Only findings that have persisted past the grace period are
  // eligible, and even then only when the sync is armed.
  // `firstSeenAt` is set by the database, so it can sit a few milliseconds
  // AFTER the `now` this run captured. With no grace period configured that
  // difference alone would make every finding ineligible forever, so "no
  // grace" is handled as what it means — act on this pass — rather than as a
  // comparison against a clock that is not ours.
  const graceCutoff = new Date(Date.now() - row.graceHours * HOUR_MS);
  const eligible = new Set(
    findings
      .filter((f) => row.graceHours === 0 || f.finding.firstSeenAt <= graceCutoff)
      .map((f) => f.finding.id)
  );

  let flagged = 0;
  let suspended = 0;
  let skipped = 0;

  for (const item of findings) {
    if (!eligible.has(item.finding.id)) {
      flagged += 1;
      continue;
    }

    // Valve 6. Still reachable through another live provider.
    if (alsoElsewhere.has(item.user.id)) {
      skipped += 1;
      await prisma.directorySyncFinding.update({
        where: { id: item.finding.id },
        data: { status: 'ignored', outcome: 'Still has a linked identity with another active sign-in provider' },
      });
      continue;
    }

    const willAct = row.action === 'suspend' && !row.dryRun;
    if (!willAct) {
      flagged += 1;
      await auditLog({
        orgId,
        action: ACTIONS.directory_sync.flagged,
        resourceType: 'User',
        resourceId: item.user.id,
        metadata: {
          syncId: row.id,
          reason: item.reason,
          wouldSuspend: row.action === 'suspend',
          dryRun: row.dryRun,
          firstSeenAt: item.finding.firstSeenAt.toISOString(),
        },
      });
      continue;
    }

    // Valve 9. Never the last active super admin — the same rule the Users
    // screen enforces, applied here because a job has nobody to ask.
    if (item.user.role === 'super_admin') {
      const others = await prisma.user.count({
        where: { orgId, role: 'super_admin', status: 'active', deletedAt: null, NOT: { id: item.user.id } },
      });
      if (others === 0) {
        skipped += 1;
        await prisma.directorySyncFinding.update({
          where: { id: item.finding.id },
          data: { status: 'open', outcome: 'Not suspended: this is the last active super admin' },
        });
        await auditLog({
          orgId,
          action: ACTIONS.directory_sync.skipped,
          resourceType: 'User',
          resourceId: item.user.id,
          metadata: { syncId: row.id, reason: 'last super admin' },
        });
        continue;
      }
    }

    await prisma.user.update({ where: { id: item.user.id }, data: { status: 'suspended' } });
    const cascade = await revokeAllAccessFor(orgId, item.user.id, {
      reason: 'Account deprovisioned by directory sync',
      sessionReason: 'directory_sync_deprovisioned',
    });
    suspended += 1;
    await prisma.directorySyncFinding.update({
      where: { id: item.finding.id },
      data: { status: 'acted', actedAt: new Date(), outcome: 'Suspended and all access revoked' },
    });
    await auditLog({
      orgId,
      action: ACTIONS.directory_sync.deprovisioned,
      resourceType: 'User',
      resourceId: item.user.id,
      metadata: {
        syncId: row.id,
        reason: item.reason,
        firstSeenAt: item.finding.firstSeenAt.toISOString(),
        revoked: cascade,
      },
    });
  }

  const saved = await finishRun(row, run, { status: 'ok', ...counters, flagged, suspended, skipped }, { orgId });

  await auditLog({
    orgId,
    action: ACTIONS.directory_sync.run,
    resourceType: RESOURCE,
    resourceId: row.id,
    metadata: { runId: run.id, dryRun: row.dryRun, action: row.action, ...counters, flagged, suspended, skipped },
  });

  if (candidates.length) {
    const verb = suspended ? `${suspended} suspended` : `${flagged} flagged`;
    await notifyAdmins(orgId, {
      title: `Directory sync found ${candidates.length} account(s) no longer in the directory`,
      body:
        `${verb}${row.dryRun ? ' (dry run — nothing was changed)' : ''}. ` +
        (unknownIdentities ? `${unknownIdentities} account(s) could not be checked because their directory id is not known yet. ` : '') +
        'Review them on the Sign-in settings screen.',
      metadata: { syncId: row.id, runId: run.id, candidates: candidates.length, suspended, flagged },
    });
  }

  return saved;
}

/** Findings for the UI, newest trouble first. */
export async function listFindings(orgId, syncId, { status = 'open', limit = 100 } = {}) {
  return prisma.directorySyncFinding.findMany({
    where: { orgId, syncId, ...(status === 'all' ? {} : { status }) },
    orderBy: { firstSeenAt: 'asc' },
    take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    include: { user: { select: { id: true, name: true, email: true, role: true, status: true } } },
  });
}

export async function listRuns(orgId, syncId, { limit = 20 } = {}) {
  await get(orgId, syncId);
  return prisma.directorySyncRun.findMany({
    where: { orgId, syncId },
    orderBy: { startedAt: 'desc' },
    take: Math.min(Math.max(Number(limit) || 20, 1), 100),
  });
}

/** "Run now" from the UI. Honours dryRun and every valve; skips the schedule. */
export async function runNow(orgId, id, actor = null) {
  const row = await get(orgId, id);
  logger.info('directorySync: manual run', { orgId, syncId: id, actorId: actor?.userId ?? null });
  return runSync(row, { force: true });
}

export default {
  listAdapters,
  listForOrg,
  get,
  create,
  update,
  remove,
  test,
  runSync,
  runNow,
  listFindings,
  listRuns,
  mergeConfig,
  toPublic,
  MAX_SHRINK_RATIO,
  PERCENT_FLOOR_CANDIDATES,
};
