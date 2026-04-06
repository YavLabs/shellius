import { createQueue, createWorker } from '../config/queue.js';
import { notifyExpiringAccess } from '../services/accessRequestService.js';
import logger from '../utils/logger.js';

const QUEUE_NAME = 'notify-expiring-access';

export const notifyExpiringAccessQueue = createQueue(QUEUE_NAME);

export async function registerNotifyExpiringAccessJob() {
  try {
    // Remove stale repeatable registrations before re-adding
    const repeatables = await notifyExpiringAccessQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await notifyExpiringAccessQueue.removeRepeatableByKey(r.key);
    }

    // Run every 1 minute
    await notifyExpiringAccessQueue.add('run', {}, { repeat: { every: 60 * 1000 } });
    logger.info('notifyExpiringAccess: repeatable job registered (every 1 minute)');
  } catch (err) {
    logger.error('notifyExpiringAccess: failed to register repeatable job', { error: err.message });
  }
}

export function startNotifyExpiringAccessWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      logger.info('notifyExpiringAccess: running expiry notification sweep');
      try {
        const count = await notifyExpiringAccess();
        if (count > 0) {
          logger.info(`notifyExpiringAccess: sent ${count} expiry warning notification(s)`);
        }
      } catch (err) {
        logger.error('notifyExpiringAccess: sweep failed', { error: err.message });
      }
    });

    worker.on('failed', (job, err) => {
      logger.error(`notifyExpiringAccess: job ${job?.id} failed`, { error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('notifyExpiringAccess: worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('notifyExpiringAccess: failed to start worker', { error: err.message });
    return null;
  }
}
