/**
 * A production approval cannot be made by whoever holds the emailed link.
 *
 * The approval email carries a 24-hour, single-use URL that acts as the named
 * approver with no login at all. For a dev box that is a fair trade for the
 * convenience. For production it is a way around the authentication half of
 * the approval flow: a forwarded message, a shared inbox or a compromised mail
 * account is enough, and the audit entry would name an approver who never
 * touched it.
 *
 * So a prod decision now needs a session belonging to that same approver. The
 * link still opens the request; it just cannot decide it on its own.
 */

import request from 'supertest';
import express from 'express';
import prisma from '../../config/db.js';
import approvalsRouter from '../approvals.js';
import errorHandler from '../../middleware/errorHandler.js';
import * as inviteService from '../../services/inviteService.js';
import { generateAccessToken } from '../../utils/jwt.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

// Mount the router alone, as the other route tests do — importing app.js
// would start the background jobs and never let the suite exit.
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/approvals', approvalsRouter);
  app.use(errorHandler);
  return app;
}

let reachable = false;
let org;
let customer;
let prodServer;
let devServer;
let requester;
let approver;
let bystander;

async function makeRequest(server) {
  return prisma.accessRequest.create({
    data: {
      orgId: org.id,
      requesterId: requester.id,
      serverId: server.id,
      reason: 'incident 4412',
      requestedPrincipal: 'ubuntu',
      requestedDuration: 3600,
      protocol: 'SSH',
      status: 'PENDING',
      reviewerId: approver.id,
      approvers: { create: [{ userId: approver.id }] },
    },
  });
}

const tokenFor = async (accessRequestId) =>
  (
    await inviteService.createResourceToken(
      approver.id,
      inviteService.TOKEN_TYPES.ACCESS_APPROVAL,
      accessRequestId,
      24
    )
  ).rawToken;

describe('emailed approval link — production requires a session (live DB)', () => {
  const app = buildApp();
  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Link Co', slug: `link-${Date.now()}` },
    });
    const base = {
      orgId: org.id,
      customerId: customer.id,
      protocol: 'ssh',
      provisionStatus: 'provisioned',
    };
    prodServer = await prisma.server.create({
      data: { ...base, hostname: 'prod-link-01.internal', ipAddress: '10.4.4.1', environment: 'prod' },
    });
    devServer = await prisma.server.create({
      data: { ...base, hostname: 'dev-link-01.internal', ipAddress: '10.4.4.2', environment: 'dev' },
    });
    requester = await createTestUser(org.id, { role: 'member', name: 'Requester' });
    approver = await createTestUser(org.id, { role: 'manager', name: 'The Approver' });
    bystander = await createTestUser(org.id, { role: 'super_admin', name: 'Someone Else' });
  });

  afterEach(async () => {
    if (!reachable || !org) return;
    await prisma.notification.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
    await prisma.userToken.deleteMany({ where: { user: { orgId: org.id } } });
    await prisma.accessRequestApprover.deleteMany({ where: { request: { orgId: org.id } } });
    await prisma.accessRequest.deleteMany({ where: { orgId: org.id } });
  });

  afterAll(async () => {
    if (!reachable || !org) return;
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  test('the link alone cannot approve production', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(prodServer);
    const token = await tokenFor(ar.id);

    const res = await request(app).post(`/api/approvals/${token}`).send({ decision: 'approve' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REQUIRED');
    const after = await prisma.accessRequest.findUnique({ where: { id: ar.id } });
    expect(after.status).toBe('PENDING');
  });

  test('the peek still works, and says a session will be needed', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(prodServer);
    const token = await tokenFor(ar.id);

    const res = await request(app).get(`/api/approvals/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.request.requiresSession).toBe(true);
    expect(res.body.data.request.server.environment).toBe('prod');
  });

  test('signed in as the approver, production can be approved', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(prodServer);
    const token = await tokenFor(ar.id);
    const jwt = generateAccessToken({ userId: approver.id, orgId: org.id });

    const res = await request(app)
      .post(`/api/approvals/${token}`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ decision: 'approve' });

    expect(res.status).toBe(200);
    const after = await prisma.accessRequest.findUnique({ where: { id: ar.id } });
    expect(after.status).toBe('APPROVED');
  });

  test('somebody else being signed in does not count, even a super admin', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(prodServer);
    const token = await tokenFor(ar.id);
    const jwt = generateAccessToken({ userId: bystander.id, orgId: org.id });

    const res = await request(app)
      .post(`/api/approvals/${token}`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ decision: 'approve' });

    // The token names one approver. Holding it plus any other session must not
    // let a second person act in that approver's name.
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REQUIRED');
    const after = await prisma.accessRequest.findUnique({ where: { id: ar.id } });
    expect(after.status).toBe('PENDING');
  });

  test('non-production keeps one-click approval from the email', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(devServer);
    const token = await tokenFor(ar.id);

    const res = await request(app).post(`/api/approvals/${token}`).send({ decision: 'approve' });

    expect(res.status).toBe(200);
    const after = await prisma.accessRequest.findUnique({ where: { id: ar.id } });
    expect(after.status).toBe('APPROVED');
  });

  test('the audit entry records how the decision was made', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(devServer);
    const token = await tokenFor(ar.id);

    const res = await request(app).post(`/api/approvals/${token}`).send({ decision: 'approve' });
    expect(res.status).toBe(200);

    const entry = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'access_request.approved', resourceId: ar.id },
    });
    // "Was this approved by someone logged in, or by whoever held a link?"
    // used to be unanswerable from the audit log.
    expect(entry.metadata.via).toBe('email_token');
    expect(entry.metadata.environment).toBe('dev');
  });
});
