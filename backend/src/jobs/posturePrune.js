/**
 * posturePrune.js
 *
 * BullMQ repeatable job — runs daily. Enforces each org's posture retention
 * settings (docs/posture/posture-spec.md §5 "Retention"): prunes
 * `HostSnapshot` rows (which cascade-delete their `HostListener` rows) past
 * `snapshotRetentionDays`, `HostMetricSample` rows past
 * `metricRetentionHours`, and `ExposureFinding` rows that have been
 * *resolved* for longer than `findingRetentionDays`.
 *
 * Deliberately does NOT touch open/muted/acknowledged findings regardless of
 * age — an exposure finding stays open until it is actually resolved or the
 * server is deleted (§9.1 "a host that stops reporting" must not silently
 * lose its findings just because its snapshots aged out of retention).
 *
 * Per-org, not global: an org with no `PostureSettings` row yet (never
 * touched posture settings) falls back to the schema defaults so pruning
 * still applies to any posture data ingested before the settings were ever
 * read/written.
 */

import prisma from '../config/db.js';
import { createQueue, createWorker } from '../config/queue.js';
import logger from '../utils/logger.js';

const QUEUE_NAME = 'posture-prune';

// Mirrors the PostureSettings schema defaults (prisma/schema.prisma).
const DEFAULT_RETENTION = {
  snapshotRetentionDays: 7,
  metricRetentionHours: 24,
  findingRetentionDays: 90,
};

export const posturePruneQueue = createQueue(QUEUE_NAME);

// ---------------------------------------------------------------------------
// registerPosturePruneJob
// ---------------------------------------------------------------------------

export async function registerPosturePruneJob() {
  try {
    const repeatables = await posturePruneQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await posturePruneQueue.removeRepeatableByKey(r.key);
    }

    await posturePruneQueue.add('run', {}, { repeat: { every: 24 * 60 * 60 * 1000 } }); // every 24h

    logger.info('posturePrune: repeatable job registered (every 24h)');
  } catch (err) {
    logger.error('posturePrune: failed to register job', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// startPosturePruneWorker
// ---------------------------------------------------------------------------

export function startPosturePruneWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      logger.info('posturePrune: job started');
      const result = await pruneAll();
      logger.info('posturePrune: job complete', result);
    });

    worker.on('failed', (job, err) => {
      logger.error(`posturePrune: job ${job?.id} failed`, { error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('posturePrune: worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('posturePrune: failed to start worker', { error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// pruneAll — one pass over every org with posture data
// ---------------------------------------------------------------------------

export async function pruneAll() {
  const [settingsRows, snapshotOrgRows, metricOrgRows, findingOrgRows] = await Promise.all([
    prisma.postureSettings.findMany({
      select: {
        orgId: true,
        snapshotRetentionDays: true,
        metricRetentionHours: true,
        findingRetentionDays: true,
      },
    }),
    prisma.hostSnapshot.findMany({ distinct: ['orgId'], select: { orgId: true } }),
    prisma.hostMetricSample.findMany({ distinct: ['orgId'], select: { orgId: true } }),
    prisma.exposureFinding.findMany({ distinct: ['orgId'], select: { orgId: true } }),
  ]);

  const settingsByOrg = new Map(settingsRows.map((s) => [s.orgId, s]));
  const orgIds = new Set([
    ...settingsByOrg.keys(),
    ...snapshotOrgRows.map((r) => r.orgId),
    ...metricOrgRows.map((r) => r.orgId),
    ...findingOrgRows.map((r) => r.orgId),
  ]);

  let snapshotsDeleted = 0;
  let metricsDeleted = 0;
  let findingsDeleted = 0;

  for (const orgId of orgIds) {
    const retention = settingsByOrg.get(orgId) || DEFAULT_RETENTION;
    const now = Date.now();
    const snapshotCutoff = new Date(now - retention.snapshotRetentionDays * 24 * 60 * 60 * 1000);
    const metricCutoff = new Date(now - retention.metricRetentionHours * 60 * 60 * 1000);
    const findingCutoff = new Date(now - retention.findingRetentionDays * 24 * 60 * 60 * 1000);

    const [snapRes, metricRes, findRes] = await Promise.all([
      // HostListener rows cascade-delete with their snapshot (schema
      // onDelete: Cascade) — no separate listener prune needed.
      prisma.hostSnapshot.deleteMany({ where: { orgId, receivedAt: { lt: snapshotCutoff } } }),
      prisma.hostMetricSample.deleteMany({ where: { orgId, at: { lt: metricCutoff } } }),
      prisma.exposureFinding.deleteMany({ where: { orgId, resolvedAt: { lt: findingCutoff } } }),
    ]);

    snapshotsDeleted += snapRes.count;
    metricsDeleted += metricRes.count;
    findingsDeleted += findRes.count;
  }

  return { orgsProcessed: orgIds.size, snapshotsDeleted, metricsDeleted, findingsDeleted };
}
