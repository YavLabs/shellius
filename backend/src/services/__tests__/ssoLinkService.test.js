/**
 * ssoLinkService — SSO account linking hardening (docs/auth-hardening.md
 * "Linking SSO accounts", "Require single sign-on"):
 *
 *   - confirm-link: success, wrong password (lockout counter), expired and
 *     reused tokens, MFA step verified once (no double prompt)
 *   - email approval for privileged SSO-only accounts
 *   - Profile connect links to the session user only
 *   - admin list/unlink with the no-escalation rule, last-method protection
 *   - ssoRequired blocks password login, exempts settings.sso holders
 *   - set-password needs a recent-auth proof
 *
 * Live-DB + Redis tests (dbReachable() skip pattern — see testDbHelper.js).
 * No SMTP is configured here, so every sendMail call reports "not delivered".
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import prisma from '../../config/db.js';
import redis from '../../config/redis.js';
import { encrypt } from '../../utils/crypto.js';
import * as ssoService from '../ssoService.js';
import * as ssoLinkService from '../ssoLinkService.js';
import * as authService from '../authService.js';
import * as orgService from '../orgService.js';
import { defaultPermissionsFor } from '../../config/permissions.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

const SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE'];
const savedEnv = {};

let org;
let reachable = false;
let seq = 0;
const uniq = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

async function createProvider(overrides = {}) {
  return prisma.ssoConfig.create({
    data: {
      orgId: org.id,
      provider: overrides.provider || 'oidc',
      name: overrides.name || 'Google',
      presetId: overrides.presetId || 'google',
      clientId: 'dummy-client-id',
      issuerUrl: 'https://idp.example.com',
      redirectUri: 'https://shellius.example.com/api/auth/sso/callback/x',
      allowedDomains: overrides.allowedDomains || [],
      requireVerifiedEmail: true,
      autoProvision: true,
      defaultRole: 'member',
      allowedOrgs: [],
      isActive: overrides.isActive !== false,
    },
  });
}

/** SSO sign-in by email that must be confirmed → a stored pending link. */
async function pendingFor(user, cfg) {
  const result = await ssoService.reconcileSsoUser({
    orgId: org.id,
    cfg,
    subject: uniq('sub'),
    email: user.email,
    emailVerified: true,
    name: 'IdP Name',
  });
  expect(result.pendingLink).toBeDefined();
  return result.pendingLink;
}

function actorFor(user, tier = user.role) {
  return { userId: user.id, roleId: null, tier, permissions: new Set(defaultPermissionsFor(tier)) };
}

