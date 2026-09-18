/**
 * ssoService.reconcileSsoUser — reconciliation rules from
 * docs/auth-hardening.md Revision 2: UserIdentity(ssoConfigId, subject)
 * first, then verified-email linking (per-provider identity_conflict), then
 * JIT provisioning. Also covers multi-provider linking (same email across
 * two providers resolves to the same user).
 *
 * Live-DB tests auto-skip (console.warn) when DATABASE_URL is unreachable.
 */

import prisma from '../../config/db.js';
import * as ssoService from '../ssoService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let org;
let skip = false;

async function createTestConfig(orgId, overrides = {}) {
  return prisma.ssoConfig.create({
    data: {
      orgId,
      provider: overrides.provider || 'oidc',
      presetId: overrides.presetId ?? null,
      name: overrides.name || 'Test Provider',
      clientId: 'dummy-client-id',
      issuerUrl: overrides.issuerUrl || 'https://idp.example.com',
      redirectUri: 'https://shellius.example.com/api/auth/sso/callback/placeholder',
      allowedDomains: overrides.allowedDomains || [],
      requireVerifiedEmail: overrides.requireVerifiedEmail !== false,
      autoProvision: overrides.autoProvision !== false,
      defaultRole: overrides.defaultRole || 'member',
      allowedOrgs: overrides.allowedOrgs || [],
    },
  });
}

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

