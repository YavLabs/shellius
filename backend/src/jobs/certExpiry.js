import { createQueue, createWorker } from '../config/queue.js';
import { markExpired } from '../services/certificateService.js';
import logger from '../utils/logger.js';

const QUEUE_NAME = 'cert-expiry';

export const certExpiryQueue = createQueue(QUEUE_NAME);

export async function registerCertExpiryJob() {
  try {
    // Remove any stale repeatable registrations before re-adding
    const repeatables = await certExpiryQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await certExpiryQueue.removeRepeatableByKey(r.key);
    }

    // Run every 5 minutes
    await certExpiryQueue.add('run', {}, { repeat: { every: 5 * 60 * 1000 } });
    logger.info('certExpiry: repeatable job registered (every 5 minutes)');
  } catch (err) {
    logger.error('certExpiry: failed to register repeatable job', { error: err.message });
  }
}

export function startCertExpiryWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      logger.info('certExpiry: running expiry sweep');
      try {
        const count = await markExpired();
        if (count > 0) {
          logger.info(`certExpiry: marked ${count} certificate(s) as EXPIRED`);
        }
      } catch (err) {
        logger.error('certExpiry: sweep failed', { error: err.message });
      }
    });

    worker.on('failed', (job, err) => {
      logger.error(`certExpiry: job ${job?.id} failed`, { error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('certExpiry: worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('certExpiry: failed to start worker', { error: err.message });
    return null;
  }
}
