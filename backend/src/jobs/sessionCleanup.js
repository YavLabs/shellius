/**
 * sessionCleanup.js
 *
 * BullMQ repeatable job — runs every hour.
 *
 * Responsibilities:
 *   1. Mark stale ACTIVE sessions (startedAt > 24h ago) as ENDED.
 *   2. Delete recordings older than RECORDING_RETENTION_DAYS (default 30) and
 *      null the Session column that pointed at them — both the legacy
 *      on-disk `recordingPath` and the object-storage `recordingKey`.
 *
 * Env vars:
 *   RECORDING_RETENTION_DAYS  — days to keep .cast files (default: 30)
 *   RECORDINGS_DIR            — recording storage directory (default: ./data/recordings)
 *
 * Audit retention lives in auditArchive.js (was TODO(phase-10) here).
 */

import fs from 'fs';
import path from 'path';
import prisma from '../config/db.js';
import { createQueue, createWorker } from '../config/queue.js';
import logger from '../utils/logger.js';
import * as sessionService from '../services/sessionService.js';
import * as storageService from '../services/storageService.js';

const QUEUE_NAME = 'session-cleanup';
const STALE_SESSION_HOURS = 24;
const RECORDING_RETENTION_DAYS = parseInt(process.env.RECORDING_RETENTION_DAYS, 10) || 30;
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || './data/recordings';

export const sessionCleanupQueue = createQueue(QUEUE_NAME);

// ---------------------------------------------------------------------------
// registerSessionCleanupJob
// ---------------------------------------------------------------------------

export async function registerSessionCleanupJob() {
  try {
    // Clear existing repeatables to avoid duplicates on restart
    const repeatables = await sessionCleanupQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await sessionCleanupQueue.removeRepeatableByKey(r.key);
    }

    await sessionCleanupQueue.add(
      'run',
      {},
      { repeat: { every: 60 * 60 * 1000 } } // every 1 hour
    );

    logger.info('sessionCleanup: repeatable job registered (every 1h)');
  } catch (err) {
    logger.error('sessionCleanup: failed to register job', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// startSessionCleanupWorker
// ---------------------------------------------------------------------------

export function startSessionCleanupWorker() {
  try {
    const worker = createWorker(QUEUE_NAME, async () => {
      logger.info('sessionCleanup: job started');

      await markStaleSessions();
      await pruneOldRecordings();
      await pruneOldStoredRecordings();

      logger.info('sessionCleanup: job complete');
    });

    worker.on('failed', (job, err) => {
      logger.error(`sessionCleanup: job ${job?.id} failed`, { error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('sessionCleanup: worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('sessionCleanup: failed to start worker', { error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// markStaleSessions — close ACTIVE sessions older than STALE_SESSION_HOURS
// ---------------------------------------------------------------------------

async function markStaleSessions() {
  const cutoff = new Date(Date.now() - STALE_SESSION_HOURS * 60 * 60 * 1000);

  const stale = await prisma.session.findMany({
    where: {
      status: 'ACTIVE',
      startedAt: { lt: cutoff },
    },
    select: { id: true, orgId: true, startedAt: true },
  });

  if (stale.length === 0) {
    logger.info('sessionCleanup: no stale sessions found');
    return;
  }

  logger.info(`sessionCleanup: marking ${stale.length} stale session(s) as ENDED`);

  for (const session of stale) {
    try {
      await sessionService.end(session.id, { status: 'ENDED' });
      logger.info('sessionCleanup: stale session ended', { sessionId: session.id });
    } catch (err) {
      logger.error('sessionCleanup: failed to end stale session', {
        sessionId: session.id,
        error: err.message,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// pruneOldStoredRecordings — delete objects older than the retention window
//
// Recordings have been streamed straight into object storage since the
// terminal hub was rewritten; `recordingPath` is the older, on-disk form and
// is all `pruneOldRecordings` below has ever looked at. So every recording
// written by a current installation — SSH casts and, now, RDP `.guac` files —
// sat in the bucket for ever, while the product documented a 30-day retention
// window and the Sessions page offered them for download indefinitely.
//
// The object is deleted first and the column nulled second. The other order
// would, on a crash in between, leave a row claiming a recording that no
// longer exists — which reads as "the recording was lost" rather than "the
// recording was retained for exactly as long as we said".
// ---------------------------------------------------------------------------

async function pruneOldStoredRecordings() {
  const cutoff = new Date(Date.now() - RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const sessions = await prisma.session.findMany({
    where: { recordingKey: { not: null }, endedAt: { lt: cutoff } },
    select: { id: true, recordingKey: true },
  });

  if (sessions.length === 0) {
    logger.info('sessionCleanup: no expired stored recordings to prune');
    return;
  }

  logger.info(`sessionCleanup: pruning ${sessions.length} expired stored recording(s)`);

  for (const session of sessions) {
    try {
      await storageService.deleteObject(session.recordingKey);
    } catch (err) {
      // Already gone is success — that is the state we were aiming for.
      const gone = err?.code === 'NoSuchKey' || err?.code === 'NotFound';
      if (!gone) {
        logger.warn('sessionCleanup: failed to delete stored recording', {
          sessionId: session.id,
          error: err.message,
        });
        // Leave recordingKey set so the next pass tries again. Nulling it here
        // would orphan the object: nothing would ever reference it again, and
        // nothing would ever delete it either.
        continue;
      }
    }

    try {
      await prisma.session.update({ where: { id: session.id }, data: { recordingKey: null } });
    } catch (err) {
      logger.error('sessionCleanup: failed to null recordingKey', {
        sessionId: session.id,
        error: err.message,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// pruneOldRecordings — delete .cast files older than retention window
// ---------------------------------------------------------------------------

async function pruneOldRecordings() {
  const cutoff = new Date(Date.now() - RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Find sessions with a recordingPath whose session ended before cutoff
  const sessions = await prisma.session.findMany({
    where: {
      recordingPath: { not: null },
      endedAt: { lt: cutoff },
    },
    select: { id: true, recordingPath: true },
  });

  if (sessions.length === 0) {
    logger.info('sessionCleanup: no expired recordings to prune');
    return;
  }

  logger.info(`sessionCleanup: pruning ${sessions.length} expired recording(s)`);

  for (const session of sessions) {
    const absPath = path.resolve(session.recordingPath);

    // Delete the file
    try {
      await fs.promises.unlink(absPath);
      logger.info('sessionCleanup: recording deleted', { sessionId: session.id, path: absPath });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('sessionCleanup: failed to delete recording file', {
          sessionId: session.id,
          path: absPath,
          error: err.message,
        });
      }
      // Continue — still null the path even if file was already gone
    }

    // Null out the recordingPath on the Session row
    try {
      await prisma.session.update({
        where: { id: session.id },
        data: { recordingPath: null },
      });
    } catch (err) {
      logger.error('sessionCleanup: failed to null recordingPath', {
        sessionId: session.id,
        error: err.message,
      });
    }
  }
}
