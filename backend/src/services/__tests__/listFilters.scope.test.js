/**
 * listFilters.scope.test.js — the new detailed-filter query params added to
 * accessRequestService.list, sessionService.list and certificateService.list
 * (server, requester/user, protocol, environment, auth method, cert type,
 * date range), and — the point of this file — that every one of them ANDs
 * onto customer scope rather than ever replacing it.
 *
 * Fixture: one org, customers A and B, one server per customer (A=dev,
 * B=prod so environment is a distinguishing filter too), a user scoped to A
 * only, and an unscoped user. Each filter is exercised two ways:
 *   - it actually narrows the result set (the point of adding it), and
 *   - a scoped caller who filters by something that only matches B's data
 *     (serverId=B, environment=B's env) gets NOTHING — never B's rows —
 *     while the unscoped caller filtering the same way gets them.
 *
 * DB tests use the dbReachable() skip pattern (see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import * as accessRequestService from '../accessRequestService.js';
import * as sessionService from '../sessionService.js';
import * as certificateService from '../certificateService.js';
import { resolveScope } from '../../lib/scope.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

async function createCustomer(orgId, name) {
  const suffix = unique();
  return prisma.customer.create({ data: { orgId, name, slug: `${name.toLowerCase()}-${suffix}` } });
}

async function createServer(orgId, customerId, hostname, environment) {
  return prisma.server.create({
    data: {
      orgId,
      customerId,
      hostname,
      ipAddress: `10.${Math.floor(Math.random() * 200) + 1}.0.${Math.floor(Math.random() * 200) + 1}`,
      environment,
      agentLastSeen: new Date(),
    },
  });
}

describe('list filters — new query params + customer scope (security integration test)', () => {
  let reachable;
  let org;
  let customerA;
  let customerB;
  let serverA; // dev
  let serverB; // prod
  let scopedUser; // AccessScope.CUSTOMERS, scoped to A only
  let unscopedUser; // AccessScope.ALL
  let scopedScope;
  let unscopedScope;
  let caKeyPair;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] listFilters.scope: no live DB');
      return;
    }

    org = await createTestOrg();
    customerA = await createCustomer(org.id, `${unique()}-filtacme`);
    customerB = await createCustomer(org.id, `${unique()}-filtbeta`);
    serverA = await createServer(org.id, customerA.id, `${unique()}-a-host`, 'dev');
    serverB = await createServer(org.id, customerB.id, `${unique()}-b-host`, 'prod');

    scopedUser = await createTestUser(org.id, { role: 'member', data: { accessScope: 'CUSTOMERS' } });
    await prisma.userCustomerScope.create({ data: { userId: scopedUser.id, customerId: customerA.id } });
    unscopedUser = await createTestUser(org.id, { role: 'member' });

    scopedScope = await resolveScope({ id: scopedUser.id, role: 'member', accessScope: 'CUSTOMERS' });
    unscopedScope = await resolveScope({ id: unscopedUser.id, role: 'member', accessScope: 'ALL' });
    expect(scopedScope).toEqual({ mode: 'customers', customerIds: [customerA.id] });

    caKeyPair = await prisma.caKeyPair.create({
      data: {
        orgId: org.id,
        name: 'test-ca',
        publicKey: 'ssh-ed25519 AAAAtest test-ca',
        encryptedPrivateKey: 'not-a-real-ciphertext',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
        fingerprint: `SHA256:test-${unique()}`,
      },
    });
  });

  afterAll(async () => {
    if (!reachable) return;
    await prisma.certificate.deleteMany({ where: { orgId: org.id } });
    await prisma.caKeyPair.deleteMany({ where: { orgId: org.id } });
    await prisma.session.deleteMany({ where: { orgId: org.id } });
    await prisma.accessRequest.deleteMany({ where: { orgId: org.id } });
    await prisma.userCustomerScope.deleteMany({ where: { user: { orgId: org.id } } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const dbTest = (name, fn) => test(name, async () => {
    if (!reachable) return;
    await fn();
  });

  // -------------------------------------------------------------------------
  // accessRequestService.list
  // -------------------------------------------------------------------------
  describe('accessRequestService.list', () => {
    let reqA;
    let reqB;

    beforeAll(async () => {
      if (!reachable) return;
      reqA = await prisma.accessRequest.create({
        data: {
          orgId: org.id, requesterId: scopedUser.id, serverId: serverA.id, status: 'APPROVED',
          reason: 'filter test A', requestedPrincipal: 'deploy', requestedDuration: 3600, protocol: 'SSH',
        },
      });
      reqB = await prisma.accessRequest.create({
        data: {
          orgId: org.id, requesterId: unscopedUser.id, serverId: serverB.id, status: 'APPROVED',
          reason: 'filter test B', requestedPrincipal: 'deploy', requestedDuration: 3600, protocol: 'RDP',
        },
      });
    });

    dbTest('environment filter narrows tab=all for the unscoped caller', async () => {
      const result = await accessRequestService.list({
        orgId: org.id, userId: unscopedUser.id, permissions: new Set(['access_requests.view_all']),
        tab: 'all', environment: 'prod', scope: unscopedScope,
      });
      expect(result.items.map((r) => r.id)).toEqual([reqB.id]);
    });

    dbTest('protocol filter narrows tab=all for the unscoped caller', async () => {
      const result = await accessRequestService.list({
        orgId: org.id, userId: unscopedUser.id, permissions: new Set(['access_requests.view_all']),
        tab: 'all', protocol: 'SSH', scope: unscopedScope,
      });
      expect(result.items.map((r) => r.id)).toEqual([reqA.id]);
    });

    dbTest('a scoped caller filtering tab=all by an out-of-scope serverId gets nothing, never B', async () => {
      const result = await accessRequestService.list({
        orgId: org.id, userId: scopedUser.id, permissions: new Set(['access_requests.view_all']),
        tab: 'all', serverId: serverB.id, scope: scopedScope,
      });
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    dbTest('a scoped caller filtering tab=all by B\'s environment (prod) gets nothing, never B', async () => {
      const result = await accessRequestService.list({
        orgId: org.id, userId: scopedUser.id, permissions: new Set(['access_requests.view_all']),
        tab: 'all', environment: 'prod', scope: scopedScope,
      });
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);

      // Same filter, unscoped caller — proves the filter itself works and
      // the empty result above was scope, not a broken query.
      const unscoped = await accessRequestService.list({
        orgId: org.id, userId: unscopedUser.id, permissions: new Set(['access_requests.view_all']),
        tab: 'all', environment: 'prod', scope: unscopedScope,
      });
      expect(unscoped.items.map((r) => r.id)).toEqual([reqB.id]);
    });

    dbTest('date range filter (startDate/endDate) narrows on createdAt', async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const result = await accessRequestService.list({
        orgId: org.id, userId: unscopedUser.id, permissions: new Set(['access_requests.view_all']),
        tab: 'all', startDate: future, scope: unscopedScope,
      });
      expect(result.items).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // sessionService.list
  // -------------------------------------------------------------------------
  describe('sessionService.list', () => {
    let sessA;
    let sessB;

    beforeAll(async () => {
      if (!reachable) return;
      sessA = await sessionService.create({
        orgId: org.id, userId: scopedUser.id, serverId: serverA.id, sessionType: 'SSH', authMethod: 'certificate',
      });
      sessB = await sessionService.create({
        orgId: org.id, userId: unscopedUser.id, serverId: serverB.id, sessionType: 'RDP', authMethod: 'credential',
      });
    });

    dbTest('authMethod + protocol(sessionType) filters narrow for the unscoped caller', async () => {
      const byAuth = await sessionService.list({ orgId: org.id, scope: unscopedScope, callerId: unscopedUser.id, authMethod: 'credential' });
      expect(byAuth.items.map((s) => s.id)).toEqual([sessB.id]);

      const byProto = await sessionService.list({ orgId: org.id, scope: unscopedScope, callerId: unscopedUser.id, protocol: 'SSH' });
      expect(byProto.items.map((s) => s.id)).toEqual([sessA.id]);
    });

    dbTest('environment filter merges with (never replaces) customer scope', async () => {
      // The scoped user filtering by B's environment must get nothing — the
      // regression this test guards is `where.server = {...}` clobbering the
      // scope predicate that also lives under a different top-level key
      // (sessionScopeWhere's OR), which would silently widen the query.
      const scoped = await sessionService.list({ orgId: org.id, scope: scopedScope, callerId: scopedUser.id, environment: 'prod' });
      expect(scoped.items).toEqual([]);
      expect(scoped.total).toBe(0);

      const unscoped = await sessionService.list({ orgId: org.id, scope: unscopedScope, callerId: unscopedUser.id, environment: 'prod' });
      expect(unscoped.items.map((s) => s.id)).toEqual([sessB.id]);
    });

    dbTest('a scoped caller filtering by an out-of-scope serverId gets nothing', async () => {
      const scoped = await sessionService.list({ orgId: org.id, scope: scopedScope, callerId: scopedUser.id, serverId: serverB.id });
      expect(scoped.items).toEqual([]);
      expect(scoped.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // certificateService.list
  // -------------------------------------------------------------------------
  describe('certificateService.list', () => {
    let nextSerial = BigInt(Date.now()) * 1000n;
    const newSerial = () => (nextSerial += 1n);

    async function createCert(issuedForId, certType = 'USER') {
      return prisma.certificate.create({
        data: {
          orgId: org.id,
          caKeyPairId: caKeyPair.id,
          serial: newSerial(),
          type: certType,
          keyId: 'test-key',
          principals: ['ubuntu'],
          publicKey: 'ssh-ed25519 AAAAtestuserkey',
          signedCert: 'ssh-ed25519-cert-v01@openssh.com AAAAtest',
          validAfter: new Date(Date.now() - 60_000),
          validBefore: new Date(Date.now() + 3600_000),
          status: 'ACTIVE',
          issuedToId: scopedUser.id,
          issuedForId,
          issuedVia: 'access_request',
        },
      });
    }

    let certA;
    let certB;

    beforeAll(async () => {
      if (!reachable) return;
      certA = await createCert(serverA.id, 'USER');
      certB = await createCert(serverB.id, 'HOST');
    });

    dbTest('certType filter narrows for the unscoped caller', async () => {
      const result = await certificateService.list({ orgId: org.id, certType: 'HOST', scope: unscopedScope });
      expect(result.items.map((c) => c.id)).toEqual([certB.id]);
    });

    dbTest('environment filter MERGES with (never replaces) the issuedFor scope predicate', async () => {
      // This is the regression this suite exists to catch: the scope
      // predicate and the environment filter both live under the `issuedFor`
      // key, so setting one naively (`where.issuedFor = {environment}`)
      // would silently drop the other and leak B's certs to a scoped caller.
      const scoped = await certificateService.list({ orgId: org.id, environment: 'prod', scope: scopedScope });
      expect(scoped.items).toEqual([]);
      expect(scoped.total).toBe(0);

      const unscoped = await certificateService.list({ orgId: org.id, environment: 'prod', scope: unscopedScope });
      expect(unscoped.items.map((c) => c.id)).toEqual([certB.id]);
    });

    dbTest('a scoped caller filtering by an out-of-scope serverId gets nothing', async () => {
      const scoped = await certificateService.list({ orgId: org.id, serverId: serverB.id, scope: scopedScope });
      expect(scoped.items).toEqual([]);
      expect(scoped.total).toBe(0);
    });

    dbTest('date range filter narrows on validBefore', async () => {
      const past = new Date(Date.now() - 3600_000 * 24).toISOString();
      const result = await certificateService.list({ orgId: org.id, endDate: past, scope: unscopedScope });
      expect(result.items).toEqual([]);
    });
  });
});
