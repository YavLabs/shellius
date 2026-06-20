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

async function processOnboard(job) {
  const { credentialId } = job.data;
  const cred = await prisma.onboardingCredential.findUnique({ where: { id: credentialId } });
  if (!cred) return; // already wiped
  if (cred.expiresAt < new Date()) {
    await wipe(credentialId);
    return;
  }

  await prisma.onboardingCredential.update({
    where: { id: credentialId },
    data: { status: 'running', attempts: { increment: 1 } },
  });

  const server = await prisma.server.findUnique({ where: { id: cred.serverId } });
  if (!server) {
    await wipe(credentialId);
    return;
  }

  try {
    const secret = decrypt(cred.secretEncrypted);
    const sudoPassword = cred.sudoPasswordEncrypted ? decrypt(cred.sudoPasswordEncrypted) : undefined;
    const bootstrapUrl = await bootstrapService.buildBootstrapUrl(server.orgId, server.id);

    // provisionService updates Server.provisionStatus itself.
    await provisionService.provisionServer(server.orgId, server.id, {
      privateKey: cred.authMethod === 'key' ? secret : undefined,
      sshUser: cred.sshUser || server.sshUser || 'root',
      sudoPassword: cred.authMethod === 'password' ? secret : sudoPassword,
      bootstrapUrl,
      onOutput: () => {},
    });

    await prisma.onboardingCredential.update({ where: { id: credentialId }, data: { status: 'done' } });
    logger.info('serverOnboarding: server onboarded', { serverId: server.id });
  } catch (err) {
    logger.warn('serverOnboarding: onboarding failed', { serverId: server.id, error: err.message });
    await prisma.onboardingCredential.update({ where: { id: credentialId }, data: { status: 'failed' } });
    throw err; // let BullMQ retry per defaultJobOptions
  } finally {
    // Always wipe the secret once we're done with this attempt's terminal state.
    const fresh = await prisma.onboardingCredential.findUnique({ where: { id: credentialId } });
    if (fresh && (fresh.status === 'done' || fresh.attempts >= 3)) {
      await wipe(credentialId);
    }
  }
}

async function wipe(credentialId) {
  await prisma.onboardingCredential.delete({ where: { id: credentialId } }).catch(() => {});
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
