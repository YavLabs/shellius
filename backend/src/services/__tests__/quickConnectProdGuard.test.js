/**
 * quickConnectService.assertNotProdHost — prod guard tests.
 *
 * Live-DB integration test (dbReachable() skip pattern — see
 * testDbHelper.js / searchService.test.js): jest.unstable_mockModule with
 * file:// URLs is broken in this Jest + Node ESM combination, so DNS
 * failure-tolerance is exercised with a real (bogus, guaranteed-NXDOMAIN)
 * hostname rather than a mocked `dns` module.
 */

import prisma from '../../config/db.js';
import { assertNotProdHost } from '../quickConnectService.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

describe('quickConnectService.assertNotProdHost', () => {
  let reachable;
  let org;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] quickConnectProdGuard: no live DB');
      return;
    }
    org = await createTestOrg();
  });

  afterAll(async () => {
    if (reachable && org) await cleanupOrg(org.id);
  });

  const maybeTest = (name, fn) => test(name, async () => {
    if (!reachable) return;
    await fn();
  });

  async function makeCustomer() {
    return prisma.customer.create({ data: { orgId: org.id, name: 'Acme', slug: `acme-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` } });
  }

  maybeTest('allows a host that matches nothing', async () => {
    await expect(assertNotProdHost(org.id, '203.0.113.9', ['203.0.113.9'])).resolves.toBeUndefined();
  });

  maybeTest('refuses by exact hostname/IP string match (prod server)', async () => {
    const customer = await makeCustomer();
    const server = await prisma.server.create({
      data: {
        orgId: org.id, customerId: customer.id, hostname: 'prod-box.internal',
        ipAddress: '10.9.9.9', environment: 'prod',
      },
    });

    await expect(assertNotProdHost(org.id, '10.9.9.9', [])).rejects.toMatchObject({
      statusCode: 403,
      code: 'PROD_HOST_REQUIRES_APPROVAL',
      details: { serverId: server.id },
    });
    await expect(assertNotProdHost(org.id, 'PROD-BOX.internal', [])).rejects.toMatchObject({
      code: 'PROD_HOST_REQUIRES_APPROVAL',
    });
  });

  maybeTest('refuses by resolved IP match even when the hostname string differs', async () => {
    const customer = await makeCustomer();
    const server = await prisma.server.create({
      data: {
        orgId: org.id, customerId: customer.id, hostname: 'prod-other.internal',
        ipAddress: '10.9.9.10', environment: 'prod',
      },
    });

    // The caller resolved some other hostname to the same IP as a saved prod
    // server — must still be refused.
    await expect(assertNotProdHost(org.id, 'some-alias.example', ['10.9.9.10'])).rejects.toMatchObject({
      code: 'PROD_HOST_REQUIRES_APPROVAL',
      details: { serverId: server.id },
    });
  });

  maybeTest('does not refuse a non-prod server match', async () => {
    const customer = await makeCustomer();
    await prisma.server.create({
      data: {
        orgId: org.id, customerId: customer.id, hostname: 'dev-box.internal',
        ipAddress: '10.9.9.11', environment: 'dev',
      },
    });

    await expect(assertNotProdHost(org.id, '10.9.9.11', ['10.9.9.11'])).resolves.toBeUndefined();
  });

  maybeTest('tolerates DNS failure resolving a prod server hostname', async () => {
    const customer = await makeCustomer();
    await prisma.server.create({
      data: {
        orgId: org.id, customerId: customer.id,
        // Guaranteed-invalid TLD — dns.lookup() will reject (NXDOMAIN/ENOTFOUND).
        hostname: 'definitely-does-not-exist.invalid-tld-shellius-test',
        ipAddress: '', environment: 'prod',
      },
    });

    // Should tolerate the failed lookup and simply not match, not throw.
    await expect(assertNotProdHost(org.id, '203.0.113.50', ['203.0.113.50'])).resolves.toBeUndefined();
  }, 15000);
});
