/**
 * sessionService.listRecentServersForUser — dashboard "Recent connections".
 * Own sessions only, one row per server, newest first, Quick Connect and
 * old sessions excluded. Live-DB test.
 */

import prisma from '../../config/db.js';
import { listRecentServersForUser } from '../sessionService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

describe('sessionService.listRecentServersForUser', () => {
  let reachable;
  let org;
  let me;
  let other;
  let s1;
  let s2;
  let s3;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) return;
    org = await createTestOrg();
    me = await createTestUser(org.id, { role: 'member' });
    other = await createTestUser(org.id, { role: 'member' });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: 'Acme', slug: `acme-${Date.now()}` } });
    const mk = (hostname, ip) => prisma.server.create({ data: { orgId: org.id, customerId: customer.id, hostname, ipAddress: ip, environment: 'dev' } });
    [s1, s2, s3] = await Promise.all([mk('one.internal', '10.40.0.1'), mk('two.internal', '10.40.0.2'), mk('three.internal', '10.40.0.3')]);
    const session = (userId, serverId, startedAt, authMethod = 'certificate') =>
      prisma.session.create({ data: { orgId: org.id, userId, serverId, sessionType: 'SSH', authMethod, startedAt } });
    const ago = (h) => new Date(Date.now() - h * 3600 * 1000);
    await session(me.id, s1.id, ago(5));
    await session(me.id, s1.id, ago(1)); // s1: twice, latest 1h ago
    await session(me.id, s2.id, ago(3));
    await session(me.id, s3.id, ago(24 * 10)); // too old
    await session(me.id, s3.id, ago(0.5), 'quick_connect'); // QC: listed via QC history, not here
    await session(other.id, s2.id, ago(0.1)); // someone else's
  });

  afterAll(async () => {
    if (reachable && org) await cleanupOrg(org.id);
  });

  test('own servers only, newest first, counted, QC and old excluded', async () => {
    if (!reachable) return;
    const rows = await listRecentServersForUser(org.id, me.id, { days: 7 });
    expect(rows.map((r) => r.server.hostname)).toEqual(['one.internal', 'two.internal']);
    expect(rows[0].connectCount).toBe(2);
    expect(rows[1].connectCount).toBe(1);
  });

  test("another user's activity is never included", async () => {
    if (!reachable) return;
    const rows = await listRecentServersForUser(org.id, other.id, { days: 7 });
    expect(rows.map((r) => r.server.hostname)).toEqual(['two.internal']);
  });
});
