/**
 * API token and service-account services.
 *
 * The rules worth holding here are the ones that stop a token becoming a way
 * around the permission system: expiry is mandatory and bounded, a
 * non-delegable permission can't even be requested, a service account can
 * never be a super admin, and nobody can give one a role they don't hold
 * themselves.
 */

import prisma from '../../config/db.js';
import * as apiTokenService from '../apiTokenService.js';
import * as serviceAccountService from '../serviceAccountService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

describe('apiTokenService — pure rules', () => {
  test('expiry is required, bounded, and defaults to 90 days', () => {
    const d = apiTokenService.expiryFrom(undefined);
    const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
    expect(days).toBe(apiTokenService.DEFAULT_EXPIRY_DAYS);

    expect(() => apiTokenService.expiryFrom(0)).toThrow(/at least one day/);
    expect(() => apiTokenService.expiryFrom(-5)).toThrow(/at least one day/);
    expect(() => apiTokenService.expiryFrom('nonsense')).toThrow(/at least one day/);
    expect(() => apiTokenService.expiryFrom(apiTokenService.MAX_EXPIRY_DAYS + 1)).toThrow(/at most/);
  });

  test('scopes are validated, de-duplicated and never non-delegable', () => {
    expect(apiTokenService.normalizeScopes(['servers.view', 'servers.view'])).toEqual(['servers.view']);
    expect(apiTokenService.normalizeScopes(null)).toEqual([]);
    expect(() => apiTokenService.normalizeScopes(['not.a.permission'])).toThrow(/Unknown permission/);
    // Asking for one is an error, not a silent drop — nobody should ship a
    // token believing it can rotate the CA.
    expect(() => apiTokenService.normalizeScopes(['ca.rotate'])).toThrow(/stays something a person does/);
    expect(() => apiTokenService.normalizeScopes(['roles.manage'])).toThrow(/stays something a person does/);
  });

  test('the public shape never carries the hash', () => {
    const pub = apiTokenService.toPublic({
      id: 'a', name: 'n', kind: 'personal', tokenHash: 'SECRET-HASH', tokenPrefix: 'shp_abc',
      scopes: [], expiresAt: new Date(), createdAt: new Date(), userId: 'u',
    });
    expect(JSON.stringify(pub)).not.toContain('SECRET-HASH');
    expect(pub.tokenHash).toBeUndefined();
  });
});

