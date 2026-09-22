/**
 * GET /api/sessions and /api/sessions/active — new filters/search/sort
 * (Sessions filter/search/sort task). Live DB; auto-skips when unreachable.
 */

import express from 'express';
import request from 'supertest';
import prisma from '../../config/db.js';
import sessionsRouter from '../sessions.js';
import errorHandler from '../../middleware/errorHandler.js';
import { generateAccessToken } from '../../utils/jwt.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

let seq = 0;
function uniq() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

describe('GET /api/sessions filters/search/sort (live DB)', () => {
  const app = buildApp();
  let reachable = false;
  let org;
  let admin;
  let scopedAdmin;
  let sessionUser;
  let adminToken;
  let scopedAdminToken;
  let customerA;
  let customerB;
  let serverA;
  let serverB;
  let sessionA;
  let sessionB;
  let activeSession;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] sessions list filters: no live DB');
      return;
    }
    org = await createTestOrg();
    admin = await createTestUser(org.id, { role: 'admin' });
    scopedAdmin = await createTestUser(org.id, { role: 'admin', data: { accessScope: 'CUSTOMERS' } });
    sessionUser = await createTestUser(org.id, { role: 'member', name: 'Session Owner' });
    adminToken = generateAccessToken({ userId: admin.id, orgId: org.id });
    scopedAdminToken = generateAccessToken({ userId: scopedAdmin.id, orgId: org.id });

    customerA = await prisma.customer.create({ data: { orgId: org.id, name: 'Acme Corp', slug: `acme-${uniq()}` } });
    customerB = await prisma.customer.create({ data: { orgId: org.id, name: 'Beta Inc', slug: `beta-${uniq()}` } });
    await prisma.userCustomerScope.create({ data: { userId: scopedAdmin.id, customerId: customerA.id } });

    serverA = await prisma.server.create({
      data: { orgId: org.id, customerId: customerA.id, hostname: 'zeta.internal', displayName: 'Zeta box', ipAddress: '10.1.0.1', environment: 'dev' },
    });
    serverB = await prisma.server.create({
      data: { orgId: org.id, customerId: customerB.id, hostname: 'alpha.internal', displayName: 'Alpha box', ipAddress: '10.2.0.1', environment: 'dev' },
    });

    sessionA = await prisma.session.create({
      data: {
        orgId: org.id, userId: sessionUser.id, serverId: serverA.id, sessionType: 'SSH', status: 'ENDED',
        clientIp: '203.0.113.5', startedAt: new Date(Date.now() - 3600_000), endedAt: new Date(),
      },
    });
    sessionB = await prisma.session.create({
      data: {
        orgId: org.id, userId: sessionUser.id, serverId: serverB.id, sessionType: 'SSH', status: 'ENDED',
        clientIp: '198.51.100.9', startedAt: new Date(Date.now() - 1800_000), endedAt: new Date(),
      },
    });
    activeSession = await prisma.session.create({
      data: {
        orgId: org.id, userId: sessionUser.id, serverId: serverA.id, sessionType: 'SSH', status: 'ACTIVE',
        clientIp: '203.0.113.5', startedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (!reachable) return;
    await cleanupOrg(org.id);
  });

  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  test('search matches server hostname', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/sessions').query({ search: 'zeta' }).set(auth(adminToken)).expect(200);
    const ids = res.body.data.items.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([sessionA.id, activeSession.id]));
    expect(ids).not.toContain(sessionB.id);
  });

  test('clientIp filter is a contains match', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/sessions').query({ clientIp: '198.51' }).set(auth(adminToken)).expect(200);
    const ids = res.body.data.items.map((s) => s.id);
    expect(ids).toEqual([sessionB.id]);
  });

  test('customerId filter narrows via the server relation', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/sessions').query({ customerId: customerB.id }).set(auth(adminToken)).expect(200);
    const ids = res.body.data.items.map((s) => s.id);
    expect(ids).toEqual([sessionB.id]);
  });

  test('a scoped caller filtering by an out-of-scope customer gets nothing', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/sessions').query({ customerId: customerB.id }).set(auth(scopedAdminToken)).expect(200);
    expect(res.body.data.items).toEqual([]);
  });

  test('sortBy whitelist rejects an unknown column with 400', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/sessions').query({ sortBy: 'clientIp' }).set(auth(adminToken)).expect(400);
    expect(res.body.success).toBe(false);
  });

  test('GET /api/sessions/active applies filters (search)', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/sessions/active').query({ search: 'alpha' }).set(auth(adminToken)).expect(200);
    // Only ACTIVE sessions are on serverA; searching for "alpha" (serverB) finds none.
    expect(res.body.data.items).toEqual([]);
  });

  test('GET /api/sessions/active returns the active session unfiltered', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/sessions/active').set(auth(adminToken)).expect(200);
    const ids = res.body.data.items.map((s) => s.id);
    expect(ids).toContain(activeSession.id);
  });

  test('GET /api/sessions/active respects customer scope', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/sessions/active').query({ customerId: customerB.id }).set(auth(scopedAdminToken)).expect(200);
    expect(res.body.data.items).toEqual([]);
  });
});