describe('reconcileSsoUser', () => {
  test('JIT-provisions a new user when autoProvision is true and no match exists', async () => {
    if (skip) return;
    const cfg = await createTestConfig(org.id);
    const email = `jit-${Date.now()}@example.com`;
    const user = await ssoService.reconcileSsoUser({
      orgId: org.id,
      cfg,
      subject: `sub-${Date.now()}`,
      email,
      emailVerified: true,
      name: 'JIT User',
    });
    expect(user.email).toBe(email);
    expect(user.role).toBe('member');

    const identity = await prisma.userIdentity.findFirst({ where: { userId: user.id, ssoConfigId: cfg.id } });
    expect(identity).toBeTruthy();
    expect(identity.subject).toBeDefined();
  });

  test('throws provisioning_disabled when autoProvision is false and no match exists', async () => {
    if (skip) return;
    const cfg = await createTestConfig(org.id, { autoProvision: false });
    await expect(
      ssoService.reconcileSsoUser({
        orgId: org.id,
        cfg,
        subject: `sub-noprov-${Date.now()}`,
        email: `noprov-${Date.now()}@example.com`,
        emailVerified: true,
      })
    ).rejects.toMatchObject({ errorCode: 'provisioning_disabled' });
  });

  test('matches an existing user by (ssoConfigId, subject) first, even if email changed', async () => {
    if (skip) return;
    const cfg = await createTestConfig(org.id);
    const subject = `stable-sub-${Date.now()}`;
    const created = await ssoService.reconcileSsoUser({
      orgId: org.id,
      cfg,
      subject,
      email: `original-${Date.now()}@example.com`,
      emailVerified: true,
    });

    const newEmail = `changed-${Date.now()}@example.com`;
    const again = await ssoService.reconcileSsoUser({
      orgId: org.id,
      cfg,
      subject,
      email: newEmail,
      emailVerified: true,
    });

    expect(again.id).toBe(created.id); // matched by subject, not email
  });

  test('links an existing local account by email ONLY when email_verified is asserted', async () => {
    if (skip) return;
    const cfg = await createTestConfig(org.id); // requireVerifiedEmail: true
    const existing = await createTestUser(org.id, { status: 'invited' });
    await expect(
      ssoService.reconcileSsoUser({
        orgId: org.id,
        cfg,
        subject: `unverified-sub-${Date.now()}`,
        email: existing.email,
        emailVerified: false,
      })
    ).rejects.toMatchObject({ errorCode: 'email_not_verified' });
  });

  test('links an existing local account by email when email_verified is true', async () => {
    if (skip) return;
    const cfg = await createTestConfig(org.id);
    const existing = await createTestUser(org.id, { status: 'invited' });
    const linked = await ssoService.reconcileSsoUser({
      orgId: org.id,
      cfg,
      subject: `verified-sub-${Date.now()}`,
      email: existing.email,
      emailVerified: true,
    });
    expect(linked.id).toBe(existing.id);
    expect(linked.status).toBe('active');
  });

  test('refuses to link when the SAME provider already has a different-subject identity for that user (identity_conflict)', async () => {
    if (skip) return;
    const cfg = await createTestConfig(org.id);
    const email = `conflict-${Date.now()}@example.com`;
    const firstSub = `first-sub-${Date.now()}`;
    await ssoService.reconcileSsoUser({
      orgId: org.id,
      cfg,
      subject: firstSub,
      email,
      emailVerified: true,
    });

    await expect(
      ssoService.reconcileSsoUser({
        orgId: org.id,
        cfg,
        subject: `second-sub-${Date.now()}`,
        email,
        emailVerified: true,
      })
    ).rejects.toMatchObject({ errorCode: 'identity_conflict' });
  });

  test('the SAME email across TWO DIFFERENT providers links to the SAME user', async () => {
    if (skip) return;
    const cfgA = await createTestConfig(org.id, { name: 'Provider A' });
    const cfgB = await createTestConfig(org.id, { name: 'Provider B', provider: 'github' });
    const email = `multi-provider-${Date.now()}@example.com`;

    const userA = await ssoService.reconcileSsoUser({
      orgId: org.id,
      cfg: cfgA,
      subject: `a-sub-${Date.now()}`,
      email,
      emailVerified: true,
    });

    const userB = await ssoService.reconcileSsoUser({
      orgId: org.id,
      cfg: cfgB,
      subject: `b-sub-${Date.now()}`,
      email,
      emailVerified: true,
    });

    expect(userB.id).toBe(userA.id);

    const identities = await prisma.userIdentity.findMany({ where: { userId: userA.id } });
    expect(identities.length).toBe(2);
  });

  test('rejects sign-in when allowedDomains is set and the email domain does not match', async () => {
    if (skip) return;
    const cfg = await createTestConfig(org.id, { allowedDomains: ['allowed.example.com'] });
    await expect(
      ssoService.reconcileSsoUser({
        orgId: org.id,
        cfg,
        subject: `domain-sub-${Date.now()}`,
        email: `user@not-allowed.example.com`,
        emailVerified: true,
      })
    ).rejects.toMatchObject({ errorCode: 'domain_not_allowed' });
  });

  test('allows sign-in when the email domain is in allowedDomains', async () => {
    if (skip) return;
    const cfg = await createTestConfig(org.id, { allowedDomains: ['allowed.example.com'] });
    const user = await ssoService.reconcileSsoUser({
      orgId: org.id,
      cfg,
      subject: `domain-ok-sub-${Date.now()}`,
      email: `user-${Date.now()}@allowed.example.com`,
      emailVerified: true,
    });
    expect(user.email.endsWith('@allowed.example.com')).toBe(true);
  });

  test('a JIT-provisioned user can never be defaultRole=super_admin', async () => {
    if (skip) return;
    const cfg = await createTestConfig(org.id, { defaultRole: 'super_admin' });
    const user = await ssoService.reconcileSsoUser({
      orgId: org.id,
      cfg,
      subject: `super-sub-${Date.now()}`,
      email: `wouldbe-super-${Date.now()}@example.com`,
      emailVerified: true,
    });
    expect(user.role).not.toBe('super_admin');
  });

  test('rejects sign-in for a disabled (suspended) matched account', async () => {
    if (skip) return;
    const cfg = await createTestConfig(org.id);
    const existing = await createTestUser(org.id, { status: 'suspended' });
    await expect(
      ssoService.reconcileSsoUser({
        orgId: org.id,
        cfg,
        subject: `suspended-sub-${Date.now()}`,
        email: existing.email,
        emailVerified: true,
      })
    ).rejects.toMatchObject({ errorCode: 'account_disabled' });
  });
});
