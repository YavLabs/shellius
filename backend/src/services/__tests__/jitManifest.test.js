/**
 * jitManifestService.buildManifest — the JIT provisioning manifest returned
 * with a certificate verify. Regression: it read `ar.user` (not loaded; the
 * relation is `requester`), threw, and always returned null, so JIT Linux
 * accounts were never provisioned.
 *
 * Live-DB tests (dbReachable() skip pattern — see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import { buildManifest } from '../jitManifestService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

describe('jitManifestService.buildManifest', () => {
  let reachable;
  let org;
  let user;
  let server;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] jitManifest: no live DB');
      return;
    }
    org = await createTestOrg();
    user = await createTestUser(org.id, { role: 'member', email: `jit.user-${Date.now()}@example.com` });
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: 'Acme', slug: `acme-${Date.now()}` } });
    server = await prisma.server.create({
      data: { orgId: org.id, customerId: customer.id, hostname: 'jit-host', ipAddress: '10.0.0.5', environment: 'dev' },
    });
  });

  afterAll(async () => {
    if (!reachable) return;
    await prisma.accessRequest.deleteMany({ where: { orgId: org.id } });
    await prisma.accessPolicy.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const dbTest = (name, fn) =>
    test(name, async () => {
      if (!reachable) return;
      await fn();
    });

  const approvedRequest = () =>
    prisma.accessRequest.create({
      data: {
        orgId: org.id,
        requesterId: user.id,
        serverId: server.id,
        reason: 'jit test',
        requestedPrincipal: 'deploy',
        requestedDuration: 60,
        status: 'APPROVED',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

  dbTest('returns null when no policy has an osProvisioning block', async () => {
    const ar = await approvedRequest();
    expect(await buildManifest({ accessRequestId: ar.id })).toBeNull();
  });

  dbTest('builds the manifest for the requester when a policy enables JIT', async () => {
    await prisma.accessPolicy.create({
      data: {
        orgId: org.id,
        name: 'JIT',
        effect: 'ALLOW',
        maxSessionDuration: 60,
        osProvisioning: { linuxGroups: ['devs'], sudo: true },
      },
    });
    const ar = await approvedRequest();
    const manifest = await buildManifest({ accessRequestId: ar.id });
    expect(manifest).not.toBeNull();
    expect(manifest.linuxUser).toMatch(/_jit$/);
    expect(manifest.groups).toEqual(['devs']);
    expect(manifest.sudo).toBe(true);
    expect(Number.isInteger(manifest.uid)).toBe(true);
    expect(manifest.leaseId).toBe(ar.id);
    expect(manifest.ttlSeconds).toBeGreaterThan(0);
    const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { jitUid: true } });
    expect(fresh.jitUid).toBe(manifest.uid);
  });
});
