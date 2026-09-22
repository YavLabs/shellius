/**
 * GET /api/audit and /api/audit/facets — new filters/search (Audit log
 * filter/search task). Live DB; auto-skips when unreachable.
 */

import express from 'express';
import request from 'supertest';
import prisma from '../../config/db.js';
import auditRouter from '../audit.js';
import errorHandler from '../../middleware/errorHandler.js';
import { generateAccessToken } from '../../utils/jwt.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/audit', auditRouter);
  app.use(errorHandler);
  return app;
}

let seq = 0;
function uniq() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

describe('GET /api/audit filters/search + /api/audit/facets (live DB)', () => {
  const app = buildApp();
  let reachable = false;
  let org;
  let admin;
  let superAdmin;
  let actor;
  let adminToken;
  let superAdminToken;
  let entryServer;
  let entryLogin;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] audit list filters: no live DB');
      return;
    }
    org = await createTestOrg();
    admin = await createTestUser(org.id, { role: 'admin' });
    // audit.export is a super_admin-only permission (routes/audit.js) —
    // separate from audit.view (admin+), which the rest of these tests use.
    superAdmin = await createTestUser(org.id, { role: 'super_admin' });
    actor = await createTestUser(org.id, { role: 'member', name: 'Audit Actor', email: `audit-actor-${uniq()}@example.com` });
    adminToken = generateAccessToken({ userId: admin.id, orgId: org.id });
    superAdminToken = generateAccessToken({ userId: superAdmin.id, orgId: org.id });

    entryServer = await prisma.auditLog.create({
      data: {
        orgId: org.id, actorId: actor.id, action: 'server.create', resourceType: 'Server',
        resourceId: 'srv-fake-id', ipAddress: '203.0.113.42', metadata: { hostname: 'zeta.internal' },
      },
    });
    entryLogin = await prisma.auditLog.create({
      data: {
        orgId: org.id, actorId: admin.id, action: 'auth.login', resourceType: 'User', resourceId: admin.id,
        ipAddress: '198.51.100.7', metadata: {},
      },
    });
  });

  afterAll(async () => {
    if (!reachable) return;
    await cleanupOrg(org.id);
  });

  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  test('ip filter is a contains match', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/audit').query({ ip: '203.0.113' }).set(auth(adminToken)).expect(200);
    const ids = res.body.data.items.map((i) => i.id);
    expect(ids).toContain(entryServer.id);
    expect(ids).not.toContain(entryLogin.id);
  });

  test('search matches actor name', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/audit').query({ search: 'Audit Actor' }).set(auth(adminToken)).expect(200);
    const ids = res.body.data.items.map((i) => i.id);
    expect(ids).toContain(entryServer.id);
    expect(ids).not.toContain(entryLogin.id);
  });

  test('search matches ip address', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/audit').query({ search: '198.51.100.7' }).set(auth(adminToken)).expect(200);
    const ids = res.body.data.items.map((i) => i.id);
    expect(ids).toEqual([entryLogin.id]);
  });

  test('resourceId filter matches an exact id', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/audit').query({ resourceId: 'srv-fake-id' }).set(auth(adminToken)).expect(200);
    const ids = res.body.data.items.map((i) => i.id);
    expect(ids).toEqual([entryServer.id]);
  });

  test('GET /api/audit/facets returns distinct actions and resource types actually present', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/audit/facets').set(auth(adminToken)).expect(200);
    expect(res.body.data.actions).toEqual(expect.arrayContaining(['server.create', 'auth.login']));
    expect(res.body.data.resourceTypes).toEqual(expect.arrayContaining(['Server']));
    // Never the stale hard-coded 'Policy' label — the model is AccessPolicy.
    expect(res.body.data.resourceTypes).not.toContain('Policy');
  });

  test('GET /api/audit/export?format=json&search= narrows to matching rows', async () => {
    if (!reachable) return;
    const res = await request(app)
      .get('/api/audit/export')
      .query({ format: 'json', search: 'zeta.internal' })
      .set(auth(superAdminToken))
      .expect(200);
    const rows = Array.isArray(res.body) ? res.body : JSON.parse(res.text);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(entryServer.id);
    expect(ids).not.toContain(entryLogin.id);
  });
});
