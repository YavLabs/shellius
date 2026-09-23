/**
 * One request, one decision.
 *
 * `review()` used to read the request, check `status === 'PENDING'`, and then
 * update it — three statements with no transaction between them. Two approvals
 * arriving together both passed the check and both wrote, producing two
 * approvals, two audit rows and two different expiry times for a single
 * request.
 *
 * That was survivable while the only way to approve was a human clicking a
 * button in a browser. It stops being survivable with an approve button in
 * Slack: Slack re-sends any interaction it has not had a response to within
 * three seconds, and each retry is a separately signed, entirely valid
 * request. The race goes from rare to routine.
 *
 * The fix makes PENDING part of the WHERE clause, so the database picks the
 * winner. These tests race the real service against a real database.
 */

import prisma from '../../config/db.js';
import * as accessRequestService from '../accessRequestService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let reachable = false;
let org;
let customer;
let server;
let requester;
let approverA;
let approverB;

async function pendingRequest() {
  return prisma.accessRequest.create({
    data: {
      orgId: org.id,
      requesterId: requester.id,
      serverId: server.id,
      reason: 'racing the approvers',
      requestedPrincipal: 'ubuntu',
      requestedDuration: 3600,
      protocol: 'SSH',
      status: 'PENDING',
      reviewerId: approverA.id,
      approvers: { create: [{ userId: approverA.id }, { userId: approverB.id }] },
    },
  });
}

describe('access request review is decided exactly once (live DB)', () => {
  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Race Co', slug: `race-${Date.now()}` },
    });
    server = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: 'race-01.internal',
        ipAddress: '10.9.9.9',
        environment: 'dev',
        protocol: 'ssh',
        provisionStatus: 'provisioned',
      },
    });
    requester = await createTestUser(org.id, { role: 'member', name: 'Requester' });
    approverA = await createTestUser(org.id, { role: 'manager', name: 'Approver A' });
    approverB = await createTestUser(org.id, { role: 'manager', name: 'Approver B' });
  });

  afterEach(async () => {
    if (!reachable || !org) return;
    await prisma.notification.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
    await prisma.accessRequestApprover.deleteMany({ where: { request: { orgId: org.id } } });
    await prisma.accessRequest.deleteMany({ where: { orgId: org.id } });
  });

  afterAll(async () => {
    if (!reachable || !org) return;
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  test('two approvals racing produce one approval and one audit row', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const req = await pendingRequest();

    const results = await Promise.allSettled([
      accessRequestService.review({ requestId: req.id, reviewerId: approverA.id, decision: 'approve' }),
      accessRequestService.review({ requestId: req.id, reviewerId: approverB.id, decision: 'approve' }),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason.statusCode).toBe(409);

    const after = await prisma.accessRequest.findUnique({ where: { id: req.id } });
    expect(after.status).toBe('APPROVED');

    // The decisive assertion: one decision, one audit entry. Two would mean
    // two approvals were recorded for one request.
    const approvals = await prisma.auditLog.count({
      where: { orgId: org.id, action: 'access_request.approved', resourceId: req.id },
    });
    expect(approvals).toBe(1);
  });

  test('an approval racing a denial leaves one status, not a mix', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const req = await pendingRequest();

    const results = await Promise.allSettled([
      accessRequestService.review({ requestId: req.id, reviewerId: approverA.id, decision: 'approve' }),
      accessRequestService.review({ requestId: req.id, reviewerId: approverB.id, decision: 'deny', deniedReason: 'no' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const after = await prisma.accessRequest.findUnique({ where: { id: req.id } });
    expect(['APPROVED', 'DENIED']).toContain(after.status);
    // Whichever won, the loser must not have left its own timestamps behind.
    if (after.status === 'APPROVED') {
      expect(after.deniedAt).toBeNull();
      expect(after.expiresAt).not.toBeNull();
    } else {
      expect(after.approvedAt).toBeNull();
    }

    const decisions = await prisma.auditLog.count({
      where: {
        orgId: org.id,
        resourceId: req.id,
        action: { in: ['access_request.approved', 'access_request.denied'] },
      },
    });
    expect(decisions).toBe(1);
  });

  test('deciding an already-decided request is refused, not applied twice', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const req = await pendingRequest();

    await accessRequestService.review({ requestId: req.id, reviewerId: approverA.id, decision: 'approve' });
    const first = await prisma.accessRequest.findUnique({ where: { id: req.id } });

    await expect(
      accessRequestService.review({ requestId: req.id, reviewerId: approverB.id, decision: 'deny', deniedReason: 'late' })
    ).rejects.toMatchObject({ statusCode: 409 });

    const second = await prisma.accessRequest.findUnique({ where: { id: req.id } });
    expect(second.status).toBe('APPROVED');
    expect(second.reviewerId).toBe(first.reviewerId);
    expect(second.expiresAt).toEqual(first.expiresAt);
  });

  test('the decision is audited before anyone is told about it', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const req = await pendingRequest();

    await accessRequestService.review({ requestId: req.id, reviewerId: approverA.id, decision: 'approve' });

    const audit = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'access_request.approved', resourceId: req.id },
      select: { createdAt: true },
    });
    const note = await prisma.notification.findFirst({
      where: { orgId: org.id, type: 'ACCESS_REQUEST_APPROVED' },
      select: { createdAt: true },
    });

    expect(audit).not.toBeNull();
    expect(note).not.toBeNull();
    // Ordering is the point: the decision is already committed by now, so the
    // audit row must not be able to be lost by a notification that throws.
    // Notifying is also wrapped, so a failure there can no longer propagate.
    expect(audit.createdAt.getTime()).toBeLessThanOrEqual(note.createdAt.getTime());
  });
});
