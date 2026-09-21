/**
 * GET /api/access-requests?tab=all — new filters/search/sort (Access
 * Requests filter/search/sort task). Live DB; auto-skips when unreachable.
 */

import express from 'express';
import request from 'supertest';
import prisma from '../../config/db.js';
import accessRequestsRouter from '../accessRequests.js';
import errorHandler from '../../middleware/errorHandler.js';
import { generateAccessToken } from '../../utils/jwt.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/access-requests', accessRequestsRouter);
  app.use(errorHandler);
  return app;
}

let seq = 0;
function uniq() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

describe('GET /api/access-requests filters/search/sort (live DB)', () => {
  const app = buildApp();
  let reachable = false;
  let org;
  let admin; // unscoped admin (access_requests.view_all)
  let scopedAdmin; // admin scoped to customerA only
  let requester;
  let adminToken;
  let scopedAdminToken;
  let customerA;
  let customerB;
  let serverA;
  let serverB;
  let requestA;
  let requestB;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] access-requests list filters: no live DB');
      return;
    }
    org = await createTestOrg();
    admin = await createTestUser(org.id, { role: 'admin' });
    scopedAdmin = await createTestUser(org.id, { role: 'admin', data: { accessScope: 'CUSTOMERS' } });
    requester = await createTestUser(org.id, { role: 'member' });
    adminToken = generateAccessToken({ userId: admin.id, orgId: org.id });
    scopedAdminToken = generateAccessToken({ userId: scopedAdmin.id, orgId: org.id });

    customerA = await prisma.customer.create({ data: { orgId: org.id, name: 'Acme Corp', slug: `acme-${uniq()}` } });
    customerB = await prisma.customer.create({ data: { orgId: org.id, name: 'Beta Inc', slug: `beta-${uniq()}` } });

    // Scoped admin can only see customerA.
    await prisma.userCustomerScope.create({ data: { userId: scopedAdmin.id, customerId: customerA.id } });

    serverA = await prisma.server.create({
      data: {
        orgId: org.id, customerId: customerA.id, hostname: 'zeta.internal', displayName: 'Zeta box',
        ipAddress: '10.1.0.1', environment: 'dev',
      },
    });
    serverB = await prisma.server.create({
      data: {
        orgId: org.id, customerId: customerB.id, hostname: 'alpha.internal', displayName: 'Alpha box',
        ipAddress: '10.2.0.1', environment: 'dev',
      },
    });

    requestA = await prisma.accessRequest.create({
      data: {
        orgId: org.id, requesterId: requester.id, serverId: serverA.id, status: 'APPROVED',
        reason: 'deploy hotfix for customer A', requestedPrincipal: 'deploy', requestedDuration: 3600,
      },
    });
    requestB = await prisma.accessRequest.create({
      data: {
        orgId: org.id, requesterId: requester.id, serverId: serverB.id, status: 'APPROVED',
        reason: 'routine maintenance', requestedPrincipal: 'deploy', requestedDuration: 1800,
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
    const res = await request(app)
      .get('/api/access-requests')
      .query({ tab: 'all', search: 'zeta' })
      .set(auth(adminToken))
      .expect(200);
    const ids = res.body.data.items.map((r) => r.id);
    expect(ids).toContain(requestA.id);
    expect(ids).not.toContain(requestB.id);
  });

  test('search matches reason text', async () => {
    if (!reachable) return;
    const res = await request(app)
      .get('/api/access-requests')
      .query({ tab: 'all', search: 'routine maintenance' })
      .set(auth(adminToken))
      .expect(200);
    const ids = res.body.data.items.map((r) => r.id);
    expect(ids).toEqual([requestB.id]);
  });

  test('customerId filter narrows to that customer only', async () => {
    if (!reachable) return;
    const res = await request(app)
      .get('/api/access-requests')
      .query({ tab: 'all', customerId: customerB.id })
      .set(auth(adminToken))
      .expect(200);
    const ids = res.body.data.items.map((r) => r.id);
    expect(ids).toEqual([requestB.id]);
  });

  test('a scoped caller filtering by an out-of-scope customer gets nothing', async () => {
    if (!reachable) return;
    // scopedAdmin can only see customerA; asking for customerB must return
    // empty, not a leak of requestB via an unscoped fallback.
    const res = await request(app)
      .get('/api/access-requests')
      .query({ tab: 'all', customerId: customerB.id })
      .set(auth(scopedAdminToken))
      .expect(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  test('a scoped caller filtering by their in-scope customer still sees it', async () => {
    if (!reachable) return;
    const res = await request(app)
      .get('/api/access-requests')
      .query({ tab: 'all', customerId: customerA.id })
      .set(auth(scopedAdminToken))
      .expect(200);
    const ids = res.body.data.items.map((r) => r.id);
    expect(ids).toEqual([requestA.id]);
  });

  test('sortBy whitelist rejects an unknown column with 400', async () => {
    if (!reachable) return;
    const res = await request(app)
      .get('/api/access-requests')
      .query({ tab: 'all', sortBy: 'reason' })
      .set(auth(adminToken))
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  test('sortBy=requestedDuration sortDir=asc orders ascending', async () => {
    if (!reachable) return;
    const res = await request(app)
      .get('/api/access-requests')
      .query({ tab: 'all', sortBy: 'requestedDuration', sortDir: 'asc' })
      .set(auth(adminToken))
      .expect(200);
    const durations = res.body.data.items.map((r) => r.requestedDuration);
    const sorted = [...durations].sort((a, b) => a - b);
    expect(durations).toEqual(sorted);
  });
});
