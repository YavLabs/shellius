/**
 * quickConnectHistoryPrune — deletes QuickConnectHistory rows past the
 * 7-day retention window. Live-DB integration test (dbReachable() skip
 * pattern — see services/__tests__/testDbHelper.js).
 */

import prisma from '../../config/db.js';
import { pruneExpiredHistory } from '../quickConnectHistoryPrune.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

describe('quickConnectHistoryPrune.pruneExpiredHistory', () => {
  let reachable;
  let org;
  let user;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] quickConnectHistoryPrune: no live DB');
      return;
    }
    org = await createTestOrg();
    user = await createTestUser(org.id, { role: 'manager' });
  });

  afterAll(async () => {
    if (!reachable || !org) return;
    await prisma.quickConnectHistory.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const maybeTest = (name, fn) =>
    test(name, async () => {
      if (!reachable) return;
      await fn();
    });

  maybeTest('deletes rows older than 7 days and keeps recent ones', async () => {
    const fresh = await prisma.quickConnectHistory.create({
      data: {
        orgId: org.id, userId: user.id, host: '203.0.113.90', port: 22, username: 'a',
        authType: 'password', lastStatus: 'connected', lastConnectedAt: new Date(),
      },
    });
    const stale = await prisma.quickConnectHistory.create({
      data: {
        orgId: org.id, userId: user.id, host: '203.0.113.91', port: 22, username: 'b',
        authType: 'password', lastStatus: 'connected',
        lastConnectedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      },
    });
    const boundary = await prisma.quickConnectHistory.create({
      data: {
        orgId: org.id, userId: user.id, host: '203.0.113.92', port: 22, username: 'c',
        authType: 'password', lastStatus: 'connected',
        // Just inside the 7-day window (6 days, 23 hours ago) — must survive.
        lastConnectedAt: new Date(Date.now() - (7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000)),
      },
    });

    const result = await pruneExpiredHistory();
    expect(result.count).toBeGreaterThanOrEqual(1);

    expect(await prisma.quickConnectHistory.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await prisma.quickConnectHistory.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await prisma.quickConnectHistory.findUnique({ where: { id: boundary.id } })).not.toBeNull();
  });
});
