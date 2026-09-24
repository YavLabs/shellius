/**
 * collectorRollout.js
 *
 * BullMQ repeatable job — every 5 minutes. Owns every decision a collector
 * rollout makes: when one starts, which hosts the current step covers,
 * whether the step went well enough to widen, and when to stop.
 *
 * It is deliberately the only writer of `CollectorUpdateAttempt.status =
 * 'offered'`. The endpoint hosts poll does a single lookup of a row this job
 * already wrote, so "10% of the fleet" is a fact about the database rather
 * than a race between whichever hosts happened to poll first.
 *
 * The rollout widens on evidence and stops on evidence. It never widens
 * merely because time passed: dwell time is a floor on how fast it can move,
 * not a reason to move.
 */

import prisma from '../config/db.js';
import redis from '../config/redis.js';
import { createQueue, createWorker } from '../config/queue.js';
import logger from '../utils/logger.js';
import * as postureSettingsService from '../services/postureSettingsService.js';
import { POSTURE_COLLECTOR_VERSION } from '../utils/postureCollectorVersion.js';
import {
  PERCENT_STEPS,
  STEP_DWELL_MS,
  MAX_FAILURE_RATE,
  MIN_FAILURES_TO_HALT,
  bucketFor,
  cohortSize,
  candidatesFor,
  failSilentAttempts,
  stepHealth,
} from '../services/collectorUpdateService.js';

const QUEUE_NAME = 'collector-rollout';
const EVERY_MS = 5 * 60 * 1000;
const LOCK_TTL_MS = 5 * 60 * 1000;

export const collectorRolloutQueue = createQueue(QUEUE_NAME);

export async function registerCollectorRolloutJob() {
  try {
    const repeatables = await collectorRolloutQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await collectorRolloutQueue.removeRepeatableByKey(r.key);
    }
    await collectorRolloutQueue.add('run', {}, { repeat: { every: EVERY_MS } });
    logger.info('collectorRollout: repeatable job registered (every 5m)');
  } catch (err) {
    logger.error('collectorRollout: failed to register job', { error: err.message });
  }
}

/**
 * One organization at a time. Does NOT fail open: two instances widening the
 * same rollout concurrently could take it from the canary step to the whole
 * fleet in one tick, which is the single outcome the staging exists to
 * prevent.
 */
