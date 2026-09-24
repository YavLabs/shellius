/**
 * collectorUpdateService.js — deciding which hosts may pull a new collector,
 * and noticing when that went wrong.
 *
 * The shape that matters: **the job decides, the endpoint serves.** A host
 * polling `GET /api/hosts/collector-update` does a single indexed lookup of
 * its own row and nothing else. Working out the cohort inside that endpoint
 * would mean a fleet-wide scan on every poll from every host, and — worse —
 * a cohort that could change between two hosts' polls, so "10% of the fleet"
 * would not be a fact anyone could state.
 *
 * Three safety properties, each of which exists because of a specific way
 * this feature could take a fleet down:
 *
 *   1. **Staged.** A rollout starts at the org's canary percent and only
 *      widens when the hosts already updated are reporting healthily on the
 *      new version. Ninety hosts pulling a broken collector at once is the
 *      failure this feature is most capable of causing.
 *   2. **Halted by evidence, not by a timer.** If hosts that took the update
 *      stop reporting, or come back still on the old version (which is what a
 *      host-side rollback looks like from here), the rollout stops and says
 *      why. It does not widen on a schedule.
 *   3. **A cohort floor of one**, so a small organization is never left at
 *      "rolling" having offered the update to nobody. With `Math.ceil` the
 *      floor is in fact redundant — ceil(2 × 0.10) is 1, not 0 — and an
 *      earlier version of this comment claimed otherwise. It is kept as a
 *      guard because the failure it prevents is silent (a rollout that runs
 *      forever and does nothing), and one edit from `ceil` to `floor` would
 *      reintroduce it.
 *
 * Nothing here can update the SSH agent or check-principals. Only the posture
 * collector, which is the piece whose failure is visible (posture goes quiet)
 * rather than catastrophic (nobody can log into anything).
 */

import crypto from 'crypto';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import * as postureSettingsService from './postureSettingsService.js';
import { latestSnapshots, classifyCollector } from './postureCollectorState.js';
import { canInstallOn } from './bulkBootstrapService.js';
import { isOlderCollector, POSTURE_COLLECTOR_VERSION } from '../utils/postureCollectorVersion.js';

/** How far a rollout widens at each healthy step. */
export const PERCENT_STEPS = [10, 25, 50, 100];

/**
 * How long a host has to come back reporting the new version before its
 * attempt is judged. Generous on purpose: the collector timer is every five
 * minutes, the updater's own timer is every fifteen, and a host that is
 * merely slow must not be counted as a failure.
 */
export const VERIFY_GRACE_MS = Number(process.env.COLLECTOR_VERIFY_GRACE_MS || 45 * 60 * 1000);

/** A rollout does not widen until the current step has settled. */
export const STEP_DWELL_MS = Number(process.env.COLLECTOR_STEP_DWELL_MS || 30 * 60 * 1000);

/**
 * Proportion of judged attempts that may fail before the rollout halts, and
 * the absolute floor below which a proportion means nothing. One failure out
 * of one host is 100%, and halting the fleet on it would make the feature
 * unusable for small organizations; two is the point at which it stops
 * looking like one unlucky host.
 */
export const MAX_FAILURE_RATE = 0.2;
export const MIN_FAILURES_TO_HALT = 2;

/**
 * A host's stable position in a rollout, 0–9999.
 *
 * Keyed on (serverId, targetVersion) so the order is fixed for the life of
 * one rollout — a canary that changed between steps would prove nothing —
 * while a different version reshuffles, so the same unlucky hosts are not
 * the canaries forever.
 */
export function bucketFor(serverId, targetVersion) {
  const h = crypto.createHash('sha256').update(`${serverId}:${targetVersion}`).digest();
  return h.readUInt16BE(0) % 10000;
}

/**
 * How many hosts a step covers. Never zero while there is anything to do.
 *
 * `Math.max(1, …)` is belt and braces rather than load-bearing: `Math.ceil`
 * already cannot return 0 once total and percent are both positive, which the
 * guards above ensure. It stays because the failure mode it covers is a
 * rollout that reports "rolling" for ever having offered the update to
 * nobody — silent, and one `ceil`→`floor` edit away.
 */
export function cohortSize(total, percent) {
  if (total <= 0) return 0;
  if (percent <= 0) return 0;
  if (percent >= 100) return total;
  return Math.max(1, Math.ceil((total * percent) / 100));
}

/**
 * Hosts that could take an update right now: eligible for the collector at
 * all, currently reporting, and on an older version.
 *
 * "Currently reporting" is load-bearing. Offering an update to a host that
 * was already silent means its continued silence gets counted as an update
 * failure, and a fleet with a few dead machines would halt every rollout.
 */
