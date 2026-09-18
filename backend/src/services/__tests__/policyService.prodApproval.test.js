/**
 * policyService.evaluate — production approval bypass matrix.
 *
 * See docs/auth-hardening.md Revision 2 "Production approval":
 *   Organization.settings.access.prodApprovalBypassMinRole ('admin' [default]
 *   | 'super_admin' | 'none') gates whether a prod AccessRequest needs manager
 *   review. A matched ALLOW policy's `autoApprove` flag must NEVER grant an
 *   unreviewed prod session to a requester below the bypass role.
 *
 * Live-DB integration test (dbReachable() skip pattern — see
 * testDbHelper.js / searchService.test.js): jest.unstable_mockModule with
 * file:// URLs is broken in this Jest + Node ESM combination.
 */

import prisma from '../../config/db.js';
import { evaluate } from '../policyService.js';
import { updateAccessSettings } from '../orgService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

describe('policyService.evaluate — prod approval bypass matrix', () => {
  let reachable;
  let org;
  let customer;
  let prodServer;
  let devServer;
  const usersByRole = {};

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] policyService prod approval matrix: no live DB');
      return;
    }
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Prod Approval Co', slug: `prod-approval-${Date.now()}` },
    });
    prodServer = await prisma.server.create({
      data: {
        orgId: org.id, customerId: customer.id, hostname: 'prod-app-01.internal',
        ipAddress: '10.5.5.5', environment: 'prod', protocol: 'ssh',
      },
    });
    devServer = await prisma.server.create({
      data: {
        orgId: org.id, customerId: customer.id, hostname: 'dev-app-01.internal',
        ipAddress: '10.5.5.6', environment: 'dev', protocol: 'ssh',
      },
    });

    for (const role of ['super_admin', 'admin', 'manager', 'member']) {
      usersByRole[role] = await createTestUser(org.id, { role });
    }

    // One ALLOW policy per environment, matching every role via ROLE subjects,
    // autoApprove=true — the point of these tests is that autoApprove alone
    // must NOT be sufficient to skip prod approval below the bypass role.
    const makePolicy = (name, environments, autoApprove, requireApproval = false) =>
      prisma.accessPolicy.create({
        data: {
          orgId: org.id,
          name,
          effect: 'ALLOW',
          targetEnvironments: environments,
          allowedPrincipals: [],
          maxSessionDuration: 3600,
          autoApprove,
          requireApproval,
          priority: 50,
          subjects: {
            create: ['super_admin', 'admin', 'manager', 'member'].map((r) => ({
              subjectType: 'ROLE',
              subjectId: r,
            })),
          },
        },
      });

    await makePolicy('Prod auto-approve everyone (policy-level)', ['prod'], true);
    await makePolicy('Dev auto-approve everyone', ['dev'], true);
  });

  afterAll(async () => {
    if (!reachable || !org) return;
    await prisma.policySubject.deleteMany({ where: { policy: { orgId: org.id } } });
    await prisma.accessPolicy.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const maybeTest = (name, fn) => test(name, async () => {
    if (!reachable) return;
    await fn();
  });

  describe.each([
    ['admin', { super_admin: false, admin: false, manager: true, member: true }],
    ['super_admin', { super_admin: false, admin: true, manager: true, member: true }],
    ['none', { super_admin: true, admin: true, manager: true, member: true }],
  ])('bypass role = %s', (bypassRole, expected) => {
    beforeAll(async () => {
      if (!reachable) return;
      await updateAccessSettings(org.id, { prodApprovalBypassMinRole: bypassRole });
    });

    for (const [role, expectRequiresApproval] of Object.entries(expected)) {
      maybeTest(`${role} requester → requiresApproval=${expectRequiresApproval} on prod`, async () => {
        const result = await evaluate({
          orgId: org.id,
          userId: usersByRole[role].id,
          serverId: prodServer.id,
        });
        expect(result.allowed).toBe(true);
        expect(result.requiresApproval).toBe(expectRequiresApproval);
        // autoApprove reported from the matched policy is informational only —
        // it must never override the role-vs-bypass decision above.
      });
    }
  });

  maybeTest('autoApprove=false does not change the outcome for a bypass-eligible role', async () => {
    await updateAccessSettings(org.id, { prodApprovalBypassMinRole: 'admin' });
    // Replace the prod policy's autoApprove with false — admin must still bypass.
    await prisma.accessPolicy.updateMany({
      where: { orgId: org.id, name: 'Prod auto-approve everyone (policy-level)' },
      data: { autoApprove: false },
    });
    try {
      const adminResult = await evaluate({ orgId: org.id, userId: usersByRole.admin.id, serverId: prodServer.id });
      expect(adminResult.requiresApproval).toBe(false);

      const memberResult = await evaluate({ orgId: org.id, userId: usersByRole.member.id, serverId: prodServer.id });
      expect(memberResult.requiresApproval).toBe(true);
    } finally {
      await prisma.accessPolicy.updateMany({
        where: { orgId: org.id, name: 'Prod auto-approve everyone (policy-level)' },
        data: { autoApprove: true },
      });
    }
  });

  maybeTest('non-prod behaviour is unchanged: requireApproval follows the policy, not the bypass role', async () => {
    await updateAccessSettings(org.id, { prodApprovalBypassMinRole: 'none' });
    const result = await evaluate({ orgId: org.id, userId: usersByRole.member.id, serverId: devServer.id });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false); // dev policy has requireApproval: false
  });

  maybeTest('prodBypass flag is set exactly when requiresApproval is false on prod', async () => {
    await updateAccessSettings(org.id, { prodApprovalBypassMinRole: 'admin' });
    const bypassed = await evaluate({ orgId: org.id, userId: usersByRole.admin.id, serverId: prodServer.id });
    expect(bypassed.prodBypass).toBe(true);

    const notBypassed = await evaluate({ orgId: org.id, userId: usersByRole.member.id, serverId: prodServer.id });
    expect(notBypassed.prodBypass).toBe(false);

    const nonProd = await evaluate({ orgId: org.id, userId: usersByRole.admin.id, serverId: devServer.id });
    expect(nonProd.prodBypass).toBe(false);
  });
});
