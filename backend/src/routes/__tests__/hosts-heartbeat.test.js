/**
 * POST /api/hosts/heartbeat — per-host token identity tests (B-2 fix).
 *
 * Before this fix, the route trusted serverId/orgId straight out of the
 * request body once a single global AGENT_SHARED_SECRET matched — any host
 * (or anyone who read the world-readable token off any host) could spoof
 * another server's heartbeat. Live-DB, auto-skips when unreachable.
 */

import express from 'express';
import request from 'supertest';
import prisma from '../../config/db.js';
import hostsRouter from '../hosts.js';
import errorHandler from '../../middleware/errorHandler.js';
import { generateAgentToken } from '../../utils/agentToken.js';
import { dbReachable, createTestOrg, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/hosts', hostsRouter);
  app.use(errorHandler);
  return app;
}

let seq = 0;
function uniq() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

async function createServer(orgId, overrides = {}) {
  const customer = await prisma.customer.create({
    data: { orgId, name: 'Heartbeat Test Customer', slug: `heartbeat-${uniq()}` },
  });
  return prisma.server.create({
    data: { orgId, customerId: customer.id, hostname: `host-${uniq()}`, ipAddress: '10.0.0.7', ...overrides },
  });
}

describe('POST /api/hosts/heartbeat (live DB)', () => {
  const app = buildApp();
  const originalSharedSecret = process.env.AGENT_SHARED_SECRET;
  let orgA;
  let orgB;
  let serverA;
  let serverB;
  let tokenA;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    orgA = await createTestOrg();
    orgB = await createTestOrg();
    const { token, hash } = generateAgentToken();
    tokenA = token;
    serverA = await createServer(orgA.id, { agentTokenHash: hash, agentTokenIssuedAt: new Date() });
    serverB = await createServer(orgB.id);
  });

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      if (!org) continue;
      await prisma.server.deleteMany({ where: { orgId: org.id } });
      await prisma.customer.deleteMany({ where: { orgId: org.id } });
      await cleanupOrg(org.id);
    }
    process.env.AGENT_SHARED_SECRET = originalSharedSecret;
    await prisma.$disconnect().catch(() => {});
  });

  test('per-host token: updates the token-bound server and ignores a spoofed body serverId/orgId', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');

    const res = await request(app)
      .post('/api/hosts/heartbeat')
      .set('x-agent-token', tokenA)
      .send({
        agentId: 'agent-spoof-test',
        // Attacker-controlled body pointing at a DIFFERENT org/server.
        serverId: serverB.id,
        orgId: orgB.id,
        hostname: 'spoofed-hostname',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.received).toBe(true);

    const updatedA = await prisma.server.findUnique({ where: { id: serverA.id } });
    expect(updatedA.agentId).toBe('agent-spoof-test');
    expect(updatedA.agentLastSeen).not.toBeNull();

    const updatedB = await prisma.server.findUnique({ where: { id: serverB.id } });
    expect(updatedB.agentId).toBeNull(); // untouched — the spoofed target
  });

  test('bogus token is rejected with 401', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    delete process.env.AGENT_SHARED_SECRET;
    const res = await request(app)
      .post('/api/hosts/heartbeat')
      .set('x-agent-token', 'shag_bogus')
      .send({ agentId: 'x', serverId: serverA.id, orgId: orgA.id });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('legacy mode: falls back to body serverId/orgId when they match', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    process.env.AGENT_SHARED_SECRET = 'test-global-shared-secret';

    const res = await request(app)
      .post('/api/hosts/heartbeat')
      .set('x-agent-token', 'test-global-shared-secret')
      .send({ agentId: 'legacy-agent', serverId: serverB.id, orgId: orgB.id });

    expect(res.status).toBe(200);
    expect(res.body.data.received).toBe(true);
    expect(res.headers['x-shellius-agent-deprecated']).toBe('1');

    const updatedB = await prisma.server.findUnique({ where: { id: serverB.id } });
    expect(updatedB.agentId).toBe('legacy-agent');
  });
});
