/**
 * GET /api/certificates — new filters/search/sort (Certificates
 * filter/search/sort task). Live DB; auto-skips when unreachable.
 */

import express from 'express';
import request from 'supertest';
import prisma from '../../config/db.js';
import certificatesRouter from '../certificates.js';
import errorHandler from '../../middleware/errorHandler.js';
import { generateAccessToken } from '../../utils/jwt.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

// app.js installs this globally (Certificate.serial is a Prisma BigInt);
// this standalone test app mounts only the router, so install it here too.
// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function () {
  return this.toString();
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/certificates', certificatesRouter);
  app.use(errorHandler);
  return app;
}

let seq = 0;
function uniq() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

let serialCounter = 900000000n;
function nextSerial() {
  serialCounter += 1n;
  return serialCounter;
}

describe('GET /api/certificates filters/search/sort (live DB)', () => {
  const app = buildApp();
  let reachable = false;
  let org;
  let admin;
  let scopedAdmin;
  let caKeyPair;
  let issuedToUser;
  let adminToken;
  let scopedAdminToken;
  let customerA;
  let customerB;
  let serverA;
  let serverB;
  let certA;
  let certB;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] certificates list filters: no live DB');
      return;
    }
    org = await createTestOrg();
    admin = await createTestUser(org.id, { role: 'admin' });
    scopedAdmin = await createTestUser(org.id, { role: 'admin', data: { accessScope: 'CUSTOMERS' } });
    issuedToUser = await createTestUser(org.id, { role: 'member', name: 'Cert Holder' });
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

    caKeyPair = await prisma.caKeyPair.create({
      data: {
        orgId: org.id, name: `Test CA ${uniq()}`, publicKey: 'ssh-ed25519 AAAA test',
        encryptedPrivateKey: 'x', encryptionIv: 'x', encryptionTag: 'x',
        fingerprint: `SHA256:test-${uniq()}`, isActive: true,
      },
    });

    const serialA = nextSerial();
    certA = await prisma.certificate.create({
      data: {
        orgId: org.id, caKeyPairId: caKeyPair.id, serial: serialA, type: 'USER', keyId: 'ar-A',
        principals: ['deploy'], publicKey: 'ssh-ed25519 AAAA a', signedCert: 'cert-a',
        validAfter: new Date(), validBefore: new Date(Date.now() + 3600_000), status: 'ACTIVE',
        issuedToId: issuedToUser.id, issuedForId: serverA.id, issuedVia: 'access_request',
      },
    });
    const serialB = nextSerial();
    certB = await prisma.certificate.create({
      data: {
        orgId: org.id, caKeyPairId: caKeyPair.id, serial: serialB, type: 'USER', keyId: 'ar-B',
        principals: ['deploy'], publicKey: 'ssh-ed25519 AAAA b', signedCert: 'cert-b',
        validAfter: new Date(), validBefore: new Date(Date.now() + 7200_000), status: 'ACTIVE',
        issuedToId: issuedToUser.id, issuedForId: serverB.id, issuedVia: 'access_request',
      },
    });
  });

  afterAll(async () => {
    if (!reachable) return;
    await cleanupOrg(org.id);
    if (caKeyPair) await prisma.caKeyPair.deleteMany({ where: { id: caKeyPair.id } }).catch(() => {});
  });

  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  test('search matches serial (substring)', async () => {
    if (!reachable) return;
    const serialStr = certA.serial.toString();
    const res = await request(app)
      .get('/api/certificates')
      .query({ search: serialStr.slice(-5) })
      .set(auth(adminToken))
      .expect(200);
    const ids = res.body.data.items.map((c) => c.id);
    expect(ids).toContain(certA.id);
    expect(ids).not.toContain(certB.id);
  });

  test('search matches server hostname', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/certificates').query({ search: 'alpha' }).set(auth(adminToken)).expect(200);
    const ids = res.body.data.items.map((c) => c.id);
    expect(ids).toEqual([certB.id]);
  });

  test('customerId filter narrows via issuedFor, merged with (not replacing) scope', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/certificates').query({ customerId: customerB.id }).set(auth(adminToken)).expect(200);
    const ids = res.body.data.items.map((c) => c.id);
    expect(ids).toEqual([certB.id]);
  });

  test('a scoped caller filtering by an out-of-scope customer gets nothing', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/certificates').query({ customerId: customerB.id }).set(auth(scopedAdminToken)).expect(200);
    expect(res.body.data.items).toEqual([]);
  });

  test('a scoped caller filtering by their in-scope customer still sees it', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/certificates').query({ customerId: customerA.id }).set(auth(scopedAdminToken)).expect(200);
    const ids = res.body.data.items.map((c) => c.id);
    expect(ids).toEqual([certA.id]);
  });

  test('sortBy whitelist rejects an unknown column with 400', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/certificates').query({ sortBy: 'principals' }).set(auth(adminToken)).expect(400);
    expect(res.body.success).toBe(false);
  });

  test('sortBy=validBefore sortDir=asc orders ascending', async () => {
    if (!reachable) return;
    const res = await request(app)
      .get('/api/certificates')
      .query({ sortBy: 'validBefore', sortDir: 'asc' })
      .set(auth(adminToken))
      .expect(200);
    const dates = res.body.data.items.map((c) => new Date(c.validBefore).getTime());
    const sorted = [...dates].sort((a, b) => a - b);
    expect(dates).toEqual(sorted);
  });

  test('expiringSoonCount is server-side (independent of the current page)', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/certificates').query({ limit: 1 }).set(auth(adminToken)).expect(200);
    expect(res.body.data).toHaveProperty('expiringSoonCount');
    expect(typeof res.body.data.expiringSoonCount).toBe('number');
    // Both seeded certs expire within a few hours, well under 24h.
    expect(res.body.data.expiringSoonCount).toBeGreaterThanOrEqual(2);
  });
});
