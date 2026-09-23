/**
 * Audit retention — the only code in Shellius that deletes an AuditLog row.
 *
 * Every test here is a guard on that. The three rules:
 *   1. nothing is deleted unless a retention period was set;
 *   2. nothing is deleted past what an active sink still owes;
 *   3. nothing is deleted without an archive, unless that was asked for.
 *
 * Rule 2 is the one worth the most attention: retention and sinks are
 * configured on different screens by different people, and a short retention
 * plus a stalled sink would destroy entries that never reached either place.
 */

import prisma from '../../config/db.js';
import * as retentionService from '../audit/retentionService.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

const DAY = 24 * 60 * 60 * 1000;

let org;

async function seedDays(days, perDay = 3) {
  const rows = [];
  for (let d = 0; d < days; d += 1) {
    const base = Date.now() - (days - d) * DAY;
    for (let i = 0; i < perDay; i += 1) {
      rows.push({
        orgId: org.id,
        action: 'user.updated',
        resourceType: 'User',
        createdAt: new Date(base + i * 1000),
      });
    }
  }
  await prisma.auditLog.createMany({ data: rows });
}

const countLogs = () => prisma.auditLog.count({ where: { orgId: org.id } });

describe('audit retention (live DB)', () => {
  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.auditArchive.deleteMany({ where: { orgId: org.id } });
    await prisma.auditSettings.deleteMany({ where: { orgId: org.id } });
    await prisma.auditSink.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  afterEach(async () => {
    if (!org) return;
    await prisma.auditArchive.deleteMany({ where: { orgId: org.id } });
    await prisma.auditSettings.deleteMany({ where: { orgId: org.id } });
    await prisma.auditSink.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
  });

  test('an org that has set nothing keeps everything', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seedDays(60);
    const before = await countLogs();

    const result = await retentionService.applyRetention(org.id);

    expect(result).toMatchObject({ deleted: 0, skipped: 'no retention set' });
    expect(await countLogs()).toBe(before);
  });

  test('retention alone does not delete — an archive, or explicit consent, is required', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seedDays(60);
    await retentionService.updateSettings(org.id, { retentionDays: 30 });
    const before = await countLogs();

    const result = await retentionService.applyRetention(org.id);

    expect(result.deleted).toBe(0);
    expect(result.skipped).toMatch(/archiving is off/);
    expect(await countLogs()).toBe(before);
  });

  test('with explicit consent and no archive, old entries are deleted and recent ones are not', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seedDays(60, 2);
    await retentionService.updateSettings(org.id, { retentionDays: 30, deleteWithoutArchive: true });

    const result = await retentionService.applyRetention(org.id);

    expect(result.deleted).toBeGreaterThan(0);
    const remaining = await prisma.auditLog.findMany({ where: { orgId: org.id }, select: { createdAt: true } });
    const cutoff = Date.now() - 30 * DAY;
    // Nothing older than the cutoff survived, and plenty newer did.
    expect(remaining.every((r) => r.createdAt.getTime() >= cutoff - DAY)).toBe(true);
    expect(remaining.length).toBeGreaterThan(0);
  });

  test('a sink that has never run holds retention at the beginning of time', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seedDays(60, 2);
    await prisma.auditSink.create({
      data: { orgId: org.id, name: 'siem', type: 'webhook', isActive: true, cursorCreatedAt: null },
    });
    await retentionService.updateSettings(org.id, { retentionDays: 30, deleteWithoutArchive: true });
    const before = await countLogs();

    const result = await retentionService.applyRetention(org.id);

    // Not one row: the sink is owed all of them.
    expect(result.deleted).toBe(0);
    expect(await countLogs()).toBe(before);
    expect(await retentionService.sinkFloor(org.id)).toEqual(new Date(0));
  });

  test('a sink that is behind holds retention at its cursor', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seedDays(60, 2);
    // Caught up only to 50 days ago, while retention wants to cut at 30.
    const cursor = new Date(Date.now() - 50 * DAY);
    await prisma.auditSink.create({
      data: { orgId: org.id, name: 'slow siem', type: 'webhook', isActive: true, cursorCreatedAt: cursor, cursorId: 'x' },
    });
    await retentionService.updateSettings(org.id, { retentionDays: 30, deleteWithoutArchive: true });

    await retentionService.applyRetention(org.id);

    const remaining = await prisma.auditLog.findMany({ where: { orgId: org.id }, select: { createdAt: true } });
    const oldest = Math.min(...remaining.map((r) => r.createdAt.getTime()));
    // Entries between 50 and 30 days old are still here — the sink owes them.
    expect(oldest).toBeLessThan(Date.now() - 31 * DAY);
    expect(oldest).toBeGreaterThanOrEqual(new Date(Date.UTC(
      cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()
    )).getTime());
  });

  test('an inactive sink does not hold retention back', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await prisma.auditSink.create({
      data: { orgId: org.id, name: 'off', type: 'webhook', isActive: false, cursorCreatedAt: new Date(0) },
    });
    expect(await retentionService.sinkFloor(org.id)).toBeNull();
  });

  test('a digest sink does not hold retention back — it has no cursor to be behind', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await prisma.auditSink.create({
      data: { orgId: org.id, name: 'daily', type: 'email_digest', isActive: true, cursorCreatedAt: null },
    });
    expect(await retentionService.sinkFloor(org.id)).toBeNull();
  });

  test('retention shorter than the floor is refused', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await expect(retentionService.updateSettings(org.id, { retentionDays: 1 })).rejects.toThrow(/at least/);
    await expect(retentionService.updateSettings(org.id, { retentionDays: 0 })).rejects.toThrow(/at least/);
    // …but "keep forever" is always allowed.
    const kept = await retentionService.updateSettings(org.id, { retentionDays: null });
    expect(kept.retentionDays).toBeNull();
  });

  test('an archive key is stable and says what it holds', () => {
    const key = retentionService.archiveKeyFor('audit-archive', 'org1', new Date('2026-03-04T00:00:00Z'), false);
    expect(key).toBe('audit-archive/org=org1/2026-03-04.ndjson.gz');
    expect(retentionService.archiveKeyFor('audit-archive', 'org1', new Date('2026-03-04T00:00:00Z'), true)).toMatch(/\.enc$/);
  });
});
