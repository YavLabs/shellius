/**
 * customerScopeLeak.test.js — the security proof for customer scope
 * (docs/rbac/customer-scope-spec.md §3, §4, §6).
 *
 * Fixture: one org, customers A and B, one server per customer, one user
 * scoped to A only (AccessScope.CUSTOMERS + a UserCustomerScope row), one
 * unscoped user (AccessScope.ALL, today's default), and one user scoped to
 * an EMPTY customer set (the fail-open regression case).
 *
 * Every test proves a query site from spec §4.1/§4.2 both ways at once:
 *   - the scoped user never sees/reaches B (404, not 403, not a silent
 *     empty-looking-like-403 either — genuinely absent from lists/counts),
 *   - the unscoped user is completely unaffected (spec §5.1 "an upgrade
 *     changes nothing that anyone can observe") — proving scope is additive,
 *     not a behavior change for everyone else.
 *
 * DB tests use the dbReachable() skip pattern (see testDbHelper.js). This
 * file does not modify production code: if an assertion here fails because
 * of a real leak, it is left failing and reported, not weakened.
 */

import prisma from '../../config/db.js';
import * as serverService from '../serverService.js';
import * as customerService from '../customerService.js';
import * as healthCheckService from '../healthCheckService.js';
import * as searchService from '../searchService.js';
import * as sessionService from '../sessionService.js';
import * as accessRequestService from '../accessRequestService.js';
import * as policyService from '../policyService.js';
import { syncSystemRoles } from '../roleService.js';
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

async function createServer(orgId, customerId, hostname) {
  return prisma.server.create({
    data: {
      orgId,
      customerId,
      hostname,
      ipAddress: `10.${Math.floor(Math.random() * 200) + 1}.0.${Math.floor(Math.random() * 200) + 1}`,
      environment: 'dev', // non-prod: keeps the fixture out of the prod-approval invariant entirely
      // Mark onboarded (accessRequestService.isServerOnboarded) without needing
      // a real bootstrap — only agentLastSeen truthiness is checked.
      agentLastSeen: new Date(),
    },
  });
}

