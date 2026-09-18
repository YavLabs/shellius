/**
 * quickConnectHistoryPrune.js
 *
 * BullMQ repeatable job — runs daily. Deletes QuickConnectHistory rows past
 * the 7-day retention window (see docs/keystore-and-quick-connect.md, "Quick
 * Connect history"). Read paths (listHistory) also filter on
 * lastConnectedAt, so this job is a hygiene pass, not a security boundary.
 */

import prisma from '../config/db.js';
import { createQueue, createWorker } from '../config/queue.js';
import logger from '../utils/logger.js';

const QUEUE_NAME = 'quick-connect-history-prune';
const RETENTION_DAYS = 7;

export const quickConnectHistoryPruneQueue = createQueue(QUEUE_NAME);

// ---------------------------------------------------------------------------
// registerQuickConnectHistoryPruneJob
// ---------------------------------------------------------------------------

export async function registerQuickConnectHistoryPruneJob() {
  try {
    // Clear existing repeatables to avoid duplicates on restart.
    const repeatables = await quickConnectHistoryPruneQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await quickConnectHistoryPruneQueue.removeRepeatableByKey(r.key);
    }

    await quickConnectHistoryPruneQueue.add(
      'run',
      {},
      { repeat: { every: 24 * 60 * 60 * 1000 } } // every 24h
    );

    logger.info('quickConnectHistoryPrune: repeatable job registered (every 24h)');
  } catch (err) {
    logger.error('quickConnectHistoryPrune: failed to register job', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// startQuickConnectHistoryPruneWorker
// ---------------------------------------------------------------------------

export function startQuickConnectHistoryPruneWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      logger.info('quickConnectHistoryPrune: job started');
      const result = await pruneExpiredHistory();
      logger.info('quickConnectHistoryPrune: job complete', { deleted: result.count });
    });

    worker.on('failed', (job, err) => {
      logger.error(`quickConnectHistoryPrune: job ${job?.id} failed`, { error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('quickConnectHistoryPrune: worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('quickConnectHistoryPrune: failed to start worker', { error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// pruneExpiredHistory — delete rows with lastConnectedAt older than 7 days
// ---------------------------------------------------------------------------

export async function pruneExpiredHistory() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return prisma.quickConnectHistory.deleteMany({ where: { lastConnectedAt: { lt: cutoff } } });
}
