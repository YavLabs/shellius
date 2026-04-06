import { registerHealthCheckJob, startHealthCheckWorker } from './healthCheck.js';
import { registerCertExpiryJob, startCertExpiryWorker } from './certExpiry.js';
import {
  registerExpireAccessRequestsJob,
  startExpireAccessRequestsWorker,
} from './expireAccessRequests.js';
import {
  registerExpirePendingRequestsJob,
  startExpirePendingRequestsWorker,
} from './expirePendingRequests.js';
import {
  registerNotifyExpiringAccessJob,
  startNotifyExpiringAccessWorker,
} from './notifyExpiringAccess.js';
import logger from '../utils/logger.js';

export async function startAllJobs() {
  logger.info('jobs: registering background jobs');

  await registerHealthCheckJob();
  startHealthCheckWorker();

  await registerCertExpiryJob();
  startCertExpiryWorker();

  await registerExpireAccessRequestsJob();
  startExpireAccessRequestsWorker();

  await registerExpirePendingRequestsJob();
  startExpirePendingRequestsWorker();

  await registerNotifyExpiringAccessJob();
  startNotifyExpiringAccessWorker();

  logger.info('jobs: all background jobs registered');
}