export async function candidatesFor(orgId, targetVersion) {
  const servers = await prisma.server.findMany({
    where: { orgId, isActive: true },
    select: {
      id: true,
      hostname: true,
      displayName: true,
      osType: true,
      protocol: true,
      isActive: true,
      authMode: true,
      provisionStatus: true,
      agentId: true,
      agentLastSeen: true,
      agentTokenHash: true,
      postureRejectedAt: true,
      postureInstalledAt: true,
    },
  });
  const eligible = servers.filter(canInstallOn);
  if (eligible.length === 0) return [];

  const settings = await postureSettingsService.getSettings(orgId);
  const snapshots = await latestSnapshots(orgId, eligible.map((s) => s.id));

  const out = [];
  for (const s of eligible) {
    const latest = snapshots.get(s.id);
    if (!latest) continue; // never reported — nothing to update, and no signal
    const state = classifyCollector(s, latest, settings);
    // Degraded is fine — a degraded collector is still running and reporting,
    // and is often exactly what a newer version fixes. Stale, rejected and
    // not-installed are not: there is no working collector to replace.
    if (state !== 'reporting' && state !== 'degraded') continue;
    if (!isOlderCollector(latest.agentVersion, targetVersion)) continue;
    out.push({ server: s, currentVersion: latest.agentVersion || null });
  }
  return out;
}

/**
 * The update this host should install, or null.
 *
 * One indexed lookup. Everything interesting was decided by the rollout job.
 */
export async function offerFor(serverId) {
  const attempt = await prisma.collectorUpdateAttempt.findFirst({
    where: {
      serverId,
      status: 'offered',
      rollout: { status: 'rolling' },
    },
    include: { rollout: { select: { id: true, targetVersion: true, status: true } } },
    orderBy: { offeredAt: 'desc' },
  });
  if (!attempt) return null;

  // The offer names the version this installation currently ships. If the
  // running Shellius has been downgraded since the rollout started, the
  // script it would serve is no longer the one the rollout is about.
  if (attempt.rollout.targetVersion !== POSTURE_COLLECTOR_VERSION) return null;

  return {
    attemptId: attempt.id,
    version: attempt.rollout.targetVersion,
    url: `${config.publicBaseUrl}/api/hosts/collector-script`,
  };
}

/**
 * Called when a host reports a posture snapshot, to close the loop on any
 * open attempt for it.
 *
 * This is the only feedback channel that exists: the host has no way to tell
 * Shellius "the update worked" except by carrying on doing its job at the new
 * version. A host that comes back still on the old version after the grace
 * period rolled back — which is precisely what the updater's self-heal does
 * when the new collector fails to run.
 *
 * Never throws: this sits on the ingest path.
 */
export async function recordReportedVersion(orgId, serverId, reportedVersion, now = new Date()) {
  try {
    const attempt = await prisma.collectorUpdateAttempt.findFirst({
      where: { orgId, serverId, status: 'offered' },
      include: { rollout: { select: { targetVersion: true } } },
      orderBy: { offeredAt: 'desc' },
    });
    if (!attempt) return null;

    const target = attempt.rollout.targetVersion;
    const onTarget = reportedVersion && !isOlderCollector(reportedVersion, target);

    if (onTarget) {
      return prisma.collectorUpdateAttempt.update({
        where: { id: attempt.id },
        data: { status: 'verified', reportedAt: now, verifiedAt: now, detail: null },
      });
    }

    // Still on the old version. Inside the grace period that is just a host
    // that has not got to it yet; after it, the update did not take.
    if (now.getTime() - attempt.offeredAt.getTime() < VERIFY_GRACE_MS) {
      return prisma.collectorUpdateAttempt.update({
        where: { id: attempt.id },
        data: { reportedAt: now },
      });
    }

    return prisma.collectorUpdateAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'rolled_back',
        reportedAt: now,
        detail: `Still reporting ${reportedVersion || 'an unknown version'} after the grace period; the host appears to have reverted.`,
      },
    });
  } catch (err) {
    logger.warn('collectorUpdate: could not record reported version', { serverId, error: err.message });
    return null;
  }
}

/**
 * Judge every attempt whose grace period has run out without a report at all.
 *
 * A host that took the update and then went silent is the worst outcome this
 * feature can produce, and it is invisible to `recordReportedVersion` — which
 * only ever runs when a host DOES report.
 */
export async function failSilentAttempts(rolloutId, now = new Date()) {
  const cutoff = new Date(now.getTime() - VERIFY_GRACE_MS);
  const { count } = await prisma.collectorUpdateAttempt.updateMany({
    where: { rolloutId, status: 'offered', offeredAt: { lt: cutoff }, reportedAt: null },
    data: {
      status: 'failed',
      detail: 'No posture report at all after the update was offered; the host went silent.',
    },
  });
  return count;
}

/**
 * Health of the current step.
 *
 * @returns {{judged: number, failed: number, verified: number, pending: number, rate: number}}
 */
export async function stepHealth(rolloutId) {
  const rows = await prisma.collectorUpdateAttempt.groupBy({
    by: ['status'],
    where: { rolloutId },
    _count: { _all: true },
  });
  const count = (s) => rows.find((r) => r.status === s)?._count?._all ?? 0;
  const verified = count('verified');
  const failed = count('failed') + count('rolled_back');
  const pending = count('offered');
  const judged = verified + failed;
  return { judged, failed, verified, pending, rate: judged === 0 ? 0 : failed / judged };
}

export default {
  PERCENT_STEPS,
  VERIFY_GRACE_MS,
  STEP_DWELL_MS,
  MAX_FAILURE_RATE,
  MIN_FAILURES_TO_HALT,
  bucketFor,
  cohortSize,
  candidatesFor,
  offerFor,
  recordReportedVersion,
  failSilentAttempts,
  stepHealth,
};
