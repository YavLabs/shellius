/**
 * accessRequestService.getById — org scoping. An admin may view any request
 * in THEIR org, never another org's (even with a valid id). Live-DB test.
 */

import prisma from '../../config/db.js';
import { getById } from '../accessRequestService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

describe('accessRequestService.getById org scoping', () => {
  let reachable;
  let orgA;
  let orgB;
  let requester;
  let adminB;
  let request;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] accessRequestGetById: no live DB');
      return;
    }
    orgA = await createTestOrg();
    orgB = await createTestOrg();
    requester = await createTestUser(orgA.id, { role: 'member' });
    adminB = await createTestUser(orgB.id, { role: 'admin' });
    const customer = await prisma.customer.create({ data: { orgId: orgA.id, name: 'Acme', slug: `acme-${Date.now()}` } });
    const server = await prisma.server.create({
      data: {
        orgId: orgA.id,
        customerId: customer.id,
        hostname: 'a.internal',
        displayName: 'Acme app server',
        ipAddress: '10.30.0.1',
        environment: 'dev',
      },
    });
    request = await prisma.accessRequest.create({
      data: {
        orgId: orgA.id, requesterId: requester.id, serverId: server.id, status: 'APPROVED',
        reason: 'org scoping test', requestedPrincipal: 'deploy', requestedDuration: 3600,
      },
    });
  });

  afterAll(async () => {
    if (!reachable) return;
    if (orgA) await cleanupOrg(orgA.id);
    if (orgB) await cleanupOrg(orgB.id);
  });

  const maybeTest = (name, fn) => test(name, async () => { if (reachable) await fn(); });

  maybeTest('the requester can read it in their org', async () => {
    const ar = await getById({ requestId: request.id, orgId: orgA.id, callerId: requester.id, callerRole: 'member' });
    expect(ar.id).toBe(request.id);
  });

  // The Access Requests UI needs both the server's display name (primary
  // label) and its customer (for a "View customer" link) — regression guard
  // for the REQUEST_INCLUDE select (Problem A / EntityLink rollout).
  maybeTest('includes the server displayName and customer for the UI', async () => {
    const ar = await getById({ requestId: request.id, orgId: orgA.id, callerId: requester.id, callerRole: 'member' });
    expect(ar.server.displayName).toBe('Acme app server');
    expect(ar.server.hostname).toBe('a.internal');
    expect(ar.server.customer).toMatchObject({ name: 'Acme' });
  });

  maybeTest("another org's admin gets a 404, not the request", async () => {
    await expect(
      getById({ requestId: request.id, orgId: orgB.id, callerId: adminB.id, callerRole: 'admin' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  maybeTest('orgId is required', async () => {
    await expect(getById({ requestId: request.id, callerId: requester.id, callerRole: 'member' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
