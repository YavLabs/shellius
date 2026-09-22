/**
 * GET /api/keystore/deployments/groups — route contract: envelope, not
 * swallowed by a /deployments/:id route, filters validated like the list,
 * and org-scoped (a caller from another org sees none of these groups).
 * Live DB; auto-skips when unreachable.
 */

import express from 'express';
import request from 'supertest';
import prisma from '../../config/db.js';
import keystoreRouter from '../keystore.js';
import errorHandler from '../../middleware/errorHandler.js';
import { generateAccessToken } from '../../utils/jwt.js';
import { encrypt } from '../../utils/crypto.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/keystore', keystoreRouter);
  app.use(errorHandler);
  return app;
}

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

describe('GET /api/keystore/deployments/groups (live DB)', () => {
  const app = buildApp();
  let reachable = false;
  let org;
  let otherOrg;
  let token;
  let otherToken;
  let batchId;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] keystore deployment groups route: no live DB');
      return;
    }
    org = await createTestOrg();
    otherOrg = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'admin' });
    const otherAdmin = await createTestUser(otherOrg.id, { role: 'admin' });
    token = generateAccessToken({ userId: admin.id, orgId: org.id });
    otherToken = generateAccessToken({ userId: otherAdmin.id, orgId: otherOrg.id });

    const s = uniq();
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: `C-${s}`, slug: `c-${s}` } });
    const server = await prisma.server.create({ data: { orgId: org.id, customerId: customer.id, hostname: `h-${s}`, ipAddress: '10.4.0.1' } });
    const key = await prisma.sshKey.create({
      data: {
        orgId: org.id,
        name: `k-${s}`,
        keyType: 'ed25519',
        publicKey: 'ssh-ed25519 AAAAfake test@host',
        privateKeyEncrypted: encrypt('fake-private-key-material'),
        fingerprint: `SHA256:fake-${s}`,
        source: 'generated',
      },
    });
    batchId = `batch-${s}`;
    await prisma.keyDeployment.create({
      data: { orgId: org.id, batchId, sshKeyId: key.id, serverId: server.id, action: 'deploy', targetUser: 'deploy', authMode: 'server', status: 'failed' },
    });
  });

  afterAll(async () => {
    if (!reachable) return;
    await prisma.keyDeployment.deleteMany({ where: { orgId: org.id } });
    await prisma.sshKey.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
    await cleanupOrg(otherOrg.id);
    await prisma.$disconnect().catch(() => {});
  });

  const dbTest = (name, fn) =>
    test(name, async () => {
      if (!reachable) return;
      await fn();
    });

  dbTest('returns { groupBy, tree } in the success envelope', async () => {
    const res = await request(app)
      .get('/api/keystore/deployments/groups')
      .query({ groupBy: 'batch,status' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.groupBy).toEqual(['batch', 'status']);
    expect(res.body.data.tree).toHaveLength(1);
    expect(res.body.data.tree[0]).toMatchObject({ dim: 'batch', value: batchId, count: 1 });
    expect(res.body.data.tree[0].children[0]).toMatchObject({ dim: 'status', value: 'failed', label: 'Failed' });
  });

  dbTest('the list accepts the new filters, and bad values are a 400', async () => {
    const ok = await request(app)
      .get('/api/keystore/deployments')
      .query({ batchId, status: 'failed', action: 'deploy', deployedById: '__none__' })
      .set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.meta.total).toBe(1);

    const bad = await request(app)
      .get('/api/keystore/deployments/groups')
      .query({ groupBy: 'batch', status: 'exploded' })
      .set('Authorization', `Bearer ${token}`);
    expect(bad.status).toBe(400);
  });

  dbTest('another org sees none of it', async () => {
    const res = await request(app)
      .get('/api/keystore/deployments/groups')
      .query({ groupBy: 'batch' })
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tree).toEqual([]);
  });
});
