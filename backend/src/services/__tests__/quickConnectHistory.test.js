/**
 * quickConnectService — Quick Connect history tests (recordHistory,
 * listHistory, deleteHistory, clearHistory, reconnectFromHistory).
 *
 * Live-DB integration test (dbReachable() skip pattern — see
 * quickConnectProdGuard.test.js / testDbHelper.js).
 */

import prisma from '../../config/db.js';
import * as quickConnectService from '../quickConnectService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

describe('quickConnectService — Quick Connect history', () => {
  let reachable;
  let org;
  let user;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] quickConnectHistory: no live DB');
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

  const maybeTest = (name, fn, timeout) =>
    test(
      name,
      async () => {
        if (!reachable) return;
        await fn();
      },
      timeout
    );

  afterEach(async () => {
    if (!reachable) return;
    await prisma.quickConnectHistory.deleteMany({ where: { orgId: org.id } });
  });

  // -------------------------------------------------------------------
  // recordHistory — upsert / connectCount semantics
  // -------------------------------------------------------------------

  maybeTest('creates a row on first record, connectCount 1 for a connected session', async () => {
    const row = await quickConnectService.recordHistory({
      orgId: org.id,
      userId: user.id,
      host: '203.0.113.20',
      port: 22,
      username: 'testuser',
      authType: 'password',
      sessionId: 'sess-1',
      status: 'connected',
    });
    expect(row.connectCount).toBe(1);
    expect(row.lastStatus).toBe('connected');
    expect(row.lastSessionId).toBe('sess-1');
  });

  maybeTest('creates a row with connectCount 0 when the very first attempt fails', async () => {
    const row = await quickConnectService.recordHistory({
      orgId: org.id,
      userId: user.id,
      host: '203.0.113.21',
      port: 22,
      username: 'testuser',
      authType: 'password',
      sessionId: null,
      status: 'failed',
      error: 'Authentication failed',
    });
    expect(row.connectCount).toBe(0);
    expect(row.lastStatus).toBe('failed');
    expect(row.lastError).toBe('Authentication failed');
  });

  maybeTest('upserts on (userId, host, port, username): increments connectCount only on a new connected session', async () => {
    const key = { orgId: org.id, userId: user.id, host: '203.0.113.22', port: 22, username: 'testuser', authType: 'password' };

    const first = await quickConnectService.recordHistory({ ...key, sessionId: 'sess-a', status: 'connected' });
    expect(first.connectCount).toBe(1);

    // A failed status update on the same target must NOT bump connectCount.
    const failed = await quickConnectService.recordHistory({ ...key, sessionId: null, status: 'failed', error: 'boom' });
    expect(failed.connectCount).toBe(1);
    expect(failed.lastStatus).toBe('failed');
    expect(failed.lastError).toBe('boom');

    // A second successful session on the same target increments again — and
    // this remains a single row (upsert), not a second row.
    const second = await quickConnectService.recordHistory({ ...key, sessionId: 'sess-b', status: 'connected' });
    expect(second.connectCount).toBe(2);
    expect(second.lastStatus).toBe('connected');
    expect(second.lastError).toBeNull();

    const count = await prisma.quickConnectHistory.count({ where: { orgId: org.id, userId: user.id, host: key.host } });
    expect(count).toBe(1);
  });

  // -------------------------------------------------------------------
  // listHistory — 7-day filter, org scoping, deleted refs handled gracefully
  // -------------------------------------------------------------------

  maybeTest('listHistory only returns rows within the 7-day window, newest first', async () => {
    await quickConnectService.recordHistory({
      orgId: org.id, userId: user.id, host: '203.0.113.30', port: 22, username: 'a',
      authType: 'password', sessionId: 's1', status: 'connected',
    });
    await quickConnectService.recordHistory({
      orgId: org.id, userId: user.id, host: '203.0.113.31', port: 22, username: 'b',
      authType: 'password', sessionId: 's2', status: 'connected',
    });
    // Simulate a stale row (8 days old) directly — recordHistory always sets "now".
    await prisma.quickConnectHistory.create({
      data: {
        orgId: org.id, userId: user.id, host: '203.0.113.32', port: 22, username: 'c',
        authType: 'password', lastStatus: 'connected',
        lastConnectedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      },
    });

    const items = await quickConnectService.listHistory(org.id, user.id, { limit: 10 });
    const hosts = items.map((i) => i.host);
    expect(hosts).toContain('203.0.113.30');
    expect(hosts).toContain('203.0.113.31');
    expect(hosts).not.toContain('203.0.113.32');
    // newest first
    expect(items[0].host).toBe('203.0.113.31');
  });

  maybeTest('listHistory resolves credential/server metadata and nulls out deleted references', async () => {
    const customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${Date.now()}` },
    });
    const server = await prisma.server.create({
      data: {
        orgId: org.id, customerId: customer.id, hostname: 'dev-box.internal',
        ipAddress: '203.0.113.40', environment: 'dev', displayName: 'Dev Box',
      },
    });
    const credential = await prisma.credential.create({
      data: { orgId: org.id, name: `id-${Date.now()}`, username: 'deploy', authType: 'password', passwordEncrypted: 'enc' },
    });

    await quickConnectService.recordHistory({
      orgId: org.id, userId: user.id, host: '203.0.113.40', port: 22, username: 'deploy',
      authType: 'credential', credentialId: credential.id, serverId: server.id,
      sessionId: 's3', status: 'connected',
    });
    // A row referencing a since-deleted credential.
    await quickConnectService.recordHistory({
      orgId: org.id, userId: user.id, host: '203.0.113.41', port: 22, username: 'ghost',
      authType: 'credential', credentialId: 'does-not-exist', serverId: null,
      sessionId: 's4', status: 'connected',
    });

    const items = await quickConnectService.listHistory(org.id, user.id, { limit: 10 });
    const withServer = items.find((i) => i.host === '203.0.113.40');
    expect(withServer.credential).toMatchObject({ id: credential.id });
    expect(withServer.server).toMatchObject({ id: server.id, displayName: 'Dev Box' });

    const ghost = items.find((i) => i.host === '203.0.113.41');
    expect(ghost.credential).toBeNull();
    expect(ghost.server).toBeNull();
  });

  // -------------------------------------------------------------------
  // deleteHistory / clearHistory — ownership scoping
  // -------------------------------------------------------------------

  maybeTest('deleteHistory removes only the caller\'s own row', async () => {
    const other = await createTestUser(org.id, { role: 'manager' });
    const row = await quickConnectService.recordHistory({
      orgId: org.id, userId: user.id, host: '203.0.113.50', port: 22, username: 'a',
      authType: 'password', sessionId: 's5', status: 'connected',
    });

    await expect(quickConnectService.deleteHistory(org.id, other.id, row.id)).rejects.toMatchObject({ statusCode: 404 });
    await quickConnectService.deleteHistory(org.id, user.id, row.id);
    expect(await prisma.quickConnectHistory.findUnique({ where: { id: row.id } })).toBeNull();
  });

  maybeTest('clearHistory removes only the caller\'s rows', async () => {
    const other = await createTestUser(org.id, { role: 'manager' });
    await quickConnectService.recordHistory({
      orgId: org.id, userId: user.id, host: '203.0.113.60', port: 22, username: 'a',
      authType: 'password', sessionId: 's6', status: 'connected',
    });
    await quickConnectService.recordHistory({
      orgId: org.id, userId: other.id, host: '203.0.113.61', port: 22, username: 'b',
      authType: 'password', sessionId: 's7', status: 'connected',
    });

    const result = await quickConnectService.clearHistory(org.id, user.id);
    expect(result.count).toBe(1);
    expect(await prisma.quickConnectHistory.count({ where: { orgId: org.id, userId: user.id } })).toBe(0);
    expect(await prisma.quickConnectHistory.count({ where: { orgId: org.id, userId: other.id } })).toBe(1);
  });

  // -------------------------------------------------------------------
  // reconnectFromHistory — SECRET_REQUIRED vs ticket, all createTicket guards
  // -------------------------------------------------------------------

  maybeTest('reconnectFromHistory returns 409 SECRET_REQUIRED for non-credential authType', async () => {
    const row = await quickConnectService.recordHistory({
      orgId: org.id, userId: user.id, host: '203.0.113.70', port: 22, username: 'a',
      authType: 'password', sessionId: 's8', status: 'connected',
    });

    await expect(
      quickConnectService.reconnectFromHistory(org.id, { id: user.id, role: 'manager' }, row.id)
    ).rejects.toMatchObject({ statusCode: 409, code: 'SECRET_REQUIRED' });
  });

  maybeTest('reconnectFromHistory returns 409 SECRET_REQUIRED when the identity has been deleted', async () => {
    const row = await quickConnectService.recordHistory({
      orgId: org.id, userId: user.id, host: '203.0.113.71', port: 22, username: 'a',
      authType: 'credential', credentialId: 'gone-credential-id', sessionId: 's9', status: 'connected',
    });

    await expect(
      quickConnectService.reconnectFromHistory(org.id, { id: user.id, role: 'manager' }, row.id)
    ).rejects.toMatchObject({ statusCode: 409, code: 'SECRET_REQUIRED' });
  });

  maybeTest('reconnectFromHistory issues a ticket (reusing createTicket + its guards) when the identity still exists', async () => {
    const credential = await prisma.credential.create({
      data: { orgId: org.id, name: `id-${Date.now()}`, username: 'deploy', authType: 'password', passwordEncrypted: 'enc' },
    });
    const row = await quickConnectService.recordHistory({
      orgId: org.id, userId: user.id, host: '203.0.113.72', port: 22, username: 'deploy',
      authType: 'credential', credentialId: credential.id, sessionId: 's10', status: 'connected',
    });

    const result = await quickConnectService.reconnectFromHistory(org.id, { id: user.id, role: 'manager' }, row.id);
    expect(result.ticket).toEqual(expect.any(String));
    expect(result.expiresIn).toBe(60);
  }, 15000);

  maybeTest('reconnectFromHistory still enforces the prod guard via createTicket', async () => {
    const customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'ProdCo', slug: `prodco-${Date.now()}` },
    });
    await prisma.server.create({
      data: { orgId: org.id, customerId: customer.id, hostname: 'prod-hist.internal', ipAddress: '203.0.113.80', environment: 'prod' },
    });
    const credential = await prisma.credential.create({
      data: { orgId: org.id, name: `id-${Date.now()}`, username: 'deploy', authType: 'password', passwordEncrypted: 'enc' },
    });
    const row = await quickConnectService.recordHistory({
      orgId: org.id, userId: user.id, host: '203.0.113.80', port: 22, username: 'deploy',
      authType: 'credential', credentialId: credential.id, sessionId: 's11', status: 'connected',
    });

    await expect(
      quickConnectService.reconnectFromHistory(org.id, { id: user.id, role: 'manager' }, row.id)
    ).rejects.toMatchObject({ statusCode: 403, code: 'PROD_HOST_REQUIRES_APPROVAL' });
  }, 15000);
});
