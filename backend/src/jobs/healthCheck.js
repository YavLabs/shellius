import { createQueue, createWorker } from '../config/queue.js';
import { checkAllServers } from '../services/healthCheckService.js';
import logger from '../utils/logger.js';

const QUEUE_NAME = 'server-health-check';

export const healthCheckQueue = createQueue(QUEUE_NAME);

export async function registerHealthCheckJob() {
  try {
    const repeatables = await healthCheckQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await healthCheckQueue.removeRepeatableByKey(r.key);
    }

    await healthCheckQueue.add(
      'run',
      {},
      { repeat: { every: 5 * 60 * 1000 } }
    );
    logger.info('Health check repeatable job registered');
  } catch (err) {
    logger.error('Failed to register health check job:', err.message);
  }
}

export function startHealthCheckWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      logger.info('Running scheduled health check for all servers');
      try {
        const result = await checkAllServers();
        logger.info(`Health check complete: ${result.checked}/${result.total}`);
      } catch (err) {
        logger.error('Health check job failed:', err);
      }
    });

    worker.on('failed', (job, err) => {
      logger.error(`Health check job ${job?.id} failed:`, err);
    });
    worker.on('error', (err) => {
      logger.error('Health check worker error:', err.message);
    });

    return worker;
  } catch (err) {
    logger.error('Failed to start health check worker:', err.message);
    return null;
  }
}
