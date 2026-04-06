import { createQueue, createWorker } from '../config/queue.js';
import { markExpired } from '../services/accessRequestService.js';
import logger from '../utils/logger.js';

const QUEUE_NAME = 'expire-access-requests';

export const expireAccessRequestsQueue = createQueue(QUEUE_NAME);

export async function registerExpireAccessRequestsJob() {
  try {
    // Remove stale repeatable registrations before re-adding
    const repeatables = await expireAccessRequestsQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await expireAccessRequestsQueue.removeRepeatableByKey(r.key);
    }

    // Run every 1 minute
    await expireAccessRequestsQueue.add('run', {}, { repeat: { every: 60 * 1000 } });
    logger.info('expireAccessRequests: repeatable job registered (every 1 minute)');
  } catch (err) {
    logger.error('expireAccessRequests: failed to register repeatable job', { error: err.message });
  }
}

export function startExpireAccessRequestsWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      logger.info('expireAccessRequests: running expiry sweep');
      try {
        const count = await markExpired();
        if (count > 0) {
          logger.info(`expireAccessRequests: marked ${count} access request(s) as EXPIRED`);
        }
      } catch (err) {
        logger.error('expireAccessRequests: sweep failed', { error: err.message });
      }
    });

    worker.on('failed', (job, err) => {
      logger.error(`expireAccessRequests: job ${job?.id} failed`, { error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('expireAccessRequests: worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('expireAccessRequests: failed to start worker', { error: err.message });
    return null;
  }
}
