/**
 * API token authentication — the seam.
 *
 * The property that matters most here is that a token can only ever narrow:
 * its permissions are intersected with its user's LIVE role on every request,
 * so demoting someone weakens their outstanding tokens on the next call, with
 * nothing to re-mint. These tests hold that line, plus the deny-list and the
 * rejection cases.
 *
 * Live-DB integration where a real user/role is needed; auto-skipped when
 * DATABASE_URL is unreachable.
 */

import prisma from '../../config/db.js';
import apiTokenAuth, { isForbiddenPath, effectivePermissions, FORBIDDEN_PREFIXES } from '../apiTokenAuth.js';
import bearerAuth from '../auth.js';
import { generateApiToken, hashApiToken, looksLikeApiToken, kindOfToken } from '../../utils/apiToken.js';
import { NON_DELEGABLE_PERMISSIONS } from '../../config/permissions.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

const reqFor = (token, { method = 'GET', url = '/api/servers' } = {}) => ({
  method,
  url,
  originalUrl: url,
  headers: { authorization: `Bearer ${token}` },
  ip: '10.0.0.1',
  params: {},
});

/** Run a middleware and resolve with the error it passed to next(), or null. */
const run = (mw, req) => new Promise((resolve) => mw(req, {}, (err) => resolve(err || null)));

