import { createQueue, createWorker } from '../config/queue.js';
import { markPendingExpired } from '../services/accessRequestService.js';
import logger from '../utils/logger.js';

const QUEUE_NAME = 'expire-pending-requests';

export const expirePendingRequestsQueue = createQueue(QUEUE_NAME);

export async function registerExpirePendingRequestsJob() {
  try {
    // Remove stale repeatable registrations before re-adding
    const repeatables = await expirePendingRequestsQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await expirePendingRequestsQueue.removeRepeatableByKey(r.key);
    }

    // Run every 5 minutes
    await expirePendingRequestsQueue.add('run', {}, { repeat: { every: 5 * 60 * 1000 } });
    logger.info('expirePendingRequests: repeatable job registered (every 5 minutes)');
  } catch (err) {
    logger.error('expirePendingRequests: failed to register repeatable job', { error: err.message });
  }
}

export function startExpirePendingRequestsWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      logger.info('expirePendingRequests: running pending expiry sweep');
      try {
        const count = await markPendingExpired();
        if (count > 0) {
          logger.info(`expirePendingRequests: marked ${count} pending request(s) as EXPIRED`);
        }
      } catch (err) {
        logger.error('expirePendingRequests: sweep failed', { error: err.message });
      }
    });

    worker.on('failed', (job, err) => {
      logger.error(`expirePendingRequests: job ${job?.id} failed`, { error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('expirePendingRequests: worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('expirePendingRequests: failed to start worker', { error: err.message });
    return null;
  }
}
