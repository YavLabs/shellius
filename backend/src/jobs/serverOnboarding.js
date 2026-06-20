/**
 * serverOnboarding — background worker that onboards servers staged by a bulk
 * import. For each OnboardingCredential it SSHes in (via provisionService) using
 * the encrypted password/key, runs the idempotent bootstrap, updates the
 * Server's provisionStatus, then HARD-DELETES the credential.
 *
 * Runs with bounded concurrency so 20-25 servers onboard in parallel without
 * exhausting the box. A separate TTL reaper wipes any credential left behind.
 */

import { Worker } from 'bullmq';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { decrypt } from '../utils/crypto.js';
import { createQueue, connection } from '../config/queue.js';
import * as provisionService from '../services/provisionService.js';
import * as bootstrapService from '../services/bootstrapUrlService.js';

const QUEUE_NAME = 'server-onboarding';
const REAPER_QUEUE = 'onboarding-reaper';
const CONCURRENCY = parseInt(process.env.ONBOARDING_CONCURRENCY, 10) || 5;

export const onboardingQueue = createQueue(QUEUE_NAME);
export const reaperQueue = createQueue(REAPER_QUEUE);

/** Enqueue an onboarding job for every pending credential of an import job. */
export async function enqueueOnboarding(jobId) {
  const creds = await prisma.onboardingCredential.findMany({
    where: { jobId, status: 'pending' },
    select: { id: true },
  });
  for (const c of creds) {
    await onboardingQueue.add('onboard', { credentialId: c.id }, { jobId: `onboard-${c.id}` });
  }
  logger.info('serverOnboarding: enqueued', { jobId, count: creds.length });
  return creds.length;
}

const MAX_ATTEMPTS = 3;

async function processOnboard(job) {
  const { credentialId } = job.data;
  const cred = await prisma.onboardingCredential.findUnique({ where: { id: credentialId } });
  if (!cred) return; // already finalized
  if (['done', 'failed'].includes(cred.status)) {
    await maybeCompleteJob(cred.jobId);
    return;
  }
  if (cred.expiresAt < new Date()) {
    await finalize(credentialId, cred.jobId, 'failed', cred.serverId);
    return;
  }

  const upd = await prisma.onboardingCredential.update({
    where: { id: credentialId },
    data: { status: 'running', attempts: { increment: 1 } },
  });
  const attempt = upd.attempts;

  const server = cred.serverId
    ? await prisma.server.findUnique({ where: { id: cred.serverId } })
    : null;
  if (!server) {
    await finalize(credentialId, cred.jobId, 'failed', cred.serverId);
    return;
  }

  try {
    // Decrypt whichever credentials were staged. Legacy rows stored the password
    // in secretEncrypted with authMethod 'password' — handle that fallback.
    const privateKey =
      cred.secretEncrypted && cred.authMethod !== 'password'
        ? decrypt(cred.secretEncrypted)
        : undefined;
    let password = cred.passwordEncrypted ? decrypt(cred.passwordEncrypted) : undefined;
    if (!password && !privateKey && cred.secretEncrypted) {
      password = decrypt(cred.secretEncrypted); // legacy password-in-secret rows
    }
    const passphrase = cred.passphraseEncrypted ? decrypt(cred.passphraseEncrypted) : undefined;
    const sudoPassword = cred.sudoPasswordEncrypted ? decrypt(cred.sudoPasswordEncrypted) : undefined;
    const bootstrapUrl = await bootstrapService.buildBootstrapUrl(server.orgId, server.id);

    // provisionService updates Server.provisionStatus itself.
    await provisionService.provisionServer(server.orgId, server.id, {
      privateKey,
      passphrase,
      password,
      sshUser: cred.sshUser || server.sshUser || 'root',
      sudoPassword,
      bootstrapUrl,
      onOutput: () => {},
    });

    logger.info('serverOnboarding: server onboarded', { serverId: server.id, attempt });
    await finalize(credentialId, cred.jobId, 'done', server.id);
  } catch (err) {
    logger.warn('serverOnboarding: onboarding attempt failed', {
      serverId: server.id, attempt, error: err.message,
    });
    if (attempt >= MAX_ATTEMPTS) {
      // Give up after MAX_ATTEMPTS — import the server with onboarding 'failed'
      // (retry later from the Server Details page). Terminal: do NOT throw.
      await finalize(credentialId, cred.jobId, 'failed', server.id);
      return;
    }
    // Reset to pending so the job stays "in progress" and BullMQ retries.
    await prisma.onboardingCredential
      .update({ where: { id: credentialId }, data: { status: 'pending' } })
      .catch(() => {});
    throw err;
  }
}

