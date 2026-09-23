/**
 * directorySync.js
 *
 * BullMQ repeatable job — every 15 minutes, which is a scheduling tick and
 * not a sync interval. Each configured sync declares its own `intervalHours`
 * and is only run when that much time has passed since its last run, so the
 * tick can be frequent and cheap while the directories are read rarely.
 *
 * Every sync holds a Redis lock for the duration. Two application instances
 * reconciling the same directory at once would open the same findings twice
 * and, worse, could double-count towards the mass-suspension valve.
 */

import prisma from '../config/db.js';
import redis from '../config/redis.js';
import { createQueue, createWorker } from '../config/queue.js';
import logger from '../utils/logger.js';
import { runSync } from '../services/directory/directorySyncService.js';

const QUEUE_NAME = 'directory-sync';
const EVERY_MS = 15 * 60 * 1000;
/** A large directory takes minutes to page; this is comfortably longer. */
const LOCK_TTL_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const directorySyncQueue = createQueue(QUEUE_NAME);

export async function registerDirectorySyncJob() {
  try {
    const repeatables = await directorySyncQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await directorySyncQueue.removeRepeatableByKey(r.key);
    }
    await directorySyncQueue.add('run', {}, { repeat: { every: EVERY_MS } });
    logger.info('directorySync: repeatable job registered (every 15m)');
  } catch (err) {
    logger.error('directorySync: failed to register job', { error: err.message });
  }
}

/**
 * One instance at a time per sync. Unlike the audit sinks, this one does NOT
 * fail open: a sink delivering twice is a duplicate a receiver can dedupe,
 * whereas two reconciles racing could act on the same people twice and skew
 * the safety valves. If the lock cannot be taken, the run waits for the next
 * tick.
 */
async function withLock(syncId, fn) {
  const key = `lock:dirsync:${syncId}`;
  let held = false;
  try {
    held = (await redis.set(key, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
  } catch (err) {
    logger.warn('directorySync: lock unavailable, skipping this pass', { syncId, error: err.message });
    return null;
  }
  if (!held) return null;
  try {
    return await fn();
  } finally {
    redis.del(key).catch(() => {});
  }
}

/** Is this sync due, by its own interval? */
export function isDue(sync, now = new Date()) {
  if (!sync.lastRunAt) return true;
  return now.getTime() - sync.lastRunAt.getTime() >= sync.intervalHours * HOUR_MS;
}

export async function runDueSyncs({ now = new Date() } = {}) {
  const syncs = await prisma.directorySync.findMany({
    where: { isActive: true, ssoConfig: { isActive: true } },
  });

  let ran = 0;
  let suspended = 0;

  for (const sync of syncs) {
    if (!isDue(sync, now)) continue;
    try {
      const result = await withLock(sync.id, () => runSync(sync));
      if (!result) continue; // another instance has it
      ran += 1;
      suspended += result.suspended ?? 0;
    } catch (err) {
      // runSync records its own failures on the row; anything reaching here
      // is unexpected and must not stop the other syncs.
      logger.error('directorySync: unexpected error', { syncId: sync.id, error: err.message });
    }
  }

  return { syncs: syncs.length, ran, suspended };
}

export function startDirectorySyncWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      const result = await runDueSyncs();
      if (result.ran) logger.info('directorySync: pass complete', result);
    });

    worker.on('failed', (job, err) => {
      logger.error(`directorySync: job ${job?.id} failed`, { error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('directorySync: worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('directorySync: failed to start worker', { error: err.message });
    return null;
  }
}

export default { directorySyncQueue, registerDirectorySyncJob, startDirectorySyncWorker, runDueSyncs, isDue };
