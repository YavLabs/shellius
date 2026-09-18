/**
 * middleware/agentAuth.js — per-host agent token + legacy shared-secret
 * fallback tests (B-1 / B-2 fix).
 *
 * Live-DB tests (per-host resolution) auto-skip when DATABASE_URL isn't
 * reachable, matching this repo's existing smoke-test convention (see
 * middleware/__tests__/auth.test.js). The legacy-secret and bogus-token
 * cases don't need a matching Server row, but agentAuth always issues one
 * `findUnique` lookup first, so they still require a reachable DB.
 */

import { jest } from '@jest/globals';
import agentAuth from '../agentAuth.js';
import prisma from '../../config/db.js';
import { generateAgentToken } from '../../utils/agentToken.js';
import { dbReachable, createTestOrg, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

function mockReq({ token, body = {} } = {}) {
  return {
    headers: token ? { 'x-agent-token': token } : {},
    body,
    originalUrl: '/api/certificates/verify',
    ip: '127.0.0.1',
  };
}

function mockRes() {
  return { setHeader: jest.fn() };
}

async function createTestServer(orgId, overrides = {}) {
  const customer = await prisma.customer.create({
    data: { orgId, name: 'AgentAuth Test Customer', slug: `agentauth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  return prisma.server.create({
    data: {
      orgId,
      customerId: customer.id,
      hostname: `host-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ipAddress: '10.0.0.5',
      ...overrides,
    },
  });
}

describe('agentAuth — no token', () => {
  test('rejects a request with no x-agent-token header', async () => {
    const next = jest.fn();
    await agentAuth(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: 'AGENT_AUTH_REQUIRED' })
    );
  });
});

describe('agentAuth — DB-backed behavior (live DB)', () => {
  let org;
  let server;
  let plainToken;
  const originalSharedSecret = process.env.AGENT_SHARED_SECRET;
  const originalLegacyMode = process.env.AGENT_LEGACY_SHARED_SECRET;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    const { token, hash } = generateAgentToken();
    plainToken = token;
    server = await createTestServer(org.id, { agentTokenHash: hash, agentTokenIssuedAt: new Date() });
  });

  afterAll(async () => {
    if (org) await cleanupServerOrg(org.id);
    process.env.AGENT_SHARED_SECRET = originalSharedSecret;
    process.env.AGENT_LEGACY_SHARED_SECRET = originalLegacyMode;
    await prisma.$disconnect().catch(() => {});
  });

  async function cleanupServerOrg(orgId) {
    await prisma.server.deleteMany({ where: { orgId } });
    await prisma.customer.deleteMany({ where: { orgId } });
    await cleanupOrg(orgId);
  }

  test('resolves a valid per-host token to req.agentServer, scoped to that server/org', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const req = mockReq({ token: plainToken });
    const next = jest.fn();
    await agentAuth(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(); // no error
    expect(req.agentServer).toEqual({ id: server.id, orgId: org.id, hostname: server.hostname });
    expect(req.agentLegacy).toBe(false);
  });

  test('rejects a bogus token when no legacy secret matches', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    delete process.env.AGENT_SHARED_SECRET;
    const req = mockReq({ token: 'shag_totally-bogus-token' });
    const next = jest.fn();
    await agentAuth(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: 'AGENT_AUTH_INVALID' })
    );
  });

  test('legacy mode "warn" (default): accepts the global shared secret, flags deprecation', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    process.env.AGENT_SHARED_SECRET = 'test-global-shared-secret';
    delete process.env.AGENT_LEGACY_SHARED_SECRET; // default = warn

    const req = mockReq({ token: 'test-global-shared-secret', body: { serverId: server.id } });
    const res = mockRes();
    const next = jest.fn();
    await agentAuth(req, res, next);

    expect(next).toHaveBeenCalledWith(); // accepted, no error
    expect(req.agentServer).toBeNull();
    expect(req.agentLegacy).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith('x-shellius-agent-deprecated', '1');
  });

  test('legacy mode "deny": rejects the global shared secret outright', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    process.env.AGENT_SHARED_SECRET = 'test-global-shared-secret';
    process.env.AGENT_LEGACY_SHARED_SECRET = 'deny';

    const req = mockReq({ token: 'test-global-shared-secret' });
    const next = jest.fn();
    await agentAuth(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: 'AGENT_LEGACY_DENIED' })
    );
  });
});
