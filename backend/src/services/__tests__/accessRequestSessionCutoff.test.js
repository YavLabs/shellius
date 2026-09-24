/**
 * accessRequestSessionCutoff.test.js — revoking or expiring access must also
 * end the session it is already being used for.
 *
 * The gap this closes: `revoke()` and `markExpired()` revoked the certificate
 * and stopped there. That closes the door to NEW connections — check-principals
 * refuses a revoked certificate, and a fresh RDP token cannot be minted — but
 * it did nothing about the shell or remote desktop the person already had
 * open. On a production host, "access revoked" left the existing session
 * running until the user chose to close it.
 *
 * RDP was the worse half: the Guacamole connection token's expiry is checked
 * once, in `processConnectionSettings` at connect time, and never again, so
 * an RDP session had nothing at all bounding its life.
 *
 * "Certificates auto-expire. Access requests auto-expire. No permanent
 * access." — CLAUDE.md. These tests are what make the last sentence true of
 * sessions and not only of new connections.
 */

import prisma from '../../config/db.js';
import * as accessRequestService from '../accessRequestService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let seq = 0;
const unique = () => {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
};

describe('a session does not outlive its access request', () => {
  let org;
  let customer;
  let srv;
  let requester;
  let approver;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${unique()}` },
    });
    srv = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: `win-${unique()}.example.com`,
        ipAddress: '10.4.0.9',
        environment: 'prod',
        protocol: 'rdp',
      },
    });
    requester = await createTestUser(org.id, { role: 'member' });
    approver = await createTestUser(org.id, { role: 'admin' });
  });

  afterAll(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.session.deleteMany({ where: { orgId: org.id } });
    await prisma.accessRequest.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  afterEach(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.session.deleteMany({ where: { orgId: org.id } });
    await prisma.accessRequest.deleteMany({ where: { orgId: org.id } });
  });

  /** An approved request with a live session attached to it. */
  async function approvedWithSession({ sessionType = 'RDP', expiresAt = new Date(Date.now() + 3600_000) } = {}) {
    const ar = await prisma.accessRequest.create({
      data: {
        orgId: org.id,
        requesterId: requester.id,
        serverId: srv.id,
        requestedPrincipal: 'Administrator',
        protocol: sessionType === 'RDP' ? 'RDP' : 'SSH',
        reason: 'because',
        requestedDuration: 60,
        status: 'APPROVED',
        reviewerId: approver.id,
        approvedAt: new Date(),
        expiresAt,
      },
    });
    const session = await prisma.session.create({
      data: {
        orgId: org.id,
        userId: requester.id,
        serverId: srv.id,
        accessRequestId: ar.id,
        sessionType,
        status: 'ACTIVE',
      },
    });
    return { ar, session };
  }

  test('revoking ends the live RDP session', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { ar, session } = await approvedWithSession();

    await accessRequestService.revoke({
      requestId: ar.id,
      orgId: org.id,
      callerId: approver.id,
      callerPermissions: ['access_requests.revoke_any'],
      reason: 'left the team',
    });

    const after = await prisma.session.findUnique({ where: { id: session.id } });
    expect(after.status).not.toBe('ACTIVE');
  });

  test('revoking ends a live SSH session too', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { ar, session } = await approvedWithSession({ sessionType: 'SSH' });

    await accessRequestService.revoke({
      requestId: ar.id,
      orgId: org.id,
      callerId: approver.id,
      callerPermissions: ['access_requests.revoke_any'],
    });

    const after = await prisma.session.findUnique({ where: { id: session.id } });
    expect(after.status).not.toBe('ACTIVE');
  });

  test('expiry ends the live session', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { ar, session } = await approvedWithSession({ expiresAt: new Date(Date.now() - 1000) });

    await accessRequestService.markExpired();

    const afterAr = await prisma.accessRequest.findUnique({ where: { id: ar.id } });
    expect(afterAr.status).toBe('EXPIRED');
    const after = await prisma.session.findUnique({ where: { id: session.id } });
    expect(after.status).not.toBe('ACTIVE');
  });

  test('a session on another request is left alone', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const a = await approvedWithSession();
    const b = await approvedWithSession();

    await accessRequestService.revoke({
      requestId: a.ar.id,
      orgId: org.id,
      callerId: approver.id,
      callerPermissions: ['access_requests.revoke_any'],
    });

    const untouched = await prisma.session.findUnique({ where: { id: b.session.id } });
    expect(untouched.status).toBe('ACTIVE');
  });

  test('an already-ended session does not stop the revoke being recorded', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { ar, session } = await approvedWithSession();
    await prisma.session.update({ where: { id: session.id }, data: { status: 'ENDED', endedAt: new Date() } });

    const result = await accessRequestService.revoke({
      requestId: ar.id,
      orgId: org.id,
      callerId: approver.id,
      callerPermissions: ['access_requests.revoke_any'],
    });

    expect(result.status).toBe('REVOKED');
  });

  // Best-effort by design: the revoke is the thing that must be durable.
  test('a request with no session revokes cleanly', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const ar = await prisma.accessRequest.create({
      data: {
        orgId: org.id,
        requesterId: requester.id,
        serverId: srv.id,
        requestedPrincipal: 'Administrator',
        protocol: 'RDP',
        reason: 'because',
        requestedDuration: 60,
        status: 'APPROVED',
        reviewerId: approver.id,
        approvedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const result = await accessRequestService.revoke({
      requestId: ar.id,
      orgId: org.id,
      callerId: approver.id,
      callerPermissions: ['access_requests.revoke_any'],
    });
    expect(result.status).toBe('REVOKED');
  });
});
