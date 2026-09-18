/**
 * accessRequestService.submit — production approval bypass.
 *
 * When the requester's role is at/above the org's
 * Organization.settings.access.prodApprovalBypassMinRole, a prod request is
 * created APPROVED immediately (never silently skipped) and:
 *   - audited as 'access_request.prod_bypass'
 *   - the resolved approver set is notified after the fact
 *
 * Live-DB integration test — see testDbHelper.js / searchService.test.js for
 * the dbReachable() skip-pattern rationale (ESM module mocking is unreliable
 * in this Jest/Node combination).
 */

import prisma from '../../config/db.js';
import { submit } from '../accessRequestService.js';
import { updateAccessSettings } from '../orgService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

describe('accessRequestService.submit — prod approval bypass', () => {
  let reachable;
  let org;
  let customer;
  let prodServer;
  let manager;
  let admin;
  let member;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] accessRequestService prod bypass: no live DB');
      return;
    }
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Bypass Audit Co', slug: `bypass-audit-${Date.now()}` },
    });
    prodServer = await prisma.server.create({
      data: {
        orgId: org.id, customerId: customer.id, hostname: 'prod-bypass-01.internal',
        ipAddress: '10.6.6.6', environment: 'prod', protocol: 'ssh',
        provisionStatus: 'provisioned', // onboarded
      },
    });
    manager = await createTestUser(org.id, { role: 'manager', name: 'Approver Manager' });
    admin = await createTestUser(org.id, { role: 'admin', name: 'Bypass Admin', data: { managerId: manager.id } });
    member = await createTestUser(org.id, { role: 'member', name: 'Regular Member', data: { managerId: manager.id } });

    await prisma.accessPolicy.create({
      data: {
        orgId: org.id,
        name: 'Prod allow everyone (bypass test)',
        effect: 'ALLOW',
        targetEnvironments: ['prod'],
        allowedPrincipals: [],
        maxSessionDuration: 3600,
        autoApprove: true,
        requireApproval: false,
        priority: 50,
        subjects: {
          create: ['admin', 'manager', 'member'].map((r) => ({ subjectType: 'ROLE', subjectId: r })),
        },
      },
    });
  });

  afterAll(async () => {
    if (!reachable || !org) return;
    await prisma.notification.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
    await prisma.accessRequest.deleteMany({ where: { orgId: org.id } });
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

  maybeTest('admin (>= default bypass role) gets an immediate APPROVED request, audited + approver notified', async () => {
    await updateAccessSettings(org.id, { prodApprovalBypassMinRole: 'admin' });

    const ar = await submit({
      orgId: org.id,
      requesterId: admin.id,
      serverId: prodServer.id,
      reason: 'Need to patch a critical CVE on the prod app server tonight.',
      requestedDuration: 3600,
      callerRole: 'admin',
    });

    expect(ar.status).toBe('APPROVED');

    const auditRow = await prisma.auditLog.findFirst({
      where: { orgId: org.id, resourceId: ar.id, action: 'access_request.prod_bypass' },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow.metadata).toMatchObject({ requesterRole: 'admin' });

    const notif = await prisma.notification.findFirst({
      where: { orgId: org.id, userId: manager.id, type: 'ACCESS_REQUEST_APPROVED' },
    });
    expect(notif).not.toBeNull();
    expect(notif.metadata).toMatchObject({ accessRequestId: ar.id, bypass: true });
  });

  maybeTest('member (below bypass role) gets a PENDING request instead — no bypass audit', async () => {
    await updateAccessSettings(org.id, { prodApprovalBypassMinRole: 'admin' });

    const ar = await submit({
      orgId: org.id,
      requesterId: member.id,
      serverId: prodServer.id,
      reason: 'Need read-only access to check a log file on prod.',
      requestedDuration: 3600,
      callerRole: 'member',
    });

    expect(ar.status).toBe('PENDING');

    const bypassAudit = await prisma.auditLog.findFirst({
      where: { orgId: org.id, resourceId: ar.id, action: 'access_request.prod_bypass' },
    });
    expect(bypassAudit).toBeNull();
  });
});
