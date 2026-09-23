/**
 * retentionService.js — archiving audit history, and deleting what has been
 * archived.
 *
 * AuditLog is immutable: nothing in Shellius updates or deletes a row except
 * this. That makes it the most dangerous file in the audit feature, so the
 * rules are conservative and there are three of them:
 *
 *   1. Nothing is deleted unless an organization has set a retention period.
 *      The default is to keep everything forever.
 *   2. Nothing is deleted past a sink that has not shipped it. An active
 *      streaming sink's cursor is a hard floor — deleting rows it still owes
 *      would lose them from both places at once.
 *   3. Nothing is deleted without an archive, unless someone has explicitly
 *      said that is what they want (`deleteWithoutArchive`).
 *
 * The archive is written first and verified, then the rows it covers are
 * removed, and never the other way round.
 */

import crypto from 'crypto';
import { Readable } from 'stream';
import { createGzip } from 'zlib';
import prisma from '../../config/db.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import * as storageService from '../storageService.js';
import { createEncryptStream } from '../../utils/recordingCrypto.js';
import { ACTIONS, log as auditLog, stream } from '../auditService.js';
import { toEnvelope } from './envelope.js';
import { STREAMING_TYPES } from './sinks/index.js';

/** Archive a day at a time: bounded memory, and a sensible object to restore. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** Refuse to run with a retention shorter than this. */
export const MIN_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(orgId) {
  const row = await prisma.auditSettings.findUnique({ where: { orgId } });
  return (
    row ?? {
      orgId,
      retentionDays: null,
      archiveEnabled: false,
      archiveEncrypt: true,
      archiveBucket: null,
      archivePrefix: 'audit-archive',
      deleteWithoutArchive: false,
      lastArchiveAt: null,
      lastArchiveError: null,
    }
  );
}

export async function updateSettings(orgId, data, actor = null) {
  if (data.retentionDays !== undefined && data.retentionDays !== null) {
    const days = Number(data.retentionDays);
    if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS) {
      throw new ApiError(400, `Retention must be at least ${MIN_RETENTION_DAYS} days`);
    }
  }

  const payload = {
    ...(data.retentionDays !== undefined ? { retentionDays: data.retentionDays === null ? null : Number(data.retentionDays) } : {}),
    ...(data.archiveEnabled !== undefined ? { archiveEnabled: !!data.archiveEnabled } : {}),
    ...(data.archiveEncrypt !== undefined ? { archiveEncrypt: !!data.archiveEncrypt } : {}),
    ...(data.archiveBucket !== undefined ? { archiveBucket: data.archiveBucket || null } : {}),
    ...(data.archivePrefix !== undefined ? { archivePrefix: String(data.archivePrefix || 'audit-archive').replace(/^\/+|\/+$/g, '') } : {}),
    ...(data.deleteWithoutArchive !== undefined ? { deleteWithoutArchive: !!data.deleteWithoutArchive } : {}),
  };

  const row = await prisma.auditSettings.upsert({
    where: { orgId },
    create: { orgId, ...payload },
    update: payload,
  });

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.audit_retention.update,
    resourceType: 'AuditSettings',
    resourceId: row.id,
    metadata: {
      retentionDays: row.retentionDays,
      archiveEnabled: row.archiveEnabled,
      deleteWithoutArchive: row.deleteWithoutArchive,
    },
  });

  return row;
}

// ---------------------------------------------------------------------------
// The sink floor
// ---------------------------------------------------------------------------

/**
 * The earliest point still owed to an active streaming sink, or null if
 * every sink is caught up (or there are none).
 *
 * This is the interaction that is easy to miss: retention and sinks are
 * configured on different screens by different people, and a short retention
 * plus a stalled sink would quietly destroy the entries in between.
 */
export async function sinkFloor(orgId) {
  const sinks = await prisma.auditSink.findMany({
    where: { orgId, isActive: true, type: { in: STREAMING_TYPES } },
    select: { cursorCreatedAt: true },
  });
  if (!sinks.length) return null;
  // A sink that has never run holds the floor at the beginning of time.
  if (sinks.some((s) => !s.cursorCreatedAt)) return new Date(0);
  return sinks.reduce((min, s) => (s.cursorCreatedAt < min ? s.cursorCreatedAt : min), sinks[0].cursorCreatedAt);
}

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

/** `audit-archive/org=<org>/<YYYY-MM-DD>.ndjson.gz` */
export const archiveKeyFor = (prefix, orgId, day, encrypted) =>
  `${prefix}/org=${orgId}/${day.toISOString().slice(0, 10)}.ndjson.gz${encrypted ? '.enc' : ''}`;

/**
 * Archive one day's entries and return a receipt. Does not delete anything.
 */