async function withLock(orgId, fn) {
  const key = `lock:collector-rollout:${orgId}`;
  let held = false;
  try {
    held = (await redis.set(key, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
  } catch (err) {
    logger.warn('collectorRollout: lock unavailable, skipping this pass', { orgId, error: err.message });
    return null;
  }
  if (!held) return null;
  try {
    return await fn();
  } finally {
    redis.del(key).catch(() => {});
  }
}

/** The next step up from `percent`, or null when there is nowhere further. */
export function nextPercent(percent) {
  return PERCENT_STEPS.find((p) => p > percent) ?? null;
}

/**
 * Bring one organization's rollout up to date.
 *
 * Exported for tests and for a manual run.
 */
export async function advanceOrg(orgId, { now = new Date() } = {}) {
  const settings = await postureSettingsService.getSettings(orgId);
  const target = POSTURE_COLLECTOR_VERSION;

  const open = await prisma.collectorRollout.findFirst({
    where: { orgId, status: 'rolling' },
  });

  // Auto-update turned off mid-rollout: stop offering, leave what happened on
  // the record. Hosts that already have an offer will still take it — the
  // switch governs new offers, and reaching onto a host to un-offer something
  // is not a thing this feature can do.
  if (!settings.collectorAutoUpdate) {
    if (open) {
      await prisma.collectorRollout.update({
        where: { id: open.id },
        data: { status: 'cancelled', haltedReason: 'Automatic collector updates were turned off.', completedAt: now },
      });
      return { action: 'cancelled', rolloutId: open.id };
    }
    return { action: 'disabled' };
  }

  if (!target) {
    // The shipped collector script could not be read. Offering an update to a
    // version we cannot name would hand hosts a script we cannot verify.
    return { action: 'no-target' };
  }

  // A rollout for a version this installation no longer ships (a downgrade,
  // or a rollback of Shellius itself) must not carry on.
  if (open && open.targetVersion !== target) {
    await prisma.collectorRollout.update({
      where: { id: open.id },
      data: {
        status: 'cancelled',
        haltedReason: `This installation now ships collector ${target}, not ${open.targetVersion}.`,
        completedAt: now,
      },
    });
    return { action: 'cancelled', rolloutId: open.id };
  }

  let rollout = open;

  if (!rollout) {
    const candidates = await candidatesFor(orgId, target);
    if (candidates.length === 0) return { action: 'nothing-to-do' };

    // A rollout already exists for this version and ended — halted, cancelled
    // or complete. Do not silently start it again: a halted rollout is a
    // decision waiting for a person, and re-starting it on the next tick
    // would make the health gate meaningless.
    const previous = await prisma.collectorRollout.findUnique({
      where: { orgId_targetVersion: { orgId, targetVersion: target } },
    });
    if (previous) return { action: 'previously-ended', status: previous.status };

    rollout = await prisma.collectorRollout.create({
      data: {
        orgId,
        targetVersion: target,
        status: 'rolling',
        percent: 0,
        startedAt: now,
      },
    });
    logger.info('collectorRollout: started', { orgId, targetVersion: target, candidates: candidates.length });
  }

  // Judge anything that went silent before reading the health of the step.
  await failSilentAttempts(rollout.id, now);
  const health = await stepHealth(rollout.id);

  // Halt on evidence. Checked before widening, so a bad step can never be
  // followed by a bigger one.
  if (health.failed >= MIN_FAILURES_TO_HALT && health.rate > MAX_FAILURE_RATE) {
    await prisma.collectorRollout.update({
      where: { id: rollout.id },
      data: {
        status: 'halted',
        completedAt: now,
        haltedReason:
          `${health.failed} of ${health.judged} hosts did not come back healthy on ${target} ` +
          `(${Math.round(health.rate * 100)}%). Rollout stopped; no further hosts will be offered the update.`,
      },
    });
    logger.warn('collectorRollout: halted on failure rate', {
      orgId,
      rolloutId: rollout.id,
      failed: health.failed,
      judged: health.judged,
    });
    return { action: 'halted', rolloutId: rollout.id, health };
  }

  // Still waiting on the current step: hosts are offered but have not yet
  // reported either way.
  if (health.pending > 0) return { action: 'waiting', rolloutId: rollout.id, health };

  const dwellOk =
    !rollout.lastStepAt || now.getTime() - rollout.lastStepAt.getTime() >= STEP_DWELL_MS;
  if (!dwellOk) return { action: 'dwelling', rolloutId: rollout.id, health };

  // Widen (or take the first step).
  const candidates = await candidatesFor(orgId, target);
  const already = await prisma.collectorUpdateAttempt.findMany({
    where: { rolloutId: rollout.id },
    select: { serverId: true },
  });
  const seen = new Set(already.map((a) => a.serverId));

  if (candidates.length === 0 && seen.size > 0) {
    await prisma.collectorRollout.update({
      where: { id: rollout.id },
      data: { status: 'complete', percent: 100, completedAt: now },
    });
    logger.info('collectorRollout: complete', { orgId, rolloutId: rollout.id, hosts: seen.size });
    return { action: 'complete', rolloutId: rollout.id };
  }

  const step = rollout.percent === 0 ? Math.min(settings.collectorCanaryPercent || 10, 100) : nextPercent(rollout.percent);
  if (step === null) {
    // Already at 100% with nothing pending and nothing left to offer.
    await prisma.collectorRollout.update({
      where: { id: rollout.id },
      data: { status: 'complete', completedAt: now },
    });
    return { action: 'complete', rolloutId: rollout.id };
  }

  // The cohort is the whole eligible fleet ordered by its stable bucket, cut
  // at the step size — so widening is always a superset of what came before.
  const ordered = [...candidates].sort(
    (a, b) => bucketFor(a.server.id, target) - bucketFor(b.server.id, target)
  );
  const totalFleet = ordered.length + seen.size;
  const want = cohortSize(totalFleet, step);
  const toOffer = ordered.slice(0, Math.max(0, want - seen.size));

  let offered = 0;
  for (const c of toOffer) {
    try {
      await prisma.collectorUpdateAttempt.create({
        data: {
          orgId,
          rolloutId: rollout.id,
          serverId: c.server.id,
          fromVersion: c.currentVersion,
          toVersion: target,
          status: 'offered',
          offeredAt: now,
        },
      });
      offered += 1;
    } catch (err) {
      // Unique (rolloutId, serverId) — already offered on an earlier tick.
      if (err.code !== 'P2002') {
        logger.warn('collectorRollout: could not offer', { serverId: c.server.id, error: err.message });
      }
    }
  }

  await prisma.collectorRollout.update({
    where: { id: rollout.id },
    data: { percent: step, lastStepAt: now },
  });

  logger.info('collectorRollout: step', { orgId, rolloutId: rollout.id, percent: step, offered });
  return { action: 'stepped', rolloutId: rollout.id, percent: step, offered };
}

/** One pass over every organization with auto-update on. */
export async function runRolloutPass({ now = new Date() } = {}) {
  const orgs = await prisma.postureSettings.findMany({
    where: { collectorAutoUpdate: true },
    select: { orgId: true },
  });

  const summary = { orgs: orgs.length, stepped: 0, halted: 0, complete: 0 };
  for (const { orgId } of orgs) {
    try {
      const result = await withLock(orgId, () => advanceOrg(orgId, { now }));
      if (!result) continue;
      if (result.action === 'stepped') summary.stepped += 1;
      if (result.action === 'halted') summary.halted += 1;
      if (result.action === 'complete') summary.complete += 1;
    } catch (err) {
      logger.error('collectorRollout: org pass failed', { orgId, error: err.message });
    }
  }
  return summary;
}

export function startCollectorRolloutWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      const summary = await runRolloutPass();
      if (summary.stepped || summary.halted || summary.complete) {
        logger.info('collectorRollout: pass complete', summary);
      }
      return summary;
    });
    worker.on('failed', (job, err) => {
      logger.error('collectorRollout: job failed', { jobId: job?.id, error: err?.message });
    });
    return worker;
  } catch (err) {
    logger.error('collectorRollout: failed to start worker', { error: err.message });
    return null;
  }
}

export default {
  collectorRolloutQueue,
  registerCollectorRolloutJob,
  advanceOrg,
  runRolloutPass,
  nextPercent,
  startCollectorRolloutWorker,
};