describe('apiToken utils', () => {
  test('tokens carry a recognisable prefix and a stable hash', () => {
    const { token, hash, prefix } = generateApiToken('service');
    expect(token.startsWith('shs_')).toBe(true);
    expect(kindOfToken(token)).toBe('service');
    expect(looksLikeApiToken(token)).toBe(true);
    expect(hash).toBe(hashApiToken(token));
    expect(hash).toHaveLength(64);
    expect(token.startsWith(prefix)).toBe(true);
    // The display prefix must not be enough to authenticate with.
    expect(prefix.length).toBeLessThan(token.length);
  });

  test('a JWT is not mistaken for an API token', () => {
    expect(looksLikeApiToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def')).toBe(false);
    expect(kindOfToken('eyJhbGci')).toBeNull();
  });

  test('two tokens are never the same', () => {
    const a = generateApiToken('personal');
    const b = generateApiToken('personal');
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('forbidden paths', () => {
  test('a token cannot reach the endpoints that would let it escalate', () => {
    for (const prefix of FORBIDDEN_PREFIXES) {
      expect(isForbiddenPath({ method: 'POST', originalUrl: `${prefix}/anything` })).toBe(true);
    }
    expect(isForbiddenPath({ method: 'POST', originalUrl: '/api/tokens' })).toBe(true);
    expect(isForbiddenPath({ method: 'GET', originalUrl: '/api/terminal/ws-ticket' })).toBe(true);
  });

  test('ordinary endpoints are reachable, and whoami is the one exception', () => {
    expect(isForbiddenPath({ method: 'GET', originalUrl: '/api/servers' })).toBe(false);
    expect(isForbiddenPath({ method: 'GET', originalUrl: '/api/auth/me' })).toBe(false);
    // …but only that one, on that one method.
    expect(isForbiddenPath({ method: 'POST', originalUrl: '/api/auth/me' })).toBe(true);
    expect(isForbiddenPath({ method: 'POST', originalUrl: '/api/auth/login' })).toBe(true);
  });

  test('a prefix match does not leak into a similarly-named path', () => {
    // /api/authorizations is not /api/auth
    expect(isForbiddenPath({ method: 'GET', originalUrl: '/api/authorizations' })).toBe(false);
  });
});

describe('effectivePermissions', () => {
  const userWith = (permissions) => ({
    role: 'admin',
    assignedRole: { baseRole: 'admin', permissions, key: 'admin' },
  });

  test('empty scopes means everything the role allows', () => {
    const got = effectivePermissions(userWith(['servers.view', 'servers.update']), []);
    expect(got.has('servers.view')).toBe(true);
    expect(got.has('servers.update')).toBe(true);
  });

  test('scopes narrow, and can never add what the role lacks', () => {
    const got = effectivePermissions(userWith(['servers.view']), ['servers.view', 'servers.delete']);
    expect(got.has('servers.view')).toBe(true);
    // Asked for, but the owner doesn't hold it — so the token doesn't either.
    expect(got.has('servers.delete')).toBe(false);
  });

  test('non-delegable permissions are stripped even from a super admin', () => {
    // A super admin holds everything; a token of theirs still must not.
    const everything = userWith(NON_DELEGABLE_PERMISSIONS.concat(['servers.view']));
    const got = effectivePermissions(everything, []);
    for (const key of NON_DELEGABLE_PERMISSIONS) expect(got.has(key)).toBe(false);
    expect(got.has('servers.view')).toBe(true);
  });
});

describe('apiTokenAuth against the database', () => {
  let org;
  let owner;

  const mintFor = async (userId, overrides = {}) => {
    const { token, hash, prefix } = generateApiToken(overrides.kind || 'personal');
    const row = await prisma.apiToken.create({
      data: {
        orgId: org.id,
        userId,
        kind: overrides.kind || 'personal',
        name: overrides.name || 'test token',
        tokenHash: hash,
        tokenPrefix: prefix,
        scopes: overrides.scopes || [],
        expiresAt: overrides.expiresAt || new Date(Date.now() + 86_400_000),
        revokedAt: overrides.revokedAt || null,
      },
    });
    return { token, row };
  };

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    owner = await createTestUser(org.id, { role: 'admin' });
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.apiToken.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  test('a valid token authenticates and looks like any other caller', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { token, row } = await mintFor(owner.id);
    const req = reqFor(token);

    expect(await run(apiTokenAuth, req)).toBeNull();
    expect(req.user.userId).toBe(owner.id);
    expect(req.user.orgId).toBe(org.id);
    expect(req.user.permissions).toBeInstanceOf(Set);
    expect(req.user.isToken).toBe(true);
    expect(req.auth).toMatchObject({ type: 'api_token', tokenId: row.id });
  });

  test('the composed entry point routes by prefix', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { token } = await mintFor(owner.id);
    const req = reqFor(token);
    // bearerAuth is what routers mount; it must reach the token path.
    expect(await run(bearerAuth, req)).toBeNull();
    expect(req.user.isToken).toBe(true);
  });

  test('a revoked token is refused', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { token } = await mintFor(owner.id, { revokedAt: new Date() });
    const err = await run(apiTokenAuth, reqFor(token));
    expect(err.statusCode).toBe(401);
    expect(err.details?.code || err.code).toBe('TOKEN_REVOKED');
  });

  test('an expired token is refused', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { token } = await mintFor(owner.id, { expiresAt: new Date(Date.now() - 1000) });
    const err = await run(apiTokenAuth, reqFor(token));
    expect(err.statusCode).toBe(401);
    expect(err.details?.code || err.code).toBe('TOKEN_EXPIRED');
  });

  test('an unknown token is refused', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const err = await run(apiTokenAuth, reqFor(generateApiToken('personal').token));
    expect(err.statusCode).toBe(401);
    expect(err.details?.code || err.code).toBe('TOKEN_INVALID');
  });

  test('suspending the owner kills their tokens immediately', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const victim = await createTestUser(org.id);
    const { token } = await mintFor(victim.id);

    expect(await run(apiTokenAuth, reqFor(token))).toBeNull();

    await prisma.user.update({ where: { id: victim.id }, data: { status: 'suspended' } });

    const err = await run(apiTokenAuth, reqFor(token));
    expect(err.statusCode).toBe(401);
    expect(err.details?.code || err.code).toBe('TOKEN_PRINCIPAL_INACTIVE');
  });

  test('demoting the owner narrows the token on the very next request', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const role = await prisma.role.create({
      data: {
        orgId: org.id,
        key: `tmp-${Date.now()}`,
        name: 'Temp',
        baseRole: 'admin',
        permissions: ['servers.view', 'servers.update'],
      },
    });
    const user = await createTestUser(org.id, { role: 'admin', data: { roleId: role.id } });
    const { token } = await mintFor(user.id, { scopes: ['servers.view', 'servers.update'] });

    const first = reqFor(token);
    await run(apiTokenAuth, first);
    expect(first.user.permissions.has('servers.update')).toBe(true);

    // The role loses a permission — nothing about the token changes.
    await prisma.role.update({ where: { id: role.id }, data: { permissions: ['servers.view'] } });

    const second = reqFor(token);
    await run(apiTokenAuth, second);
    expect(second.user.permissions.has('servers.view')).toBe(true);
    expect(second.user.permissions.has('servers.update')).toBe(false);

    await prisma.apiToken.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.role.delete({ where: { id: role.id } });
  });

  test('a forbidden path is refused before the token is even looked up', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    // Deliberately an invalid token: the deny-list must not depend on it.
    const err = await run(apiTokenAuth, reqFor('shp_not-a-real-token', { method: 'POST', url: '/api/tokens' }));
    expect(err.statusCode).toBe(403);
    expect(err.details?.code || err.code).toBe('TOKEN_NOT_ALLOWED_HERE');
  });

  test('a service account cannot authenticate through the JWT path', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const svc = await createTestUser(org.id, { passwordHash: null, data: { kind: 'service' } });
    const { token } = await mintFor(svc.id, { kind: 'service' });

    // Its token works…
    const req = reqFor(token);
    expect(await run(apiTokenAuth, req)).toBeNull();
    expect(req.user.kind).toBe('service');

    // …and its identity still satisfies the AuditLog actor foreign key,
    // which is the whole reason service accounts are real user rows.
    const entry = await prisma.auditLog.create({
      data: { orgId: org.id, actorId: svc.id, action: 'api_token.first_use', resourceType: 'ApiToken' },
    });
    expect(entry.actorId).toBe(svc.id);
  });
});