/**
 * Reach a terminal state: record done/failed, WIPE the secret material (keep
 * the row so the importer UI can show the per-server outcome), reflect the
 * outcome on the Server, and complete the import job when nothing is left.
 */
async function finalize(credentialId, jobId, status, serverId) {
  await prisma.onboardingCredential
    .update({
      where: { id: credentialId },
      data: {
        status,
        secretEncrypted: null,
        passwordEncrypted: null,
        passphraseEncrypted: null,
        sudoPasswordEncrypted: null,
      },
    })
    .catch(() => {});
  if (status === 'failed' && serverId) {
    await prisma.server
      .update({ where: { id: serverId }, data: { provisionStatus: 'failed' } })
      .catch(() => {});
  }
  await maybeCompleteJob(jobId);
}

/** Mark the import job 'completed' once no credential is still in flight. */
async function maybeCompleteJob(jobId) {
  if (!jobId) return;
  const remaining = await prisma.onboardingCredential.count({
    where: { jobId, status: { in: ['staged', 'pending', 'running'] } },
  });
  if (remaining === 0) {
    await prisma.importJob
      .updateMany({ where: { id: jobId, status: 'onboarding' }, data: { status: 'completed' } })
      .catch(() => {});
  }
}

/**
 * On boot, complete any import job stuck in 'onboarding' whose credentials have
 * all finished (e.g. left over from before this fix).
 */
export async function reconcileStuckImports() {
  try {
    const jobs = await prisma.importJob.findMany({
      where: { status: 'onboarding' },
      select: { id: true },
    });
    for (const j of jobs) await maybeCompleteJob(j.id);
  } catch (err) {
    logger.warn('serverOnboarding: reconcile failed', { error: err.message });
  }
}

export function startServerOnboardingWorker() {
  try {
    const worker = new Worker(QUEUE_NAME, processOnboard, { connection, concurrency: CONCURRENCY });
    worker.on('failed', (job, err) =>
      logger.error(`serverOnboarding: job ${job?.id} failed`, { error: err.message })
    );
    worker.on('error', (err) => logger.error('serverOnboarding: worker error', { error: err.message }));
    return worker;
  } catch (err) {
    logger.error('serverOnboarding: failed to start worker', { error: err.message });
    return null;
  }
}

// --- TTL reaper: wipe any expired credential, even if its job never ran ------

export async function registerOnboardingReaper() {
  try {
    const repeatables = await reaperQueue.getRepeatableJobs();
    for (const r of repeatables) await reaperQueue.removeRepeatableByKey(r.key);
    await reaperQueue.add('reap', {}, { repeat: { every: 15 * 60 * 1000 } });
  } catch (err) {
    logger.error('onboarding-reaper: failed to register', { error: err.message });
  }
}

export function startOnboardingReaperWorker() {
  try {
    return new Worker(
      REAPER_QUEUE,
      async () => {
        const res = await prisma.onboardingCredential.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        if (res.count) logger.info('onboarding-reaper: wiped expired credentials', { count: res.count });
      },
      { connection, concurrency: 1 }
    );
  } catch (err) {
    logger.error('onboarding-reaper: failed to start worker', { error: err.message });
    return null;
  }
}
