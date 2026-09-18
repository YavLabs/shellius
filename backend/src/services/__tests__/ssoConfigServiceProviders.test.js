/**
 * ssoConfigService — Revision 2 multi-provider CRUD: create/update/list/
 * reorder/delete, secret never returned, and the LAST_SIGN_IN_METHOD guard
 * on delete.
 *
 * Live-DB tests auto-skip (console.warn) when DATABASE_URL is unreachable.
 */

import prisma from '../../config/db.js';
import * as ssoConfigService from '../ssoConfigService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let org;
let skip = false;

beforeAll(async () => {
  skip = !(await dbReachable());
  if (skip) {
    console.warn('[skip] ssoConfigService provider CRUD tests — DATABASE_URL unreachable');
    return;
  }
  org = await createTestOrg();
});

afterAll(async () => {
  if (org) await cleanupOrg(org.id);
  await prisma.$disconnect().catch(() => {});
});

function draft(overrides = {}) {
  return {
    name: 'Acme Okta',
    presetId: 'okta',
    clientId: 'client-id-1',
    clientSecret: 'super-secret-value',
    issuerUrl: 'https://acme.okta.com',
    defaultRole: 'member',
    autoProvision: true,
    allowedDomains: [],
    allowedOrgs: [],
    requireVerifiedEmail: true,
    isActive: true,
    ...overrides,
  };
}

describe('ssoConfigService provider CRUD', () => {
  test('createProvider never returns the raw secret, and computes callbackUrl', async () => {
    if (skip) return;
    const provider = await ssoConfigService.createProvider(org.id, draft());
    expect(provider.id).toBeDefined();
    expect(provider.clientSecret).toBeUndefined();
    expect(provider.hasClientSecret).toBe(true);
    expect(provider.callbackUrl).toContain(`/api/auth/sso/callback/${provider.id}`);
    expect(provider.provider).toBe('oidc');
    expect(provider.source).toBe('db');
  });

  test('GitHub preset derives provider="github" and default scopes with read:org when allowedOrgs set', async () => {
    if (skip) return;
    const provider = await ssoConfigService.createProvider(
      org.id,
      draft({ name: 'GitHub', presetId: 'github', issuerUrl: undefined, allowedOrgs: ['acme-corp'] })
    );
    expect(provider.provider).toBe('github');
    expect(provider.scopes).toContain('read:org');
  });

  test('updateProvider with a blank clientSecret keeps the stored one', async () => {
    if (skip) return;
    const created = await ssoConfigService.createProvider(org.id, draft({ name: 'Keeps Secret' }));
    const updated = await ssoConfigService.updateProvider(org.id, created.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.hasClientSecret).toBe(true);
  });

  test('listProviders returns providers ordered by displayOrder', async () => {
    if (skip) return;
    const localOrg = await createTestOrg();
    const p1 = await ssoConfigService.createProvider(localOrg.id, draft({ name: 'First' }));
    const p2 = await ssoConfigService.createProvider(localOrg.id, draft({ name: 'Second' }));
    const list = await ssoConfigService.listProviders(localOrg.id);
    const names = list.filter((p) => p.source === 'db').map((p) => p.name);
    expect(names.indexOf('First')).toBeLessThan(names.indexOf('Second'));

    const reordered = await ssoConfigService.reorderProviders(localOrg.id, [p2.id, p1.id]);
    const reorderedNames = reordered.filter((p) => p.source === 'db').map((p) => p.name);
    expect(reorderedNames[0]).toBe('Second');

    await cleanupOrg(localOrg.id);
  });

  test('deleteProvider refuses (LAST_SIGN_IN_METHOD) when a linked user has no password and no other identity', async () => {
    if (skip) return;
    const provider = await ssoConfigService.createProvider(org.id, draft({ name: 'Sole Login' }));
    const user = await createTestUser(org.id, { passwordHash: null });
    await prisma.userIdentity.create({
      data: {
        orgId: org.id,
        userId: user.id,
        ssoConfigId: provider.id,
        provider: 'oidc',
        subject: `sub-${Date.now()}`,
      },
    });

    await expect(ssoConfigService.deleteProvider(org.id, provider.id)).rejects.toMatchObject({
      code: 'LAST_SIGN_IN_METHOD',
    });

    // force=true bypasses the guard
    await expect(ssoConfigService.deleteProvider(org.id, provider.id, { force: true })).resolves.toEqual({
      deleted: true,
    });
  });

  test('deleteProvider succeeds when the linked user also has a password', async () => {
    if (skip) return;
    const provider = await ssoConfigService.createProvider(org.id, draft({ name: 'Has Password' }));
    const user = await createTestUser(org.id); // has a passwordHash
    await prisma.userIdentity.create({
      data: {
        orgId: org.id,
        userId: user.id,
        ssoConfigId: provider.id,
        provider: 'oidc',
        subject: `sub-${Date.now()}`,
      },
    });

    await expect(ssoConfigService.deleteProvider(org.id, provider.id)).resolves.toEqual({ deleted: true });
  });
});
