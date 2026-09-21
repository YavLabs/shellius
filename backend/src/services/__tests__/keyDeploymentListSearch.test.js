/**
 * keyDeploymentService.listDeployments — the new `search` param (server
 * hostname/displayName or key name), plus that it ANDs with (never
 * replaces) customer scope, same shape as listFilters.scope.test.js.
 */
import prisma from '../../config/db.js';
import * as keyDeploymentService from '../keyDeploymentService.js';
import { encrypt } from '../../utils/crypto.js';
import { resolveScope } from '../../lib/scope.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

describe('keyDeploymentService.listDeployments — search + scope', () => {
  let reachable;
  let org;
  let customerA;
  let customerB;
  let serverA;
  let serverB;
  let sshKey;
  let depA;
  let depB;
  let scopedScope;
  let unscopedScope;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] keyDeploymentListSearch: no live DB');
      return;
    }
    org = await createTestOrg();
    const suffix = unique();
    customerA = await prisma.customer.create({ data: { orgId: org.id, name: `A-${suffix}`, slug: `a-${suffix}` } });
    customerB = await prisma.customer.create({ data: { orgId: org.id, name: `B-${suffix}`, slug: `b-${suffix}` } });
    serverA = await prisma.server.create({
      data: { orgId: org.id, customerId: customerA.id, hostname: `alpha-host-${suffix}`, ipAddress: '10.2.0.1' },
    });
    serverB = await prisma.server.create({
      data: { orgId: org.id, customerId: customerB.id, hostname: `bravo-host-${suffix}`, ipAddress: '10.2.0.2' },
    });
    sshKey = await prisma.sshKey.create({
      data: {
        orgId: org.id,
        name: `deploy-key-${suffix}`,
        keyType: 'ed25519',
        publicKey: 'ssh-ed25519 AAAAfake test@host',
        privateKeyEncrypted: encrypt('-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n'),
        fingerprint: `SHA256:fake-${suffix}`,
        source: 'generated',
      },
    });
    const batchId = `batch-${suffix}`;
    depA = await prisma.keyDeployment.create({
      data: {
        orgId: org.id, batchId, sshKeyId: sshKey.id, serverId: serverA.id,
        action: 'deploy', targetUser: 'deploy', authMode: 'server', status: 'success',
      },
    });
    depB = await prisma.keyDeployment.create({
      data: {
        orgId: org.id, batchId, sshKeyId: sshKey.id, serverId: serverB.id,
        action: 'deploy', targetUser: 'deploy', authMode: 'server', status: 'success',
      },
    });

    const scopedUser = await createTestUser(org.id, { role: 'member', data: { accessScope: 'CUSTOMERS' } });
    await prisma.userCustomerScope.create({ data: { userId: scopedUser.id, customerId: customerA.id } });
    const unscopedUser = await createTestUser(org.id, { role: 'member' });
    scopedScope = await resolveScope({ id: scopedUser.id, role: 'member', accessScope: 'CUSTOMERS' });
    unscopedScope = await resolveScope({ id: unscopedUser.id, role: 'member', accessScope: 'ALL' });
  });

  afterAll(async () => {
    if (!reachable) return;
    await prisma.keyDeployment.deleteMany({ where: { orgId: org.id } });
    await prisma.sshKey.deleteMany({ where: { orgId: org.id } });
    await prisma.userCustomerScope.deleteMany({ where: { user: { orgId: org.id } } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
    await prisma.$disconnect().catch(() => {});
  });

  const dbTest = (name, fn) => test(name, async () => {
    if (!reachable) return;
    await fn();
  });

  dbTest('search matches server hostname for the unscoped caller', async () => {
    const result = await keyDeploymentService.listDeployments(org.id, { search: 'bravo-host' }, unscopedScope);
    expect(result.deployments.map((d) => d.id)).toEqual([depB.id]);
  });

  dbTest('search matches the ssh key name', async () => {
    const result = await keyDeploymentService.listDeployments(org.id, { search: sshKey.name }, unscopedScope);
    expect(result.deployments.map((d) => d.id).sort()).toEqual([depA.id, depB.id].sort());
  });

  dbTest('sshKeyId and serverId filters (already supported) narrow correctly', async () => {
    const byServer = await keyDeploymentService.listDeployments(org.id, { serverId: serverA.id }, unscopedScope);
    expect(byServer.deployments.map((d) => d.id)).toEqual([depA.id]);
  });

  dbTest('a scoped caller searching for an out-of-scope server hostname gets nothing, never B', async () => {
    const scoped = await keyDeploymentService.listDeployments(org.id, { search: 'bravo-host' }, scopedScope);
    expect(scoped.deployments).toEqual([]);
    expect(scoped.meta.total).toBe(0);

    // Same search, unscoped — proves the search itself works.
    const unscoped = await keyDeploymentService.listDeployments(org.id, { search: 'bravo-host' }, unscopedScope);
    expect(unscoped.deployments.map((d) => d.id)).toEqual([depB.id]);
  });
});
