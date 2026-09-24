/**
 * auditExport.js
 *
 * BullMQ repeatable job — every 30 seconds. Ships each active streaming
 * audit sink whatever it currently owes.
 *
 * Sinks run about READ_LAG_MS (5s) behind live, deliberately: see
 * auditService.stream for why a sequential reader must not walk right up to
 * the present. The UI says so, so nobody reads the delay as a fault.
 *
 * Every sink is wrapped in its own try/catch and holds a short Redis lock,
 * so one failing destination can neither stop the others nor be delivered
 * twice by two application instances running this job at the same time.
 */

import prisma from '../config/db.js';
import redis from '../config/redis.js';
import { createQueue, createWorker } from '../config/queue.js';
import logger from '../utils/logger.js';
import { runSink, runDigestSink } from '../services/audit/sinkService.js';
import { STREAMING_TYPES, DIGEST_TYPES } from '../services/audit/sinks/index.js';

const QUEUE_NAME = 'audit-export';
const EVERY_MS = 30_000;
/** Longer than any plausible run, short enough to recover from a crash. */
const LOCK_TTL_MS = 120_000;

export const auditExportQueue = createQueue(QUEUE_NAME);

export async function registerAuditExportJob() {
  try {
    const repeatables = await auditExportQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await auditExportQueue.removeRepeatableByKey(r.key);
    }
    await auditExportQueue.add('run', {}, { repeat: { every: EVERY_MS } });
    logger.info('auditExport: repeatable job registered (every 30s)');
  } catch (err) {
    logger.error('auditExport: failed to register job', { error: err.message });
  }
}

/** One instance at a time per sink. Fails open if Redis is unavailable. */
async function withLock(sinkId, fn) {
  const key = `lock:auditsink:${sinkId}`;
  let held = false;
  try {
    held = (await redis.set(key, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
  } catch (err) {
    logger.warn('auditExport: lock unavailable, running anyway', { sinkId, error: err.message });
    return fn();
  }
  if (!held) return null;
  try {
    return await fn();
  } finally {
    redis.del(key).catch(() => {});
  }
}

/**
 * One instance at a time per digest sink. Unlike `withLock`, this does NOT
 * fail open: a streaming sink delivering twice is a duplicate the receiver
 * can dedupe on the record id, whereas a duplicated digest lands in a human's
 * inbox with nothing to dedupe it. If Redis is unavailable the digest waits
 * for the next tick, which on a daily schedule is invisible.
 */
async function withStrictLock(sinkId, fn) {
  const key = `lock:auditdigest:${sinkId}`;
  let held = false;
  try {
    held = (await redis.set(key, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
  } catch (err) {
    logger.warn('auditExport: digest lock unavailable, skipping this pass', { sinkId, error: err.message });
    return null;
  }
  if (!held) return null;
  try {
    return await fn();
  } finally {
    redis.del(key).catch(() => {});
  }
}

/** One pass over every sink that is due. */
export async function runDueSinks() {
  const now = new Date();
  const sinks = await prisma.auditSink.findMany({
    where: {
      isActive: true,
      type: { in: STREAMING_TYPES },
      OR: [{ backoffUntil: null }, { backoffUntil: { lte: now } }],
    },
  });

  let delivered = 0;
  let ran = 0;

  for (const sink of sinks) {
    try {
      const result = await withLock(sink.id, () => runSink(sink));
      if (!result) continue; // another instance has it
      ran += 1;
      delivered += result.delivered;
    } catch (err) {
      // runSink handles its own failures; anything here is unexpected, and
      // must still not stop the other sinks.
      logger.error('auditExport: unexpected sink error', { sinkId: sink.id, error: err.message });
    }
  }

  return { sinks: sinks.length, ran, delivered };
}

/**
 * One pass over every scheduled (digest) sink.
 *
 * Runs on the same 30-second tick as the streaming sinks, which is far more
 * often than any digest is due — `runDigestSink` answers "not yet" cheaply
 * from the sink's own cadence. A frequent tick is what lets a digest set for
 * 07:00 arrive at 07:00.
 */
export async function runDueDigests({ now = new Date() } = {}) {
  if (!DIGEST_TYPES.length) return { sinks: 0, sent: 0, delivered: 0 };

  const sinks = await prisma.auditSink.findMany({
    where: {
      isActive: true,
      type: { in: DIGEST_TYPES },
      OR: [{ backoffUntil: null }, { backoffUntil: { lte: now } }],
    },
  });

  let sent = 0;
  let delivered = 0;

  for (const sink of sinks) {
    try {
      const result = await withStrictLock(sink.id, () => runDigestSink(sink, { now }));
      if (!result) continue; // another instance has it
      if (result.sent) sent += 1;
      delivered += result.delivered;
    } catch (err) {
      logger.error('auditExport: unexpected digest error', { sinkId: sink.id, error: err.message });
    }
  }

  return { sinks: sinks.length, sent, delivered };
}

export function startAuditExportWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      const result = await runDueSinks();
      if (result.delivered) logger.info('auditExport: batch shipped', result);
      const digests = await runDueDigests();
      if (digests.sent) logger.info('auditExport: digest sent', digests);
    });

    worker.on('failed', (job, err) => {
      logger.error(`auditExport: job ${job?.id} failed`, { error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('auditExport: worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('auditExport: failed to start worker', { error: err.message });
    return null;
  }
}

export default { auditExportQueue, registerAuditExportJob, startAuditExportWorker, runDueSinks };