beforeAll(async () => {
  for (const k of SMTP_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  reachable = await dbReachable();
  if (!reachable) {
    console.warn('[skip] ssoLinkService: no live DB');
    return;
  }
  org = await createTestOrg();
});

afterAll(async () => {
  for (const k of SMTP_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (org) await cleanupOrg(org.id);
  await prisma.$disconnect().catch(() => {});
  redis.disconnect();
});

const maybeTest = (name, fn) =>
  test(name, async () => {
    if (!reachable) return;
    await fn();
  });

// ---------------------------------------------------------------------------
// Confirm with password
// ---------------------------------------------------------------------------

describe('confirm-link (password accounts)', () => {
  maybeTest('correct password links the identity, audits it and signs the user in', async () => {
    const cfg = await createProvider();
    const user = await createTestUser(org.id, { role: 'member' });
    const pending = await pendingFor(user, cfg);
    const { mode, token } = await ssoLinkService.createPendingLink(pending, { ipAddress: '127.0.0.1' });
    expect(mode).toBe('password');

    const info = await ssoLinkService.describePendingLink(token, 'password');
    expect(info).toMatchObject({ providerName: 'Google', identityEmail: user.email, mfaRequired: false });

    const session = await ssoLinkService.confirmPendingLink({ token, password: user._plainPassword, ipAddress: '127.0.0.1' });
    expect(session.accessToken).toEqual(expect.any(String));
    expect(session.user.id).toBe(user.id);

    const identity = await prisma.userIdentity.findFirst({ where: { userId: user.id, ssoConfigId: cfg.id } });
    expect(identity.subject).toBe(pending.subject);
    const audit = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'auth.identity.linked', resourceId: user.id },
    });
    expect(audit.metadata).toMatchObject({ method: 'confirmed', provider: 'Google' });
  });

  maybeTest('wrong password is refused generically, counts toward lockout, and the token survives for a retry', async () => {
    const cfg = await createProvider();
    const user = await createTestUser(org.id, { role: 'super_admin' });
    const { token } = await ssoLinkService.createPendingLink(await pendingFor(user, cfg));

    await expect(
      ssoLinkService.confirmPendingLink({ token, password: 'not-the-password-1' })
    ).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(1);
    expect(await prisma.userIdentity.count({ where: { userId: user.id } })).toBe(0);

    const session = await ssoLinkService.confirmPendingLink({ token, password: user._plainPassword });
    expect(session.accessToken).toBeDefined();
    const reset = await prisma.user.findUnique({ where: { id: user.id } });
    expect(reset.failedLoginCount).toBe(0);
  });

  maybeTest('the token is burned after 5 attempts', async () => {
    const cfg = await createProvider();
    const user = await createTestUser(org.id);
    const { token } = await ssoLinkService.createPendingLink(await pendingFor(user, cfg));
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: null, failedLoginCount: 0 } });
      // eslint-disable-next-line no-await-in-loop
      await expect(ssoLinkService.confirmPendingLink({ token, password: `wrong-${i}` })).rejects.toMatchObject({ statusCode: 401 });
    }
    await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: null, failedLoginCount: 0 } });
    await expect(ssoLinkService.confirmPendingLink({ token, password: user._plainPassword })).rejects.toMatchObject({
      statusCode: 429,
      code: 'LINK_TOO_MANY_ATTEMPTS',
    });
    await expect(ssoLinkService.confirmPendingLink({ token, password: user._plainPassword })).rejects.toMatchObject({
      code: 'LINK_EXPIRED',
    });
  });

  maybeTest('an unknown / expired token is refused', async () => {
    const token = crypto.randomBytes(32).toString('hex');
    await expect(ssoLinkService.confirmPendingLink({ token, password: 'whatever-123' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LINK_EXPIRED',
    });
    await expect(ssoLinkService.describePendingLink(token, 'password')).rejects.toMatchObject({ code: 'LINK_EXPIRED' });
  });

  maybeTest('a token can be used only once', async () => {
    const cfg = await createProvider();
    const user = await createTestUser(org.id);
    const { token } = await ssoLinkService.createPendingLink(await pendingFor(user, cfg));
    await ssoLinkService.confirmPendingLink({ token, password: user._plainPassword });
    await expect(ssoLinkService.confirmPendingLink({ token, password: user._plainPassword })).rejects.toMatchObject({
      code: 'LINK_EXPIRED',
    });
  });

  maybeTest('cancel burns the token', async () => {
    const cfg = await createProvider();
    const user = await createTestUser(org.id);
    const { token } = await ssoLinkService.createPendingLink(await pendingFor(user, cfg));
    await ssoLinkService.cancelPendingLink(token);
    await expect(ssoLinkService.confirmPendingLink({ token, password: user._plainPassword })).rejects.toMatchObject({
      code: 'LINK_EXPIRED',
    });
  });

  maybeTest('an MFA account is asked for its code once (after the password) and then signed in — no second MFA prompt', async () => {
    const cfg = await createProvider();
    const secret = authenticator.generateSecret();
    const user = await createTestUser(org.id, {
      data: { mfaTotpEnabled: true, mfaTotpSecretEnc: encrypt(secret) },
    });
    const { token } = await ssoLinkService.createPendingLink(await pendingFor(user, cfg));

    // The MFA step can't be skipped by going straight to it.
    await expect(
      ssoLinkService.confirmPendingLink({ token, method: 'totp', code: authenticator.generate(secret) })
    ).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });

    const step1 = await ssoLinkService.confirmPendingLink({ token, password: user._plainPassword });
    expect(step1).toMatchObject({ linkMfaRequired: true, methods: ['totp'] });
    expect(step1.accessToken).toBeUndefined();
    expect(await prisma.userIdentity.count({ where: { userId: user.id } })).toBe(0);

    await expect(ssoLinkService.confirmPendingLink({ token, method: 'totp', code: '000000' })).rejects.toMatchObject({
      code: 'MFA_INVALID',
    });

    const step2 = await ssoLinkService.confirmPendingLink({ token, method: 'totp', code: authenticator.generate(secret) });
    expect(step2.accessToken).toBeDefined();
    expect(step2.mfaRequired).toBeUndefined();
    expect(await prisma.userIdentity.count({ where: { userId: user.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Email approval (privileged SSO-only accounts)
// ---------------------------------------------------------------------------

describe('email approval (privileged SSO-only accounts)', () => {
  maybeTest('no email can be delivered → no live token is left behind, nothing linked', async () => {
    const cfg = await createProvider();
    const admin = await createTestUser(org.id, { role: 'admin', passwordHash: null });
    const pending = await pendingFor(admin, cfg);
    expect(pending.mode).toBe('email_approval');
    const result = await ssoLinkService.createPendingLink(pending);
    expect(result).toEqual({ mode: 'email_approval', emailSent: false });
    expect(result.token).toBeUndefined();
    expect(await prisma.userIdentity.count({ where: { userId: admin.id } })).toBe(0);
  });

  maybeTest('the emailed approval links the identity (once) and does not sign anyone in', async () => {
    const cfg = await createProvider();
    const admin = await createTestUser(org.id, { role: 'admin', passwordHash: null });
    const pending = await pendingFor(admin, cfg);
    const { token } = await ssoLinkService.storePendingLink(pending);

    // An email-approval token is useless on the password confirm page.
    await expect(ssoLinkService.confirmPendingLink({ token, password: 'x-123456789012' })).rejects.toMatchObject({
      code: 'LINK_EXPIRED',
    });

    const info = await ssoLinkService.describePendingLink(token, 'email_approval');
    expect(info.mode).toBe('email_approval');
    const result = await ssoLinkService.approvePendingLink(token);
    expect(result).toEqual({ linked: true, providerName: 'Google' });
    expect(result.accessToken).toBeUndefined();
    expect(await prisma.userIdentity.count({ where: { userId: admin.id, ssoConfigId: cfg.id } })).toBe(1);
    const audit = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'auth.identity.linked', resourceId: admin.id },
    });
    expect(audit.metadata.method).toBe('email_approved');

    await expect(ssoLinkService.approvePendingLink(token)).rejects.toMatchObject({ code: 'LINK_EXPIRED' });
  });
});

// ---------------------------------------------------------------------------
// Profile connect
// ---------------------------------------------------------------------------

describe('connect from Profile', () => {
  maybeTest('links to the signed-in user only — never the account the IdP email matches', async () => {
    const cfg = await createProvider({ name: 'GitHub', presetId: 'github', provider: 'github' });
    const me = await createTestUser(org.id);
    const other = await createTestUser(org.id);
    await ssoLinkService.assertCanStartConnect({ orgId: org.id, userId: me.id, providerId: cfg.id });

    // The IdP account's email belongs to `other` — connect ignores it.
    const subject = uniq('gh');
    await ssoLinkService.completeConnect({ orgId: org.id, userId: me.id, cfg, subject, email: other.email });
    const identity = await prisma.userIdentity.findFirst({ where: { ssoConfigId: cfg.id, subject } });
    expect(identity.userId).toBe(me.id);
    expect(await prisma.userIdentity.count({ where: { userId: other.id } })).toBe(0);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: 'auth.identity.linked', resourceId: me.id } });
    expect(audit.metadata.method).toBe('connect');

    // A second connect to the same provider is refused up front…
    await expect(
      ssoLinkService.assertCanStartConnect({ orgId: org.id, userId: me.id, providerId: cfg.id })
    ).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_CONNECTED' });
    // …and at the callback.
    await expect(
      ssoLinkService.completeConnect({ orgId: org.id, userId: me.id, cfg, subject: uniq('gh2'), email: me.email })
    ).rejects.toMatchObject({ errorCode: 'already_connected' });
  });

  maybeTest('refuses an IdP account already linked to a different Shellius user', async () => {
    const cfg = await createProvider();
    const owner = await createTestUser(org.id);
    const me = await createTestUser(org.id);
    const subject = uniq('taken');
    await prisma.userIdentity.create({
      data: { orgId: org.id, userId: owner.id, ssoConfigId: cfg.id, provider: 'oidc', subject },
    });
    await expect(
      ssoLinkService.completeConnect({ orgId: org.id, userId: me.id, cfg, subject, email: me.email })
    ).rejects.toMatchObject({ errorCode: 'identity_in_use' });
    const identity = await prisma.userIdentity.findFirst({ where: { ssoConfigId: cfg.id, subject } });
    expect(identity.userId).toBe(owner.id);
  });

  maybeTest('refuses an inactive or foreign provider', async () => {
    const cfg = await createProvider({ isActive: false });
    const me = await createTestUser(org.id);
    await expect(
      ssoLinkService.assertCanStartConnect({ orgId: org.id, userId: me.id, providerId: cfg.id })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  maybeTest('applies the provider allowedDomains', async () => {
    const cfg = await createProvider({ allowedDomains: ['corp.example.com'] });
    const me = await createTestUser(org.id);
    await expect(
      ssoLinkService.completeConnect({ orgId: org.id, userId: me.id, cfg, subject: uniq('d'), email: 'me@gmail.com' })
    ).rejects.toMatchObject({ errorCode: 'domain_not_allowed' });
  });
});

// ---------------------------------------------------------------------------
// Unlink — self and admin
// ---------------------------------------------------------------------------

describe('unlink', () => {
  async function linkedUser(opts = {}) {
    const cfg = await createProvider();
    const user = await createTestUser(org.id, opts);
    const identity = await prisma.userIdentity.create({
      data: { orgId: org.id, userId: user.id, ssoConfigId: cfg.id, provider: 'oidc', subject: uniq('s'), email: user.email },
    });
    return { user, identity, cfg };
  }

  maybeTest('self-unlink is audited with the ACTIONS key and refuses to remove the last sign-in method', async () => {
    const { user, identity } = await linkedUser({ passwordHash: null });
    await expect(
      ssoLinkService.unlinkOwnIdentity({ orgId: org.id, userId: user.id, identityId: identity.id })
    ).rejects.toMatchObject({ statusCode: 409, code: 'LAST_SIGN_IN_METHOD' });

    const withPw = await linkedUser();
    await ssoLinkService.unlinkOwnIdentity({ orgId: org.id, userId: withPw.user.id, identityId: withPw.identity.id });
    const audit = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'auth.identity.unlinked', resourceId: withPw.user.id },
    });
    expect(audit.metadata).toMatchObject({ method: 'self', provider: 'Google' });
  });

  maybeTest('admin can list and unlink a member’s identities; audited as method admin', async () => {
    const admin = await createTestUser(org.id, { role: 'admin' });
    const { user, identity } = await linkedUser();
    const actor = actorFor(admin);

    const listed = await ssoLinkService.listIdentitiesForAdmin({ orgId: org.id, actor, userId: user.id });
    expect(listed.hasPassword).toBe(true);
    expect(listed.identities.map((i) => i.id)).toEqual([identity.id]);

    await ssoLinkService.adminUnlinkIdentity({ orgId: org.id, actor, userId: user.id, identityId: identity.id });
    expect(await prisma.userIdentity.count({ where: { id: identity.id } })).toBe(0);
    const audit = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'auth.identity.unlinked', resourceId: user.id, actorId: admin.id },
    });
    expect(audit.metadata.method).toBe('admin');
  });

  maybeTest('admin cannot view or unlink a super admin’s identities (no escalation)', async () => {
    const admin = await createTestUser(org.id, { role: 'admin' });
    const { user, identity } = await linkedUser({ role: 'super_admin' });
    const actor = actorFor(admin);
    await expect(ssoLinkService.listIdentitiesForAdmin({ orgId: org.id, actor, userId: user.id })).rejects.toMatchObject({
      statusCode: 403,
      code: 'ROLE_ESCALATION',
    });
    await expect(
      ssoLinkService.adminUnlinkIdentity({ orgId: org.id, actor, userId: user.id, identityId: identity.id })
    ).rejects.toMatchObject({ statusCode: 403, code: 'ROLE_ESCALATION' });
    expect(await prisma.userIdentity.count({ where: { id: identity.id } })).toBe(1);
  });

  maybeTest('admin unlink keeps the last-sign-in-method rule', async () => {
    const admin = await createTestUser(org.id, { role: 'admin' });
    const { user, identity } = await linkedUser({ passwordHash: null });
    await expect(
      ssoLinkService.adminUnlinkIdentity({ orgId: org.id, actor: actorFor(admin), userId: user.id, identityId: identity.id })
    ).rejects.toMatchObject({ statusCode: 409, code: 'LAST_SIGN_IN_METHOD' });
  });

  maybeTest('another org’s user is not found', async () => {
    const otherOrg = await createTestOrg();
    try {
      const foreign = await createTestUser(otherOrg.id);
      const admin = await createTestUser(org.id, { role: 'admin' });
      await expect(
        ssoLinkService.listIdentitiesForAdmin({ orgId: org.id, actor: actorFor(admin), userId: foreign.id })
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await cleanupOrg(otherOrg.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Require single sign-on
// ---------------------------------------------------------------------------

describe('ssoRequired', () => {
  let ssoOrg;

  beforeAll(async () => {
    if (!reachable) return;
    ssoOrg = await createTestOrg();
  });
  afterAll(async () => {
    if (ssoOrg) await cleanupOrg(ssoOrg.id);
  });

  maybeTest('cannot be turned on without an active provider', async () => {
    await expect(orgService.updateAccessSettings(ssoOrg.id, { ssoRequired: true })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SSO_NOT_CONFIGURED',
    });
  });

  maybeTest('blocks password login, reset and set for users without settings.sso; exempts holders', async () => {
    await prisma.ssoConfig.create({
      data: {
        orgId: ssoOrg.id,
        provider: 'oidc',
        name: 'Okta',
        clientId: 'c',
        issuerUrl: 'https://idp.example.com',
        redirectUri: 'https://x.example.com/cb',
        isActive: true,
      },
    });
    const settings = await orgService.updateAccessSettings(ssoOrg.id, { ssoRequired: true });
    expect(settings.ssoRequired).toBe(true);

    const member = await createTestUser(ssoOrg.id, { role: 'member', email: `${uniq('m')}@example.com` });
    const owner = await createTestUser(ssoOrg.id, { role: 'super_admin', email: `${uniq('o')}@example.com` });

    const blocked = await authService.login(member.email, member._plainPassword, '127.0.0.1', 'jest').catch((e) => e);
    expect(blocked).toMatchObject({ statusCode: 401, code: 'SSO_REQUIRED' });
    // Wrong password gives the same answer — the password is never checked.
    await expect(authService.login(member.email, 'wrong-password-1', '127.0.0.1', 'jest')).rejects.toMatchObject({
      code: 'SSO_REQUIRED',
    });
    expect(await orgService.passwordSignInBlocked(member)).toBe(true);

    // An exempt admin with a WRONG password gets exactly the same answer as a
    // blocked account, so failures never reveal who is exempt.
    const exemptWrong = await authService.login(owner.email, 'wrong-password-1', '127.0.0.1', 'jest').catch((e) => e);
    expect(exemptWrong).toMatchObject({ statusCode: 401, code: 'SSO_REQUIRED' });
    expect(exemptWrong.message).toBe(blocked.message);
    await prisma.user.update({ where: { id: owner.id }, data: { failedLoginCount: 0, lockedUntil: null } });

    const session = await authService.login(owner.email, owner._plainPassword, '127.0.0.1', 'jest');
    expect(session.accessToken).toBeDefined();
    expect(await orgService.passwordSignInBlocked(owner)).toBe(false);

    // The email-first step answers identically for blocked, exempt and
    // unknown addresses — it can't be used to find the exempt admins.
    const memberState = await authService.getLoginState(member.email, ssoOrg.id);
    const ownerState = await authService.getLoginState(owner.email, ssoOrg.id);
    const unknownState = await authService.getLoginState(`${uniq('nobody')}@example.com`, ssoOrg.id);
    expect(memberState).toEqual({ hasPassword: false, ssoLinked: false, ssoRequired: true });
    expect(ownerState).toEqual(memberState);
    expect(unknownState).toEqual(memberState);

    // Set-password is refused too.
    const ssoOnly = await createTestUser(ssoOrg.id, { passwordHash: null });
    await expect(
      ssoLinkService.setInitialPassword({ orgId: ssoOrg.id, userId: ssoOnly.id, newPassword: 'abcdefghijk12', method: 'email', code: '123456' })
    ).rejects.toMatchObject({ statusCode: 403, code: 'SSO_REQUIRED' });
  });

  maybeTest('a password that can’t be used does not count as a sign-in method when unlinking', async () => {
    const member = await createTestUser(ssoOrg.id, { role: 'member' });
    const cfg = await prisma.ssoConfig.findFirst({ where: { orgId: ssoOrg.id } });
    const identity = await prisma.userIdentity.create({
      data: { orgId: ssoOrg.id, userId: member.id, ssoConfigId: cfg.id, provider: 'oidc', subject: uniq('s') },
    });
    await expect(
      ssoLinkService.unlinkOwnIdentity({ orgId: ssoOrg.id, userId: member.id, identityId: identity.id })
    ).rejects.toMatchObject({ code: 'LAST_SIGN_IN_METHOD' });
  });
});

// ---------------------------------------------------------------------------
// Set a password
// ---------------------------------------------------------------------------

describe('set a password (SSO-only accounts)', () => {
  async function plantEmailCode(user, code) {
    await prisma.userToken.create({
      data: {
        userId: user.id,
        type: 'mfa_email_otp',
        tokenHash: crypto.createHash('sha256').update(`${user.id}:${code}`).digest('hex'),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });
  }

  maybeTest('sending the email code reports EMAIL_NOT_DELIVERED when mail can’t be sent', async () => {
    const user = await createTestUser(org.id, { passwordHash: null });
    await expect(ssoLinkService.sendSetPasswordCode({ orgId: org.id, userId: user.id })).rejects.toMatchObject({
      statusCode: 503,
      code: 'EMAIL_NOT_DELIVERED',
    });
  });

  maybeTest('requires a valid emailed code when no MFA is enrolled', async () => {
    const user = await createTestUser(org.id, { passwordHash: null });
    await expect(
      ssoLinkService.setInitialPassword({ orgId: org.id, userId: user.id, newPassword: 'abcdefghijk12', method: 'email', code: '111111' })
    ).rejects.toMatchObject({ statusCode: 401, code: 'MFA_INVALID' });
    // An authenticator code is not a proof when none is enrolled.
    await expect(
      ssoLinkService.setInitialPassword({ orgId: org.id, userId: user.id, newPassword: 'abcdefghijk12', method: 'totp', code: '111111' })
    ).rejects.toMatchObject({ code: 'MFA_INVALID' });

    await plantEmailCode(user, '424242');
    const result = await ssoLinkService.setInitialPassword({
      orgId: org.id,
      userId: user.id,
      newPassword: 'abcdefghijk12',
      method: 'email',
      code: '424242',
    });
    expect(result).toEqual({ passwordSet: true });
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare('abcdefghijk12', updated.passwordHash)).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: 'auth.password.set', resourceId: user.id } });
    expect(audit).toBeTruthy();

    await expect(
      ssoLinkService.setInitialPassword({ orgId: org.id, userId: user.id, newPassword: 'abcdefghijk13', method: 'email', code: '424242' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'PASSWORD_ALREADY_SET' });
  });

  maybeTest('requires the enrolled MFA factor when there is one', async () => {
    const secret = authenticator.generateSecret();
    const user = await createTestUser(org.id, {
      passwordHash: null,
      data: { mfaTotpEnabled: true, mfaTotpSecretEnc: encrypt(secret) },
    });
    await plantEmailCode(user, '525252');
    // Email codes aren't an enrolled factor for this user.
    await expect(
      ssoLinkService.setInitialPassword({ orgId: org.id, userId: user.id, newPassword: 'abcdefghijk12', method: 'email', code: '525252' })
    ).rejects.toMatchObject({ code: 'MFA_INVALID' });
    const result = await ssoLinkService.setInitialPassword({
      orgId: org.id,
      userId: user.id,
      newPassword: 'abcdefghijk12',
      method: 'totp',
      code: authenticator.generate(secret),
    });
    expect(result.passwordSet).toBe(true);
  });
});