describe('service accounts (live DB)', () => {
  let org;
  let memberRole;
  let adminRole;
  let actorUser;

  // A real user id: createdById is a foreign key, so a made-up actor would
  // fail the insert rather than the rule under test.
  const actorWith = (permissions, tier = 'super_admin', userId = null) => ({
    userId: userId ?? actorUser.id,
    tier,
    roleId: null,
    permissions: new Set(permissions),
  });

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    actorUser = await createTestUser(org.id, { role: 'super_admin' });
    memberRole = await prisma.role.create({
      data: { orgId: org.id, key: `m-${Date.now()}`, name: 'Member', baseRole: 'member', permissions: ['servers.view'] },
    });
    adminRole = await prisma.role.create({
      data: {
        orgId: org.id,
        key: `a-${Date.now()}`,
        name: 'Admin',
        baseRole: 'admin',
        permissions: ['servers.view', 'servers.update', 'users.suspend'],
      },
    });
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.apiToken.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.role.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  test('a service account is a non-login identity with an undeliverable address', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const sa = await serviceAccountService.create(
      org.id,
      { name: 'CI Runner', roleId: memberRole.id },
      actorWith(['servers.view'])
    );

    expect(sa.email).toContain('@service.invalid');
    const row = await prisma.user.findUnique({ where: { id: sa.id } });
    expect(row.kind).toBe('service');
    expect(row.passwordHash).toBeNull();
  });

  test('a service account can never be a super admin', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const sa = await prisma.role.create({
      data: { orgId: org.id, key: `sa-${Date.now()}`, name: 'Owner', baseRole: 'super_admin', permissions: [] },
    });
    await expect(
      serviceAccountService.create(org.id, { name: 'Too much', roleId: sa.id }, actorWith(['servers.view'], 'super_admin'))
    ).rejects.toThrow(/never be a super admin/);
  });

  test('you cannot give a service account permissions you do not hold', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    // The actor is an admin by tier but doesn't hold users.suspend.
    const weak = actorWith(['servers.view', 'servers.update'], 'admin');
    await expect(
      serviceAccountService.create(org.id, { name: 'Escalation', roleId: adminRole.id }, weak)
    ).rejects.toMatchObject({ code: 'ROLE_ESCALATION' });
  });

  test('scoping to customers requires naming at least one', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await expect(
      serviceAccountService.create(
        org.id,
        { name: 'Scoped', roleId: memberRole.id, accessScope: 'CUSTOMERS', customerIds: [] },
        actorWith(['servers.view'])
      )
    ).rejects.toThrow(/at least one customer/);
  });

  test('deactivating a service account revokes its tokens', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const actor = actorWith(['servers.view']);
    const sa = await serviceAccountService.create(org.id, { name: 'Turn me off', roleId: memberRole.id }, actor);
    await serviceAccountService.issueToken(org.id, sa.id, { name: 'k' }, actor);

    const before = await apiTokenService.listForUser(org.id, sa.id);
    expect(before.filter((t) => !t.revokedAt)).toHaveLength(1);

    await serviceAccountService.update(org.id, sa.id, { status: 'deactivated' }, actor);

    const after = await apiTokenService.listForUser(org.id, sa.id);
    expect(after.every((t) => t.revokedAt)).toBe(true);
  });

  test('a personal token cannot be minted for a service account, or vice versa', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const actor = actorWith(['servers.view']);
    const sa = await serviceAccountService.create(org.id, { name: 'Mismatch', roleId: memberRole.id }, actor);
    const person = await createTestUser(org.id);

    await expect(
      apiTokenService.create(org.id, { userId: sa.id, kind: 'personal', name: 'x' }, actor)
    ).rejects.toThrow(/Not a person/);
    await expect(
      apiTokenService.create(org.id, { userId: person.id, kind: 'service', name: 'x' }, actor)
    ).rejects.toThrow(/Not a service account/);
  });

  test('rotating replaces the secret and leaves no grace window', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const person = await createTestUser(org.id);
    const { token: first, apiToken } = await apiTokenService.create(
      org.id,
      { userId: person.id, kind: 'personal', name: 'rotate me' },
      null
    );
    const { token: second } = await apiTokenService.rotate(org.id, apiToken.id, {}, null);

    expect(second).not.toBe(first);
    // Exactly one row, holding only the new secret's hash.
    const rows = await prisma.apiToken.findMany({ where: { id: apiToken.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].rotatedAt).not.toBeNull();
  });

  test('a revoked token cannot be rotated back to life', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const person = await createTestUser(org.id);
    const { apiToken } = await apiTokenService.create(
      org.id,
      { userId: person.id, kind: 'personal', name: 'gone' },
      null
    );
    await apiTokenService.revoke(org.id, apiToken.id, {}, null);
    await expect(apiTokenService.rotate(org.id, apiToken.id, {}, null)).rejects.toThrow(/revoked/);
  });

  test('one person cannot touch another person’s token', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const mine = await createTestUser(org.id);
    const theirs = await createTestUser(org.id);
    const { apiToken } = await apiTokenService.create(
      org.id,
      { userId: theirs.id, kind: 'personal', name: 'not yours' },
      null
    );

    // The routes pass the caller's own id as `userId`, which scopes the lookup.
    await expect(apiTokenService.revoke(org.id, apiToken.id, { userId: mine.id }, null)).rejects.toThrow(/not found/i);
  });
});
