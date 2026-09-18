/**
 * jobs/keyDeployment.js
 *
 * Thin BullMQ wrapper around keyDeploymentService.processDeployment. All the
 * actual SSH/script logic lives in the service so it can be unit tested
 * without spinning up a worker.
 */

import { Worker } from 'bullmq';
import { connection } from '../config/queue.js';
import logger from '../utils/logger.js';
import * as keyDeploymentService from '../services/keyDeploymentService.js';

const QUEUE_NAME = 'key-deployments';
const CONCURRENCY = parseInt(process.env.KEY_DEPLOYMENT_CONCURRENCY, 10) || 5;

export function startKeyDeploymentWorker() {
  try {
    const worker = new Worker(
      QUEUE_NAME,
      async (job) => keyDeploymentService.processDeployment(job.data.deploymentId),
      { connection, concurrency: CONCURRENCY }
    );
    worker.on('failed', (job, err) =>
      logger.error(`keyDeployment: job ${job?.id} failed`, { error: err.message })
    );
    worker.on('error', (err) => logger.error('keyDeployment: worker error', { error: err.message }));
    return worker;
  } catch (err) {
    logger.error('keyDeployment: failed to start worker', { error: err.message });
    return null;
  }
}

/** On boot, fail any 'running' row left behind by a crashed worker. */
export async function reapStaleDeployments() {
  try {
    await keyDeploymentService.reapStaleRunning();
  } catch (err) {
    logger.error('keyDeployment: reaper failed', { error: err.message });
  }
}
