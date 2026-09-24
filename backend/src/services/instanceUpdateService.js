/**
 * instanceUpdateService.js — requesting that this installation be upgraded.
 *
 * The important sentence: **nothing here upgrades anything.** It records an
 * intent and reports what a host-side helper did with it.
 *
 * Why it is shaped this way. A container cannot reliably replace itself, and
 * the two obvious workarounds both end in the same place: mounting the Docker
 * socket into the app, or giving the app a shell on its host, each hand the
 * web application root on the machine that holds the SSH CA. For a product
 * whose pitch is the elimination of standing privilege, that is not a trade
 * worth making for the convenience of a button.
 *
 * So the privileged half is a short script an operator installs deliberately
 * (`scripts/shellius-self-update.sh`), which polls this API and runs the
 * existing `update-shellius.sh`. If nobody installs it, requests sit here
 * unclaimed and the UI shows the command to run by hand — which is the
 * default, and a perfectly good end state.
 *
 * The one control that matters beyond that: **a request cannot move the
 * installation backwards.** If the app were compromised, the most useful
 * thing an attacker could do with this endpoint is ask for a downgrade to a
 * published release with a known vulnerability. Both this service and the
 * helper refuse that independently.
 */

import { createRequire } from 'module';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { compareVersions, isNewer } from './updateCheckService.js';

const require = createRequire(import.meta.url);
const { version: CURRENT_VERSION } = require('../../package.json');

const SCOPE = 'global';

/** A helper that has not checked in for this long is treated as absent. */
export const HELPER_STALE_MS = Number(process.env.UPDATE_HELPER_STALE_MS || 15 * 60 * 1000);

/** Statuses that mean "still in flight". */
const OPEN = ['requested', 'claimed', 'running'];

/** Plain semver, optionally v-prefixed. Nothing else is a version. */
export function normalizeVersion(input) {
  const raw = String(input ?? '').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw)) {
    throw new ApiError(400, 'Version must be plain semver, for example 2.1.0');
  }
  return raw;
}

/** The request currently in flight, if any. */
export async function pending() {
  return prisma.instanceUpdateRequest.findFirst({
    where: { status: { in: OPEN } },
    orderBy: { requestedAt: 'desc' },
  });
}

export async function helperState() {
  const row = await prisma.instanceUpdateHelper.findUnique({ where: { scope: SCOPE } });
  if (!row?.lastSeenAt) return { present: false, lastSeenAt: null, helperVersion: null, hostname: null };
  const fresh = Date.now() - row.lastSeenAt.getTime() < HELPER_STALE_MS;
  return {
    present: fresh,
    lastSeenAt: row.lastSeenAt,
    helperVersion: row.helperVersion,
    hostname: row.hostname,
    // A helper that was installed and has gone quiet is a different thing
    // from one that was never installed, and the difference matters when a
    // request is sitting unclaimed.
    stale: !fresh,
  };
}

/**
 * Record that the helper is alive. Called on every poll.
 *
 * Deliberately an upsert on a fixed scope rather than an append: this is a
 * liveness fact, not a log, and a helper polling every minute would otherwise
 * write half a million rows a year.
 */
export async function touchHelper({ helperVersion = null, hostname = null } = {}) {
  await prisma.instanceUpdateHelper.upsert({
    where: { scope: SCOPE },
    create: { scope: SCOPE, helperVersion, hostname, lastSeenAt: new Date() },
    update: { helperVersion, hostname, lastSeenAt: new Date() },
  });
}

/**
 * Ask for an upgrade.
 *
 * @param {string} targetVersion
 * @param {string|null} requestedById
 */
export async function request(targetVersion, requestedById = null) {
  const version = normalizeVersion(targetVersion);

  if (version === CURRENT_VERSION) {
    throw new ApiError(409, `This installation is already running ${version}`);
  }

  // The downgrade refusal. An upgrade request is the only thing this endpoint
  // can express; moving the installation back to an older published release
  // is not an upgrade, and it is the most useful thing a compromised app
  // could ask for. The helper refuses it too, independently.
  if (!isNewer(version, CURRENT_VERSION)) {
    const cmp = compareVersions(version, CURRENT_VERSION);
    throw new ApiError(
      400,
      Number.isNaN(cmp)
        ? `Cannot compare ${version} with the running version (${CURRENT_VERSION}); request refused`
        : `${version} is older than the running version (${CURRENT_VERSION}). Downgrades are not requestable — roll back on the host with ./update-shellius.sh --rollback.`
    );
  }

  const existing = await pending();
  if (existing) {
    throw new ApiError(409, `An update to ${existing.targetVersion} is already ${existing.status}`);
  }

  const row = await prisma.instanceUpdateRequest.create({
    data: { targetVersion: version, fromVersion: CURRENT_VERSION, requestedById, status: 'requested' },
  });
  logger.info('instanceUpdate: upgrade requested', {
    from: CURRENT_VERSION,
    to: version,
    requestedById,
  });
  return row;
}

/**
 * The helper claims the pending request.
 *
 * `updateMany` on the id AND the expected status, so two helpers (or one
 * helper whose previous run is still finishing) cannot both claim it and
 * start two upgrades on the same host.
 */
export async function claim(requestId) {
  const { count } = await prisma.instanceUpdateRequest.updateMany({
    where: { id: requestId, status: 'requested' },
    data: { status: 'claimed', claimedAt: new Date() },
  });
  if (count === 0) return null;
  return prisma.instanceUpdateRequest.findUnique({ where: { id: requestId } });
}

const TERMINAL = ['succeeded', 'failed', 'cancelled'];

/** The helper reports progress or an outcome. */
export async function reportStatus(requestId, status, detail = null) {
  if (!['running', ...TERMINAL].includes(status)) {
    throw new ApiError(400, `Unknown status '${status}'`);
  }
  const row = await prisma.instanceUpdateRequest.findUnique({ where: { id: requestId } });
  if (!row) throw new ApiError(404, 'Update request not found');
  if (TERMINAL.includes(row.status)) {
    // A helper retrying after a network blip must not reopen a finished
    // request, and must not overwrite "succeeded" with a stale "running".
    return row;
  }
  return prisma.instanceUpdateRequest.update({
    where: { id: requestId },
    data: {
      status,
      detail: detail ? String(detail).slice(0, 4000) : row.detail,
      ...(TERMINAL.includes(status) ? { finishedAt: new Date() } : {}),
    },
  });
}

/** Withdraw a request that has not been claimed yet. */
export async function cancel(requestId, detail = 'Cancelled') {
  const { count } = await prisma.instanceUpdateRequest.updateMany({
    // Only before a helper has taken it: once the upgrade is under way,
    // "cancel" in the database would be a lie about what the host is doing.
    where: { id: requestId, status: 'requested' },
    data: { status: 'cancelled', detail, finishedAt: new Date() },
  });
  if (count === 0) {
    throw new ApiError(409, 'That request has already been picked up and cannot be cancelled here');
  }
  return prisma.instanceUpdateRequest.findUnique({ where: { id: requestId } });
}

/** Everything the Updates screen needs about self-update, in one call. */
export async function status() {
  const [current, helper, history] = await Promise.all([
    pending(),
    helperState(),
    prisma.instanceUpdateRequest.findMany({ orderBy: { requestedAt: 'desc' }, take: 5 }),
  ]);
  return { currentVersion: CURRENT_VERSION, pending: current, helper, history };
}

export default {
  HELPER_STALE_MS,
  normalizeVersion,
  pending,
  helperState,
  touchHelper,
  request,
  claim,
  reportStatus,
  cancel,
  status,
};
