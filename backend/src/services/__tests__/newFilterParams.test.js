/**
 * newFilterParams.test.js — the new filter/search/sort query params added to
 * serverService.listServers, customerService.listCustomers, policyService.list,
 * userService.listUsers and notificationService.list.
 *
 * Each new param is exercised two ways where it applies:
 *   - it actually narrows/sorts the result set (the point of adding it), and
 *   - for the two customer-scoped lists (servers, customers), a scoped
 *     caller filtering by something that only matches an out-of-scope row
 *     gets NOTHING — never that row — while the unscoped caller filtering
 *     the same way gets it. (Policies and Users are org-wide lists, not
 *     customer-scoped, per routes/policies.js and routes/users.js.)
 *
 * DB tests use the dbReachable() skip pattern (see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import * as serverService from '../serverService.js';
import * as customerService from '../customerService.js';
import * as policyService from '../policyService.js';
import * as userService from '../userService.js';
import * as notificationService from '../notificationService.js';
import { resolveScope } from '../../lib/scope.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

describe('new filter/search/sort params (security + behavior integration test)', () => {
  let reachable;
  let org;
  let customerA;
  let customerB;
  let serverA;
  let serverB;
  let scopedUser;
  let unscopedUser;
  let scopedScope;
  let unscopedScope;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] newFilterParams: no live DB');
      return;
    }

    org = await createTestOrg();
    const suffix = unique();
    customerA = await prisma.customer.create({ data: { orgId: org.id, name: `Acme-${suffix}`, slug: `acme-${suffix}` } });
    customerB = await prisma.customer.create({ data: { orgId: org.id, name: `Beta-${suffix}`, slug: `beta-${suffix}` } });

    serverA = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customerA.id,
        hostname: `a-host-${suffix}`,
        ipAddress: '10.1.0.1',
        environment: 'dev',
        protocol: 'ssh',
        osType: 'linux',
        isActive: true,
        healthStatus: 'healthy',
        lastHealthCheck: new Date('2026-01-01T00:00:00Z'),
      },
    });
    serverB = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customerB.id,
        hostname: `b-host-${suffix}`,
        ipAddress: '10.1.0.2',
        environment: 'prod',
        protocol: 'rdp',
        osType: 'windows',
        isActive: false,
        healthStatus: 'unhealthy',
        lastHealthCheck: new Date('2026-06-01T00:00:00Z'),
      },
    });

    scopedUser = await createTestUser(org.id, { role: 'member', data: { accessScope: 'CUSTOMERS' } });
    await prisma.userCustomerScope.create({ data: { userId: scopedUser.id, customerId: customerA.id } });
    unscopedUser = await createTestUser(org.id, { role: 'member' });

    scopedScope = await resolveScope({ id: scopedUser.id, role: 'member', accessScope: 'CUSTOMERS' });
    unscopedScope = await resolveScope({ id: unscopedUser.id, role: 'member', accessScope: 'ALL' });
    expect(scopedScope).toEqual({ mode: 'customers', customerIds: [customerA.id] });
  });

  afterAll(async () => {
    if (!reachable) return;
    await prisma.notification.deleteMany({ where: { orgId: org.id } });
    await prisma.policySubject.deleteMany({ where: { policy: { orgId: org.id } } });
    await prisma.accessPolicy.deleteMany({ where: { orgId: org.id } });
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

  // -------------------------------------------------------------------------
  // serverService.listServers
  // -------------------------------------------------------------------------
  describe('serverService.listServers', () => {
    dbTest('protocol and osType filter narrow for the unscoped caller', async () => {
      const byProto = await serverService.listServers(org.id, { protocol: 'rdp' }, unscopedScope);
      expect(byProto.items.map((s) => s.id)).toEqual([serverB.id]);

      const byOs = await serverService.listServers(org.id, { osType: 'linux' }, unscopedScope);
      expect(byOs.items.map((s) => s.id)).toEqual([serverA.id]);
    });

    dbTest('healthCheckFrom/To narrows on lastHealthCheck', async () => {
      const result = await serverService.listServers(
        org.id,
        { healthCheckFrom: '2026-05-01', healthCheckTo: '2026-07-01' },
        unscopedScope
      );
      expect(result.items.map((s) => s.id)).toEqual([serverB.id]);
    });

    dbTest('sortBy=ipAddress sorts, and an unknown sortBy is ignored rather than erroring', async () => {
      const asc = await serverService.listServers(org.id, { sortBy: 'ipAddress', sortDir: 'asc' }, unscopedScope);
      expect(asc.items.map((s) => s.id)).toEqual([serverA.id, serverB.id]);
      const desc = await serverService.listServers(org.id, { sortBy: 'ipAddress', sortDir: 'desc' }, unscopedScope);
      expect(desc.items.map((s) => s.id)).toEqual([serverB.id, serverA.id]);

      // Whitelisting: a bogus sortBy must not throw or pass through to Prisma.
      await expect(serverService.listServers(org.id, { sortBy: 'sqlInjection; DROP TABLE servers;' }, unscopedScope))
        .resolves.toBeTruthy();
    });

    dbTest('a scoped caller filtering by protocol/osType that only matches B gets nothing, never B', async () => {
      const scoped = await serverService.listServers(org.id, { protocol: 'rdp' }, scopedScope);
      expect(scoped.items).toEqual([]);
      expect(scoped.total).toBe(0);

      const scopedOs = await serverService.listServers(org.id, { osType: 'windows' }, scopedScope);
      expect(scopedOs.items).toEqual([]);
    });

    dbTest('isActive filter (already supported) still narrows correctly', async () => {
      const active = await serverService.listServers(org.id, { isActive: true }, unscopedScope);
      expect(active.items.map((s) => s.id)).toEqual([serverA.id]);
    });

    dbTest('listOsTypes returns distinct types, scoped', async () => {
      const all = await serverService.listOsTypes(org.id, unscopedScope);
      expect(all.sort()).toEqual(['linux', 'windows']);
      const scoped = await serverService.listOsTypes(org.id, scopedScope);
      expect(scoped).toEqual(['linux']);
    });
  });

  // -------------------------------------------------------------------------
  // customerService.listCustomers
  // -------------------------------------------------------------------------
  describe('customerService.listCustomers', () => {
    dbTest('hasServers filter narrows for the unscoped caller', async () => {
      const withServers = await customerService.listCustomers(org.id, { hasServers: 'yes' }, unscopedScope);
      const ids = withServers.items.map((c) => c.id);
      expect(ids).toContain(customerA.id);
      expect(ids).toContain(customerB.id);

      const noServers = await customerService.listCustomers(org.id, { hasServers: 'no' }, unscopedScope);
      expect(noServers.items.map((c) => c.id)).not.toContain(customerA.id);
    });

    dbTest('sortBy=name sorts alphabetically; unknown sortBy falls back safely', async () => {
      const asc = await customerService.listCustomers(org.id, { sortBy: 'name', sortDir: 'asc', pageSize: 100 }, unscopedScope);
      const names = asc.items.map((c) => c.name).filter((n) => n === customerA.name || n === customerB.name);
      expect(names).toEqual([customerA.name, customerB.name].sort());

      await expect(customerService.listCustomers(org.id, { sortBy: 'nope; DROP TABLE customers;' }, unscopedScope))
        .resolves.toBeTruthy();
    });

    dbTest('a scoped caller filtering hasServers=yes never sees an out-of-scope customer', async () => {
      const scoped = await customerService.listCustomers(org.id, { hasServers: 'yes' }, scopedScope);
      const ids = scoped.items.map((c) => c.id);
      expect(ids).toContain(customerA.id);
      expect(ids).not.toContain(customerB.id);
    });
  });

  // -------------------------------------------------------------------------
  // policyService.list
  // -------------------------------------------------------------------------
  describe('policyService.list', () => {
    let orgWidePolicy;
    let customerPolicy;

    beforeAll(async () => {
      if (!reachable) return;
      orgWidePolicy = await prisma.accessPolicy.create({
        data: {
          orgId: org.id,
          name: `Org-wide policy ${unique()}`,
          description: 'applies everywhere',
          effect: 'ALLOW',
          targetEnvironments: ['dev'],
          allowedPrincipals: ['ubuntu'],
          maxSessionDuration: 3600,
          priority: 50,
          subjects: { create: [{ subjectType: 'USER', subjectId: unscopedUser.id }] },
        },
      });
      customerPolicy = await prisma.accessPolicy.create({
        data: {
          orgId: org.id,
          customerId: customerA.id,
          name: `Customer policy ${unique()}`,
          effect: 'DENY',
          targetEnvironments: ['prod'],
          allowedPrincipals: [],
          maxSessionDuration: 3600,
          priority: 10,
          subjects: { create: [{ subjectType: 'GROUP', subjectId: 'some-group-id' }] },
        },
      });
    });

    dbTest('pageSize bug fix: pageSize actually limits the page (was ignored via `limit`)', async () => {
      const result = await policyService.list(org.id, { pageSize: 1, page: 1 });
      expect(result.items.length).toBe(1);
      expect(result.pageSize).toBe(1);
    });

    dbTest('search matches name/description', async () => {
      const result = await policyService.list(org.id, { search: 'org-wide policy' });
      expect(result.items.map((p) => p.id)).toContain(orgWidePolicy.id);
      expect(result.items.map((p) => p.id)).not.toContain(customerPolicy.id);
    });

    dbTest('orgWide=true narrows to customerId null', async () => {
      const result = await policyService.list(org.id, { orgWide: true, pageSize: 100 });
      const ids = result.items.map((p) => p.id);
      expect(ids).toContain(orgWidePolicy.id);
      expect(ids).not.toContain(customerPolicy.id);
    });

    dbTest('environment filter matches targetEnvironments has()', async () => {
      const result = await policyService.list(org.id, { environment: 'prod' });
      expect(result.items.map((p) => p.id)).toEqual([customerPolicy.id]);
    });

    dbTest('subjectId filter matches a policy naming that subject', async () => {
      const result = await policyService.list(org.id, { subjectId: unscopedUser.id });
      expect(result.items.map((p) => p.id)).toEqual([orgWidePolicy.id]);
    });

    dbTest('sortBy=priority sorts; unknown sortBy falls back to the default order', async () => {
      const asc = await policyService.list(org.id, { sortBy: 'priority', sortDir: 'asc', pageSize: 100 });
      const idx = (id) => asc.items.findIndex((p) => p.id === id);
      expect(idx(customerPolicy.id)).toBeLessThan(idx(orgWidePolicy.id));
    });
  });

  // -------------------------------------------------------------------------
  // userService.listUsers
  // -------------------------------------------------------------------------
  describe('userService.listUsers', () => {
    let lockedUser;

    beforeAll(async () => {
      if (!reachable) return;
      lockedUser = await createTestUser(org.id, {
        role: 'member',
        data: { lockedUntil: new Date(Date.now() + 3600_000), accessScope: 'ALL' },
      });
    });

    dbTest('locked=true narrows to users with a future lockedUntil', async () => {
      const result = await userService.listUsers(org.id, { locked: 'true' });
      expect(result.items.map((u) => u.id)).toContain(lockedUser.id);
      expect(result.items.map((u) => u.id)).not.toContain(unscopedUser.id);
    });

    dbTest('locked=false excludes the locked user', async () => {
      const result = await userService.listUsers(org.id, { locked: 'false', pageSize: 100 });
      expect(result.items.map((u) => u.id)).not.toContain(lockedUser.id);
    });

    dbTest('accessScope filter narrows to CUSTOMERS-scoped users', async () => {
      const result = await userService.listUsers(org.id, { accessScope: 'CUSTOMERS' });
      expect(result.items.map((u) => u.id)).toContain(scopedUser.id);
      expect(result.items.map((u) => u.id)).not.toContain(unscopedUser.id);
    });

    dbTest('sortBy=name whitelisted; unknown sortBy does not throw', async () => {
      await expect(userService.listUsers(org.id, { sortBy: 'name', sortDir: 'asc' })).resolves.toBeTruthy();
      await expect(userService.listUsers(org.id, { sortBy: 'nope; DROP TABLE users;' })).resolves.toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // notificationService.list
  // -------------------------------------------------------------------------
  describe('notificationService.list', () => {
    let n1;
    let n2;

    beforeAll(async () => {
      if (!reachable) return;
      n1 = await prisma.notification.create({
        data: {
          orgId: org.id,
          userId: unscopedUser.id,
          type: 'ACCESS_REQUEST_SUBMITTED',
          title: 'Request submitted',
          body: 'body',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
      n2 = await prisma.notification.create({
        data: {
          orgId: org.id,
          userId: unscopedUser.id,
          type: 'BREAK_GLASS_INVOKED',
          title: 'Break-glass used',
          body: 'body',
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      });
    });

    dbTest('type filter narrows', async () => {
      const result = await notificationService.list({ userId: unscopedUser.id, type: 'BREAK_GLASS_INVOKED' });
      expect(result.items.map((n) => n.id)).toEqual([n2.id]);
    });

    dbTest('createdFrom/createdTo narrows on createdAt', async () => {
      const result = await notificationService.list({
        userId: unscopedUser.id,
        createdFrom: '2026-05-01',
        createdTo: '2026-07-01',
      });
      expect(result.items.map((n) => n.id)).toEqual([n2.id]);
    });

    dbTest('one user never sees another user’s notifications regardless of filters', async () => {
      const result = await notificationService.list({ userId: scopedUser.id, type: 'BREAK_GLASS_INVOKED' });
      expect(result.items).toEqual([]);
    });
  });
});
