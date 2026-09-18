/**
 * middleware/auth.js — authenticate() integration tests.
 *
 * Live-DB tests (SESSION_REVOKED, DB-authoritative role) auto-skip when
 * DATABASE_URL isn't reachable, matching this repo's existing smoke-test
 * convention. The typ-rejection tests are pure unit tests and always run.
 */

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import config from '../../config/index.js';
import authenticate from '../auth.js';
import { generateAccessToken } from '../../utils/jwt.js';
import prisma from '../../config/db.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

function mockReq(token) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    originalUrl: '/api/servers',
    url: '/api/servers',
    method: 'GET',
  };
}

function mockRes() {
  return {};
}

describe('authenticate — token shape rejection (no DB required)', () => {
  test('rejects requests with no Authorization header', async () => {
    const next = jest.fn();
    await authenticate(mockReq(null), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('rejects a bootstrap-shaped token (no typ:"access")', async () => {
    const token = jwt.sign({ kind: 'bootstrap', serverId: 's1', orgId: 'o1' }, config.jwt.secret, {
      expiresIn: 1800,
    });
    const next = jest.fn();
    await authenticate(mockReq(token), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  test('rejects an MFA-challenge-shaped token even signed with the main secret', async () => {
    const token = jwt.sign({ typ: 'mfa_challenge', userId: 'u1', orgId: 'o1', jti: 'x' }, config.jwt.secret, {
      expiresIn: 300,
    });
    const next = jest.fn();
    await authenticate(mockReq(token), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});

describe('authenticate — DB-backed behavior (live DB)', () => {
  let org;
  let user;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    user = await createTestUser(org.id, { role: 'member' });
  });

  afterAll(async () => {
    if (org) await cleanupOrg(org.id);
    await prisma.$disconnect().catch(() => {});
  });

  test('a valid access token for an active user populates req.user with the DB role', async () => {
    if (!(await dbReachable())) {
      console.warn('[skip] DB unreachable');
      return;
    }
    const token = generateAccessToken({ userId: user.id, orgId: org.id, role: 'stale-role', email: user.email });
    const req = mockReq(token);
    const next = jest.fn();
    await authenticate(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(req.user.userId).toBe(user.id);
    expect(req.user.role).toBe('member'); // DB-authoritative, not the stale token claim
  });

  test('SESSION_REVOKED: a token issued before sessionsValidFrom is rejected', async () => {
    if (!(await dbReachable())) {
      console.warn('[skip] DB unreachable');
      return;
    }
    const token = generateAccessToken({ userId: user.id, orgId: org.id, role: 'member', email: user.email });

    // Simulate "sign out everywhere" happening AFTER the token's iat.
    await new Promise((r) => setTimeout(r, 1100)); // ensure the next iat second boundary differs
    await prisma.user.update({ where: { id: user.id }, data: { sessionsValidFrom: new Date() } });

    const req = mockReq(token);
    const next = jest.fn();
    await authenticate(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: 'SESSION_REVOKED' })
    );

    // reset for any subsequent tests in this file
    await prisma.user.update({ where: { id: user.id }, data: { sessionsValidFrom: null } });
  }, 10000);

  test('a non-active user is rejected with SESSION_REVOKED', async () => {
    if (!(await dbReachable())) {
      console.warn('[skip] DB unreachable');
      return;
    }
    const suspended = await createTestUser(org.id, { status: 'suspended' });
    const token = generateAccessToken({ userId: suspended.id, orgId: org.id, role: 'member', email: suspended.email });
    const req = mockReq(token);
    const next = jest.fn();
    await authenticate(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: 'SESSION_REVOKED' }));
  });
});
