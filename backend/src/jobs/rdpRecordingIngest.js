/**
 * rdpRecordingIngest.js — BullMQ repeatable job, every minute.
 *
 * Moves finished RDP recordings off guacd's filesystem and into object
 * storage, encrypted. See services/rdpRecordingService.js for why this is a
 * sweeper rather than an upload on session close: guacd keeps writing for a
 * moment after the client disconnects, and a sweeper also picks up recordings
 * stranded by a restart.
 *
 * Every instance of Shellius shares one recordings directory, so the pass is
 * locked. Two instances ingesting the same file would both upload it and one
 * would delete it from under the other.
 */

import redis from '../config/redis.js';
import { createQueue, createWorker } from '../config/queue.js';
import logger from '../utils/logger.js';
import * as rdpRecordingService from '../services/rdpRecordingService.js';

const QUEUE_NAME = 'rdp-recording-ingest';
const EVERY_MS = 60 * 1000;

/**
 * Shorter than the interval would let a slow pass overlap the next one; much
 * longer would leave recordings unswept for minutes after a crash. Five
 * minutes is enough for a large backlog and short enough not to matter.
 */
const LOCK_TTL_MS = 5 * 60 * 1000;

export const rdpRecordingQueue = createQueue(QUEUE_NAME);

export async function registerRdpRecordingIngestJob() {
  try {
    const repeatables = await rdpRecordingQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await rdpRecordingQueue.removeRepeatableByKey(r.key);
    }
    await rdpRecordingQueue.add('run', {}, { repeat: { every: EVERY_MS } });
    logger.info('rdpRecordingIngest: repeatable job registered (every 1m)');
  } catch (err) {
    logger.error('rdpRecordingIngest: failed to register job', { error: err.message });
  }
}

/**
 * One locked pass. Does NOT fail open: skipping a pass costs a minute's delay,
 * whereas two instances racing over the same file can delete a recording that
 * was only half uploaded by the other.
 */
export async function runIngestPass({ now = new Date() } = {}) {
  const key = 'lock:rdp-recording-ingest';
  let held = false;
  try {
    held = (await redis.set(key, '1', 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
  } catch (err) {
    logger.warn('rdpRecordingIngest: lock unavailable, skipping this pass', { error: err.message });
    return null;
  }
  if (!held) return null;

  try {
    return await rdpRecordingService.sweep({ now });
  } finally {
    redis.del(key).catch(() => {});
  }
}

export function startRdpRecordingIngestWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      const summary = await runIngestPass();
      if (summary && (summary.stored || summary.failed || summary.orphaned)) {
        logger.info('rdpRecordingIngest: pass complete', summary);
      }
      return summary;
    });
    worker.on('failed', (job, err) => {
      logger.error('rdpRecordingIngest: job failed', { jobId: job?.id, error: err?.message });
    });
    return worker;
  } catch (err) {
    logger.error('rdpRecordingIngest: failed to start worker', { error: err.message });
    return null;
  }
}

export default {
  rdpRecordingQueue,
  registerRdpRecordingIngestJob,
  runIngestPass,
  startRdpRecordingIngestWorker,
};