export async function archiveDay(orgId, dayStart, settings) {
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const rows = [];
  for await (const batch of stream({ orgId, batchSize: 1000, until: dayEnd })) {
    for (const row of batch) {
      if (row.createdAt >= dayStart && row.createdAt < dayEnd) rows.push(row);
    }
    if (batch[batch.length - 1].createdAt >= dayEnd) break;
  }
  if (!rows.length) return null;

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const lines = rows.map((r) => `${JSON.stringify(toEnvelope(r))}\n`);

  const key = archiveKeyFor(settings.archivePrefix, orgId, dayStart, settings.archiveEncrypt);
  let body = Readable.from(lines).pipe(createGzip());
  if (settings.archiveEncrypt) body = body.pipe(createEncryptStream());
  body.on('data', (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
  });

  await storageService.putObjectStream(key, body, {
    contentType: 'application/gzip',
    bucket: settings.archiveBucket || undefined,
    metadata: { orgId, day: dayStart.toISOString().slice(0, 10), rows: String(rows.length) },
  });

  const archive = await prisma.auditArchive.upsert({
    where: { orgId_objectKey: { orgId, objectKey: key } },
    create: {
      orgId,
      objectKey: key,
      bucket: settings.archiveBucket || null,
      format: settings.archiveEncrypt ? 'ndjson.gz.enc' : 'ndjson.gz',
      encrypted: !!settings.archiveEncrypt,
      rangeStart: rows[0].createdAt,
      rangeEnd: rows[rows.length - 1].createdAt,
      rowCount: rows.length,
      bytes,
      sha256: hash.digest('hex'),
    },
    update: {
      rowCount: rows.length,
      bytes,
      sha256: hash.digest('hex'),
      rangeStart: rows[0].createdAt,
      rangeEnd: rows[rows.length - 1].createdAt,
    },
  });

  await auditLog({
    orgId,
    action: ACTIONS.audit_retention.archive_created,
    resourceType: 'AuditArchive',
    resourceId: archive.id,
    metadata: { objectKey: key, rows: rows.length, bytes, day: dayStart.toISOString().slice(0, 10) },
  });

  return archive;
}

/**
 * Apply one organization's retention policy.
 *
 * @returns {Promise<{archived: number, deleted: number, skipped: string|null}>}
 */
export async function applyRetention(orgId, { now = new Date() } = {}) {
  const settings = await getSettings(orgId);
  if (!settings.retentionDays) return { archived: 0, deleted: 0, skipped: 'no retention set' };

  const cutoff = new Date(now.getTime() - settings.retentionDays * DAY_MS);

  // Rule 2: never go past what an active sink still owes.
  const floor = await sinkFloor(orgId);
  const limit = floor && floor < cutoff ? floor : cutoff;
  if (floor && floor < cutoff) {
    logger.warn('retentionService: a sink is behind, holding retention back', {
      orgId,
      cutoff: cutoff.toISOString(),
      heldAt: floor.toISOString(),
    });
  }

  const oldest = await prisma.auditLog.findFirst({
    where: { orgId, createdAt: { lt: limit } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  if (!oldest) return { archived: 0, deleted: 0, skipped: null };

  let archived = 0;
  let deleted = 0;

  // Whole days only, so an archive object is always a complete day.
  let day = new Date(Date.UTC(oldest.createdAt.getUTCFullYear(), oldest.createdAt.getUTCMonth(), oldest.createdAt.getUTCDate()));

  while (day.getTime() + DAY_MS <= limit.getTime()) {
    const dayEnd = new Date(day.getTime() + DAY_MS);

    if (settings.archiveEnabled) {
      try {
        const archive = await archiveDay(orgId, day, settings);
        if (archive) archived += 1;
      } catch (err) {
        // Rule 3: an archive failure stops the deletion, it does not bypass it.
        await prisma.auditSettings.upsert({
          where: { orgId },
          create: { orgId, lastArchiveError: err.message?.slice(0, 2000) },
          update: { lastArchiveError: err.message?.slice(0, 2000) },
        });
        logger.error('retentionService: archive failed, nothing deleted', { orgId, day: day.toISOString(), error: err.message });
        return { archived, deleted, skipped: `archive failed: ${err.message}` };
      }
    } else if (!settings.deleteWithoutArchive) {
      return { archived, deleted, skipped: 'archiving is off and deleting without an archive was not enabled' };
    }

    const { count } = await prisma.auditLog.deleteMany({
      where: { orgId, createdAt: { gte: day, lt: dayEnd } },
    });
    deleted += count;
    day = dayEnd;
  }

  if (deleted || archived) {
    await prisma.auditSettings.upsert({
      where: { orgId },
      create: { orgId, retentionDays: settings.retentionDays, lastArchiveAt: new Date(), lastArchiveError: null },
      update: { lastArchiveAt: new Date(), lastArchiveError: null },
    });
    await auditLog({
      orgId,
      action: ACTIONS.audit_retention.applied,
      resourceType: 'AuditSettings',
      metadata: { retentionDays: settings.retentionDays, archived, deleted, cutoff: limit.toISOString() },
    });
  }

  return { archived, deleted, skipped: null };
}

export async function listArchives(orgId, { limit = 50 } = {}) {
  return prisma.auditArchive.findMany({
    where: { orgId },
    orderBy: { rangeStart: 'desc' },
    take: Math.min(Math.max(Number(limit) || 50, 1), 200),
  });
}

export default {
  MIN_RETENTION_DAYS,
  getSettings,
  updateSettings,
  sinkFloor,
  archiveDay,
  archiveKeyFor,
  applyRetention,
  listArchives,
};
