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
import {
  registerSessionCleanupJob,
  startSessionCleanupWorker,
} from './sessionCleanup.js';
import { seedDefaultPolicies } from './seedDefaultPolicies.js';
import {
  startServerOnboardingWorker,
  registerOnboardingReaper,
  startOnboardingReaperWorker,
} from './serverOnboarding.js';
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

  await registerSessionCleanupJob();
  startSessionCleanupWorker();

  // Bulk-import server onboarding (parallel) + ephemeral-credential TTL reaper.
  startServerOnboardingWorker();
  await registerOnboardingReaper();
  startOnboardingReaperWorker();

  // Idempotent one-shot: seed default policies for any org with zero rows.
  // Runs in the background so a slow DB doesn't block boot.
  seedDefaultPolicies().catch((err) =>
    logger.error('seedDefaultPolicies: top-level failure', { error: err.message })
  );

  logger.info('jobs: all background jobs registered');
}