describe('customer scope — leak proof (security integration test)', () => {
  let reachable;
  let org;
  let roles;
  let customerA;
  let customerB;
  let serverA;
  let serverB;
  let scopedUser; // AccessScope.CUSTOMERS, scoped to A only
  let unscopedUser; // AccessScope.ALL (default) — must be unaffected throughout
  let emptyScopeUser; // AccessScope.CUSTOMERS, no UserCustomerScope rows at all
  let scopedScope;
  let unscopedScope;
  let emptyScope;
  let searchToken;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] customer scope leak tests: no live DB');
      return;
    }

    org = await createTestOrg();
    await syncSystemRoles(org.id);
    roles = Object.fromEntries((await prisma.role.findMany({ where: { orgId: org.id } })).map((r) => [r.key, r]));

    searchToken = `leaktest${unique()}`;
    customerA = await createCustomer(org.id, `${searchToken}-acme`);
    customerB = await createCustomer(org.id, `${searchToken}-beta`);
    serverA = await createServer(org.id, customerA.id, `${searchToken}-a-host`);
    serverB = await createServer(org.id, customerB.id, `${searchToken}-b-host`);

    scopedUser = await createTestUser(org.id, {
      role: 'member',
      data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' },
    });
    await prisma.userCustomerScope.create({ data: { userId: scopedUser.id, customerId: customerA.id } });

    unscopedUser = await createTestUser(org.id, { role: 'member', data: { roleId: roles.member.id } });

    emptyScopeUser = await createTestUser(org.id, {
      role: 'member',
      data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' },
    });
    // Deliberately no UserCustomerScope rows for emptyScopeUser.

    scopedScope = await resolveScope({ id: scopedUser.id, role: 'member', accessScope: 'CUSTOMERS' });
    unscopedScope = await resolveScope({ id: unscopedUser.id, role: 'member', accessScope: 'ALL' });
    emptyScope = await resolveScope({ id: emptyScopeUser.id, role: 'member', accessScope: 'CUSTOMERS' });

    expect(scopedScope).toEqual({ mode: 'customers', customerIds: [customerA.id] });
    expect(emptyScope).toEqual({ mode: 'customers', customerIds: [] });

    // Org-wide ALLOW policy for the 'member' role tier, on every (non-prod)
    // environment — used only by test 10 (getAccessibleServers), so both A
    // and B are genuinely "accessible" from a policy standpoint and the only
    // thing that can still exclude B is the scope filter itself.
    await prisma.accessPolicy.create({
      data: {
        orgId: org.id,
        name: `leak-policy-${unique()}`,
        effect: 'ALLOW',
        targetEnvironments: [],
        targetLabels: {},
        targetServerIds: [],
        allowedPrincipals: [],
        maxSessionDuration: 3600,
        requireApproval: false,
        autoApprove: false,
        isActive: true,
        priority: 100,
        subjects: { create: [{ subjectType: 'ROLE', subjectId: 'member' }] },
      },
    });
  });

  afterAll(async () => {
    if (!reachable) return;
    await prisma.session.deleteMany({ where: { orgId: org.id } });
    await prisma.accessRequest.deleteMany({ where: { orgId: org.id } });
    await prisma.accessPolicy.deleteMany({ where: { orgId: org.id } });
    await prisma.userCustomerScope.deleteMany({ where: { user: { orgId: org.id } } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.role.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const dbTest = (name, fn) => test(name, async () => {
    if (!reachable) return;
    await fn();
  });

  // -------------------------------------------------------------------------
  // 1. serverService.listServers
  // -------------------------------------------------------------------------
  dbTest('1. listServers returns only A for the scoped user and total does not count B; the unscoped user still sees both', async () => {
    const scoped = await serverService.listServers(org.id, {}, scopedScope);
    expect(scoped.items.map((s) => s.id)).toEqual([serverA.id]);
    expect(scoped.total).toBe(1);

    const unscoped = await serverService.listServers(org.id, {}, unscopedScope);
    expect(unscoped.items.map((s) => s.id).sort()).toEqual([serverA.id, serverB.id].sort());
    expect(unscoped.total).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 2. serverService.getServer
  // -------------------------------------------------------------------------
  dbTest('2. getServer on B is 404 (never 403) for the scoped user; the unscoped user can still read it', async () => {
    await expect(serverService.getServer(org.id, serverB.id, scopedScope)).rejects.toMatchObject({ statusCode: 404 });

    const server = await serverService.getServer(org.id, serverB.id, unscopedScope);
    expect(server.id).toBe(serverB.id);
  });

  // -------------------------------------------------------------------------
  // 3. caller-supplied ?customerId=B must not override scope
  // -------------------------------------------------------------------------
  dbTest('3. a caller-supplied customerId=B filter still returns nothing for the scoped user; the unscoped user still gets B through the same filter', async () => {
    const scoped = await serverService.listServers(org.id, { customerId: customerB.id }, scopedScope);
    expect(scoped.items).toEqual([]);
    expect(scoped.total).toBe(0);

    const unscoped = await serverService.listServers(org.id, { customerId: customerB.id }, unscopedScope);
    expect(unscoped.items.map((s) => s.id)).toEqual([serverB.id]);
    expect(unscoped.total).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. customerService.listCustomers / getCustomerStats
  // -------------------------------------------------------------------------
  dbTest('4. listCustomers excludes B and getCustomerStats on B is 404 for the scoped user; the unscoped user sees both and can read B stats', async () => {
    const scopedList = await customerService.listCustomers(org.id, {}, scopedScope);
    expect(scopedList.items.map((c) => c.id)).toEqual([customerA.id]);
    expect(scopedList.total).toBe(1);
    await expect(customerService.getCustomerStats(org.id, customerB.id, scopedScope)).rejects.toMatchObject({ statusCode: 404 });

    const unscopedList = await customerService.listCustomers(org.id, {}, unscopedScope);
    expect(unscopedList.items.map((c) => c.id).sort()).toEqual([customerA.id, customerB.id].sort());
    expect(unscopedList.total).toBe(2);
    const stats = await customerService.getCustomerStats(org.id, customerB.id, unscopedScope);
    expect(stats.total).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 5. healthCheckService.getHealthSummary (aggregate leak)
  // -------------------------------------------------------------------------
  dbTest('5. getHealthSummary counts only A for the scoped user; the unscoped user total includes both', async () => {
    const scoped = await healthCheckService.getHealthSummary(org.id, scopedScope);
    expect(scoped.total).toBe(1);

    const unscoped = await healthCheckService.getHealthSummary(org.id, unscopedScope);
    expect(unscoped.total).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 6. searchService.search (raw SQL path)
  // -------------------------------------------------------------------------
  dbTest('6. search returns only A for a query matching both A and B, and per-type counts exclude B; the unscoped user gets both', async () => {
    const permissions = new Set(['servers.view', 'customers.view']);

    const scoped = await searchService.search({ orgId: org.id, permissions, q: searchToken, limit: 10, scope: scopedScope });
    expect(scoped.results.servers.map((r) => r.id)).toEqual([serverA.id]);
    expect(scoped.results.customers.map((r) => r.id)).toEqual([customerA.id]);
    expect(scoped.counts.servers).toBe(1);
    expect(scoped.counts.customers).toBe(1);

    const unscoped = await searchService.search({ orgId: org.id, permissions, q: searchToken, limit: 10, scope: unscopedScope });
    expect(unscoped.results.servers.map((r) => r.id).sort()).toEqual([serverA.id, serverB.id].sort());
    expect(unscoped.results.customers.map((r) => r.id).sort()).toEqual([customerA.id, customerB.id].sort());
    expect(unscoped.counts.servers).toBe(2);
    expect(unscoped.counts.customers).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 7. Fail-open regression: an EMPTY customer set must mean nothing visible
  // -------------------------------------------------------------------------
  dbTest('7. a scoped user with an empty customer set sees zero servers and zero customers, not everything', async () => {
    const servers = await serverService.listServers(org.id, {}, emptyScope);
    expect(servers.items).toEqual([]);
    expect(servers.total).toBe(0);

    const customers = await customerService.listCustomers(org.id, {}, emptyScope);
    expect(customers.items).toEqual([]);
    expect(customers.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 8. sessionService.list — server-scoped, but own Quick Connect stays visible
  // -------------------------------------------------------------------------
  dbTest('8. sessionService.list excludes sessions on B but keeps the scoped user\'s own Quick Connect session; the unscoped user sees all three', async () => {
    const sessionA = await sessionService.create({ orgId: org.id, userId: scopedUser.id, serverId: serverA.id, sessionType: 'SSH' });
    const sessionB = await sessionService.create({ orgId: org.id, userId: unscopedUser.id, serverId: serverB.id, sessionType: 'SSH' });
    const quickConnect = await sessionService.create({
      orgId: org.id,
      userId: scopedUser.id,
      serverId: null,
      sessionType: 'SSH',
      targetHost: '198.51.100.7',
    });

    const scopedList = await sessionService.list({ orgId: org.id, scope: scopedScope, callerId: scopedUser.id });
    const scopedIds = scopedList.items.map((s) => s.id);
    expect(scopedIds.sort()).toEqual([sessionA.id, quickConnect.id].sort());
    expect(scopedIds).not.toContain(sessionB.id);

    const unscopedList = await sessionService.list({ orgId: org.id, scope: unscopedScope, callerId: unscopedUser.id });
    expect(unscopedList.items.map((s) => s.id).sort()).toEqual([sessionA.id, sessionB.id, quickConnect.id].sort());
  });

  // -------------------------------------------------------------------------
  // 9. accessRequestService.submit — out-of-scope server is rejected as not-found
  // -------------------------------------------------------------------------
  dbTest('9. accessRequestService.submit against B is rejected 404 for the scoped user; the unscoped user gets past the scope gate', async () => {
    await expect(
      accessRequestService.submit({
        orgId: org.id,
        requesterId: scopedUser.id,
        serverId: serverB.id,
        reason: 'leak test — scoped requester against out-of-scope server',
        requestedDuration: 3600,
        requestedPrincipal: 'root',
        callerRole: 'member',
        callerPermissions: new Set(),
        scope: scopedScope,
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    // Unscoped requester must clear the scope gate; the resulting request
    // is APPROVED immediately because of the non-prod org-wide ALLOW policy
    // set up in beforeAll (requireApproval: false).
    await expect(
      accessRequestService.submit({
        orgId: org.id,
        requesterId: unscopedUser.id,
        serverId: serverB.id,
        reason: 'leak test — unscoped requester against B',
        requestedDuration: 3600,
        requestedPrincipal: 'root',
        callerRole: 'member',
        callerPermissions: new Set(),
        scope: unscopedScope,
      })
    ).resolves.toMatchObject({ serverId: serverB.id, status: 'APPROVED' });
  });

  // -------------------------------------------------------------------------
  // 10. policyService.getAccessibleServers
  // -------------------------------------------------------------------------
  dbTest('10. getAccessibleServers never returns B for the scoped user, even though a matching ALLOW policy exists; the unscoped user sees both', async () => {
    const scoped = await policyService.getAccessibleServers(org.id, scopedUser.id, scopedScope);
    expect(scoped.map((r) => r.server.id)).toEqual([serverA.id]);

    const unscoped = await policyService.getAccessibleServers(org.id, unscopedUser.id, unscopedScope);
    expect(unscoped.map((r) => r.server.id).sort()).toEqual([serverA.id, serverB.id].sort());
  });
});
