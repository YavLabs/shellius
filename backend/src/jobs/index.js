import { registerHealthCheckJob, startHealthCheckWorker } from './healthCheck.js';
import { registerCertExpiryJob, startCertExpiryWorker } from './certExpiry.js';
import logger from '../utils/logger.js';

export async function startAllJobs() {
  logger.info('jobs: registering background jobs');

  await registerHealthCheckJob();
  startHealthCheckWorker();

  await registerCertExpiryJob();
  startCertExpiryWorker();

  logger.info('jobs: all background jobs registered');
}
