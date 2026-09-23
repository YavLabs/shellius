/**
 * Approving from Slack, end to end.
 *
 * This endpoint can approve production access with no browser session, so the
 * tests are written as attempts to get something for nothing: an unsigned
 * request, a replayed one, a stranger's Slack account, a Slack account
 * belonging to someone who is not an approver, the same button pressed twice,
 * and production while the organization has not allowed it.
 *
 * The one that must pass is the ordinary one: a linked approver presses
 * Approve and the request is approved, by them, with an audit entry that says
 * it came from Slack.
 */

import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import prisma from '../../config/db.js';
import slackInteractionsRouter from '../slackInteractions.js';
import errorHandler from '../../middleware/errorHandler.js';
import { encrypt } from '../../utils/crypto.js';
import { setChatApprovalsAllowProd } from '../../services/orgService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

const SIGNING_SECRET = 'test-signing-secret';
const TEAM_ID = 'T_TEST_WORKSPACE';

function buildApp() {
  const app = express();
  app.use('/api/chat/slack', slackInteractionsRouter);
  app.use(errorHandler);
  return app;
}

/** Exactly what Slack sends: form-encoded, with the signature over the bytes. */
function slackPost(app, payload, { secret = SIGNING_SECRET, timestamp = null } = {}) {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const sig = `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
  return request(app)
    .post('/api/chat/slack/interactions')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .set('X-Slack-Request-Timestamp', String(ts))
    .set('X-Slack-Signature', sig)
    .send(body);
}

const pressPayload = (requestId, slackUserId, { actionId = 'approve_request', verb = 'approve', ts = null } = {}) => ({
  type: 'block_actions',
  team: { id: TEAM_ID },
  user: { id: slackUserId, username: 'someone' },
  message: { ts: ts ?? `${Date.now()}.0001` },
  actions: [{ action_id: actionId, value: `${verb}:${requestId}` }],
});

let reachable = false;
let org;
let customer;
let devServer;
let prodServer;
let requester;
let approver;
let outsider;

async function makeRequest(server) {
  return prisma.accessRequest.create({
    data: {
      orgId: org.id,
      requesterId: requester.id,
      serverId: server.id,
      reason: 'incident 22',
      requestedPrincipal: 'ubuntu',
      requestedDuration: 3600,
      protocol: 'SSH',
      status: 'PENDING',
      reviewerId: approver.id,
      approvers: { create: [{ userId: approver.id }] },
    },
  });
}

describe('POST /api/chat/slack/interactions (live DB)', () => {
  const app = buildApp();

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Slack Co', slug: `slack-${Date.now()}` },
    });
    const base = { orgId: org.id, customerId: customer.id, protocol: 'ssh', provisionStatus: 'provisioned' };
    devServer = await prisma.server.create({
      data: { ...base, hostname: 'dev-slack-01', ipAddress: '10.7.7.1', environment: 'dev' },
    });
    prodServer = await prisma.server.create({
      data: { ...base, hostname: 'prod-slack-01', ipAddress: '10.7.7.2', environment: 'prod' },
    });
    requester = await createTestUser(org.id, { role: 'member', name: 'Requester' });
    approver = await createTestUser(org.id, { role: 'manager', name: 'The Approver' });
    outsider = await createTestUser(org.id, { role: 'member', name: 'Not An Approver' });

    await prisma.chatDestination.create({
      data: {
        orgId: org.id,
        name: 'Slack',
        platform: 'slack',
        mode: 'app',
        configEncrypted: encrypt(
          JSON.stringify({
            mode: 'app',
            botToken: 'xoxb-test',
            channel: '#ops',
            signingSecret: SIGNING_SECRET,
            workspaceId: TEAM_ID,
          })
        ),
      },
    });
    await prisma.chatIdentity.create({
      data: {
        orgId: org.id,
        userId: approver.id,
        platform: 'slack',
        workspaceId: TEAM_ID,
        externalUserId: 'U_APPROVER',
        linkedVia: 'confirmed',
      },
    });
    await prisma.chatIdentity.create({
      data: {
        orgId: org.id,
        userId: outsider.id,
        platform: 'slack',
        workspaceId: TEAM_ID,
        externalUserId: 'U_OUTSIDER',
        linkedVia: 'confirmed',
      },
    });
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
    await prisma.chatIdentity.deleteMany({ where: { orgId: org.id } });
    await prisma.chatDelivery.deleteMany({ where: { orgId: org.id } });
    await prisma.chatDestination.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  // -------------------------------------------------------------------------
  // The ordinary case
  // -------------------------------------------------------------------------

  test('a linked approver can approve, and the audit says it came from Slack', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(devServer);

    const res = await slackPost(app, pressPayload(ar.id, 'U_APPROVER'));

    expect(res.status).toBe(200);
    expect(res.body.text).toMatch(/Approved/);
    // The message is replaced, so nobody else in the channel can press it.
    expect(res.body.replace_original).toBe(true);

    const after = await prisma.accessRequest.findUnique({ where: { id: ar.id } });
    expect(after.status).toBe('APPROVED');
    expect(after.reviewerId).toBe(approver.id);

    const entry = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'access_request.approved', resourceId: ar.id },
    });
    expect(entry.metadata.via).toBe('slack');
    expect(entry.actorId).toBe(approver.id);
  });

  test('deny works the same way', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(devServer);

    const res = await slackPost(app, pressPayload(ar.id, 'U_APPROVER', { actionId: 'deny_request', verb: 'deny' }));

    expect(res.status).toBe(200);
    const after = await prisma.accessRequest.findUnique({ where: { id: ar.id } });
    expect(after.status).toBe('DENIED');
  });

  // -------------------------------------------------------------------------
  // Getting something for nothing
  // -------------------------------------------------------------------------

  test('an unsigned request approves nothing', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(devServer);

    const res = await request(app)
      .post('/api/chat/slack/interactions')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`payload=${encodeURIComponent(JSON.stringify(pressPayload(ar.id, 'U_APPROVER')))}`);

    expect(res.status).toBe(401);
    expect((await prisma.accessRequest.findUnique({ where: { id: ar.id } })).status).toBe('PENDING');
  });

  test('a signature from the wrong secret approves nothing', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(devServer);

    const res = await slackPost(app, pressPayload(ar.id, 'U_APPROVER'), { secret: 'not-our-secret' });

    expect(res.status).toBe(401);
    expect((await prisma.accessRequest.findUnique({ where: { id: ar.id } })).status).toBe('PENDING');
  });

  test('a replayed request from outside the window approves nothing', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(devServer);
    const old = Math.floor(Date.now() / 1000) - 3600;

    const res = await slackPost(app, pressPayload(ar.id, 'U_APPROVER'), { timestamp: old });

    expect(res.status).toBe(401);
    expect((await prisma.accessRequest.findUnique({ where: { id: ar.id } })).status).toBe('PENDING');
  });

  test('an unlinked Slack account is offered a link and changes nothing', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(devServer);

    const res = await slackPost(app, pressPayload(ar.id, 'U_STRANGER'));

    expect(res.status).toBe(200);
    expect(res.body.response_type).toBe('ephemeral');
    expect(res.body.text).toMatch(/isn't linked/i);
    expect((await prisma.accessRequest.findUnique({ where: { id: ar.id } })).status).toBe('PENDING');
  });

  test('a linked account that is not an approver is refused by the service layer', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(devServer);

    const res = await slackPost(app, pressPayload(ar.id, 'U_OUTSIDER'));

    expect(res.status).toBe(200);
    expect(res.body.text).toMatch(/Not done/);
    expect((await prisma.accessRequest.findUnique({ where: { id: ar.id } })).status).toBe('PENDING');
  });

  test('the same press twice approves once', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const ar = await makeRequest(devServer);
    // Slack re-sends anything it has not had a response to within 3 seconds,
    // and every retry is separately signed and entirely valid.
    const payload = pressPayload(ar.id, 'U_APPROVER', { ts: '1700000000.0001' });

    const first = await slackPost(app, payload);
    const second = await slackPost(app, payload);

    expect(first.status).toBe(200);
    expect(second.body.text).toMatch(/already handled/i);

    const approvals = await prisma.auditLog.count({
      where: { orgId: org.id, action: 'access_request.approved', resourceId: ar.id },
    });
    expect(approvals).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Production
  // -------------------------------------------------------------------------

  test('production is refused while the organization has not allowed chat approvals', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    await setChatApprovalsAllowProd(org.id, false);
    const ar = await makeRequest(prodServer);

    const res = await slackPost(app, pressPayload(ar.id, 'U_APPROVER'));

    expect(res.body.text).toMatch(/not approved from chat/i);
    expect((await prisma.accessRequest.findUnique({ where: { id: ar.id } })).status).toBe('PENDING');
  });

  test('production works once the organization turns it on', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    await setChatApprovalsAllowProd(org.id, true);
    const ar = await makeRequest(prodServer);

    const res = await slackPost(app, pressPayload(ar.id, 'U_APPROVER'));

    expect(res.body.text).toMatch(/Approved/);
    expect((await prisma.accessRequest.findUnique({ where: { id: ar.id } })).status).toBe('APPROVED');
    await setChatApprovalsAllowProd(org.id, false);
  });

  test('denying production is always allowed — the switch only gates granting', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    await setChatApprovalsAllowProd(org.id, false);
    const ar = await makeRequest(prodServer);

    const res = await slackPost(app, pressPayload(ar.id, 'U_APPROVER', { actionId: 'deny_request', verb: 'deny' }));

    expect((await prisma.accessRequest.findUnique({ where: { id: ar.id } })).status).toBe('DENIED');
    expect(res.body.text).toMatch(/Denied/);
  });
});
