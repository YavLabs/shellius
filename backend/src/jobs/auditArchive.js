/**
 * auditArchive.js
 *
 * BullMQ repeatable job — daily. Applies each organization's audit retention
 * policy: archive old entries, then delete what was archived.
 *
 * This replaces the long-standing `TODO(phase-10): auditArchive.js` note in
 * sessionCleanup.js.
 *
 * Only orgs that have actually set a retention period are touched. An org
 * that has never opened the retention screen keeps everything, forever —
 * audit history must never start disappearing because of an upgrade.
 */

import prisma from '../config/db.js';
import { createQueue, createWorker } from '../config/queue.js';
import logger from '../utils/logger.js';
import { applyRetention } from '../services/audit/retentionService.js';

const QUEUE_NAME = 'audit-archive';
/** Deliveries are useful for a while, then they are just rows. */
const DELIVERY_RETENTION_DAYS = 30;

export const auditArchiveQueue = createQueue(QUEUE_NAME);

export async function registerAuditArchiveJob() {
  try {
    const repeatables = await auditArchiveQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await auditArchiveQueue.removeRepeatableByKey(r.key);
    }
    await auditArchiveQueue.add('run', {}, { repeat: { every: 24 * 60 * 60 * 1000 } });
    logger.info('auditArchive: repeatable job registered (every 24h)');
  } catch (err) {
    logger.error('auditArchive: failed to register job', { error: err.message });
  }
}

/** One pass over every org that has asked for retention. */
export async function applyAll() {
  const orgs = await prisma.auditSettings.findMany({
    where: { retentionDays: { not: null } },
    select: { orgId: true },
  });

  let archived = 0;
  let deleted = 0;
  const held = [];

  for (const { orgId } of orgs) {
    try {
      const result = await applyRetention(orgId);
      archived += result.archived;
      deleted += result.deleted;
      if (result.skipped) held.push({ orgId, reason: result.skipped });
    } catch (err) {
      // One org's problem must not stop the others.
      logger.error('auditArchive: retention failed for org', { orgId, error: err.message });
    }
  }

  const cutoff = new Date(Date.now() - DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count: prunedDeliveries } = await prisma.auditSinkDelivery.deleteMany({
    where: { startedAt: { lt: cutoff } },
  });

  return { orgs: orgs.length, archived, deleted, prunedDeliveries, held };
}

export function startAuditArchiveWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      logger.info('auditArchive: job started');
      const result = await applyAll();
      logger.info('auditArchive: job complete', result);
    });

    worker.on('failed', (job, err) => {
      logger.error(`auditArchive: job ${job?.id} failed`, { error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('auditArchive: worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('auditArchive: failed to start worker', { error: err.message });
    return null;
  }
}

export default { auditArchiveQueue, registerAuditArchiveJob, startAuditArchiveWorker, applyAll };
