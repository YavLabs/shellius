/**
 * ssoService.reconcileOidcUser — reconciliation rules from
 * docs/auth-hardening.md: sub-first match, verified-email linking, domain
 * restriction, defaultRole never super_admin, provisioning-disabled.
 *
 * Live-DB tests auto-skip (console.warn) when DATABASE_URL is unreachable.
 */

import prisma from '../../config/db.js';
import * as ssoService from '../ssoService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let org;
let skip = false;

const baseCfg = {
  allowedDomains: [],
  requireVerifiedEmail: true,
  autoProvision: true,
  defaultRole: 'member',
  defaultGroupId: null,
};

beforeAll(async () => {
  skip = !(await dbReachable());
  if (skip) {
    console.warn('[skip] ssoService reconcile tests — DATABASE_URL unreachable');
    return;
  }
  org = await createTestOrg();
});

afterAll(async () => {
  if (org) await cleanupOrg(org.id);
  await prisma.$disconnect().catch(() => {});
});

describe('reconcileOidcUser', () => {
  test('JIT-provisions a new user when autoProvision is true and no match exists', async () => {
    if (skip) return;
    const email = `jit-${Date.now()}@example.com`;
    const user = await ssoService.reconcileOidcUser({
      orgId: org.id,
      cfg: baseCfg,
      idClaims: { sub: `sub-${Date.now()}`, email_verified: true },
      userinfo: { email, name: 'JIT User', email_verified: true },
    });
    expect(user.email).toBe(email);
    expect(user.role).toBe('member');
    expect(user.ssoSub).toBeDefined();
  });

  test('throws provisioning_disabled when autoProvision is false and no match exists', async () => {
    if (skip) return;
    await expect(
      ssoService.reconcileOidcUser({
        orgId: org.id,
        cfg: { ...baseCfg, autoProvision: false },
        idClaims: { sub: `sub-noprov-${Date.now()}`, email_verified: true },
        userinfo: { email: `noprov-${Date.now()}@example.com`, email_verified: true },
      })
    ).rejects.toMatchObject({ errorCode: 'provisioning_disabled' });
  });

  test('matches an existing user by (orgId, provider, sub) first, even if email changed', async () => {
    if (skip) return;
    const sub = `stable-sub-${Date.now()}`;
    const created = await ssoService.reconcileOidcUser({
      orgId: org.id,
      cfg: baseCfg,
      idClaims: { sub, email_verified: true },
      userinfo: { email: `original-${Date.now()}@example.com`, email_verified: true },
    });

    const newEmail = `changed-${Date.now()}@example.com`;
    const again = await ssoService.reconcileOidcUser({
      orgId: org.id,
      cfg: baseCfg,
      idClaims: { sub, email_verified: true },
      userinfo: { email: newEmail, email_verified: true },
    });

    expect(again.id).toBe(created.id); // matched by sub, not email
  });

  test('links an existing local account by email ONLY when email_verified is asserted', async () => {
    if (skip) return;
    const existing = await createTestUser(org.id, { status: 'invited' });
    await expect(
      ssoService.reconcileOidcUser({
        orgId: org.id,
        cfg: baseCfg, // requireVerifiedEmail: true
        idClaims: { sub: `unverified-sub-${Date.now()}` },
        userinfo: { email: existing.email, email_verified: false },
      })
    ).rejects.toMatchObject({ errorCode: 'email_not_verified' });
  });

  test('links an existing local account by email when email_verified is true', async () => {
    if (skip) return;
    const existing = await createTestUser(org.id, { status: 'invited' });
    const linked = await ssoService.reconcileOidcUser({
      orgId: org.id,
      cfg: baseCfg,
      idClaims: { sub: `verified-sub-${Date.now()}`, email_verified: true },
      userinfo: { email: existing.email, email_verified: true },
    });
    expect(linked.id).toBe(existing.id);
    expect(linked.status).toBe('active');
  });

  test('refuses to link when the email already belongs to a DIFFERENT ssoSub (identity_conflict)', async () => {
    if (skip) return;
    const email = `conflict-${Date.now()}@example.com`;
    const firstSub = `first-sub-${Date.now()}`;
    await ssoService.reconcileOidcUser({
      orgId: org.id,
      cfg: baseCfg,
      idClaims: { sub: firstSub, email_verified: true },
      userinfo: { email, email_verified: true },
    });

    await expect(
      ssoService.reconcileOidcUser({
        orgId: org.id,
        cfg: baseCfg,
        idClaims: { sub: `second-sub-${Date.now()}`, email_verified: true },
        userinfo: { email, email_verified: true },
      })
    ).rejects.toMatchObject({ errorCode: 'identity_conflict' });
  });

  test('rejects sign-in when allowedDomains is set and the email domain does not match', async () => {
    if (skip) return;
    await expect(
      ssoService.reconcileOidcUser({
        orgId: org.id,
        cfg: { ...baseCfg, allowedDomains: ['allowed.example.com'] },
        idClaims: { sub: `domain-sub-${Date.now()}`, email_verified: true },
        userinfo: { email: `user@not-allowed.example.com`, email_verified: true },
      })
    ).rejects.toMatchObject({ errorCode: 'domain_not_allowed' });
  });

  test('allows sign-in when the email domain is in allowedDomains', async () => {
    if (skip) return;
    const user = await ssoService.reconcileOidcUser({
      orgId: org.id,
      cfg: { ...baseCfg, allowedDomains: ['allowed.example.com'] },
      idClaims: { sub: `domain-ok-sub-${Date.now()}`, email_verified: true },
      userinfo: { email: `user-${Date.now()}@allowed.example.com`, email_verified: true },
    });
    expect(user.email.endsWith('@allowed.example.com')).toBe(true);
  });

  test('a JIT-provisioned user can never be defaultRole=super_admin', async () => {
    if (skip) return;
    const user = await ssoService.reconcileOidcUser({
      orgId: org.id,
      cfg: { ...baseCfg, defaultRole: 'super_admin' },
      idClaims: { sub: `super-sub-${Date.now()}`, email_verified: true },
      userinfo: { email: `wouldbe-super-${Date.now()}@example.com`, email_verified: true },
    });
    expect(user.role).not.toBe('super_admin');
  });

  test('rejects sign-in for a disabled (suspended) matched account', async () => {
    if (skip) return;
    const existing = await createTestUser(org.id, { status: 'suspended' });
    await expect(
      ssoService.reconcileOidcUser({
        orgId: org.id,
        cfg: baseCfg,
        idClaims: { sub: `suspended-sub-${Date.now()}`, email_verified: true },
        userinfo: { email: existing.email, email_verified: true },
      })
    ).rejects.toMatchObject({ errorCode: 'account_disabled' });
  });
});
