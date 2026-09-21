/**
 * Saved sudo password per server (serverSudoService) — live DB.
 *
 * A certificate install as a non-root user has no password of its own for
 * sudo, so every reinstall stopped and asked. The password can now be kept
 * in the org Keystore and bound to the server; these pin who may save it,
 * who may use it, and that forgetting it cleans up only what it created.
 */

import prisma from '../../config/db.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';
import { saveSudoPassword, forgetSudoPassword, resolveSavedSudo, SUDO_TAG } from '../serverSudoService.js';

const ALL = new Set(['servers.manage_credentials', 'keystore.manage', 'keystore.view']);

describe('serverSudoService (live DB)', () => {
  let org;
  let customer;
  let user;
  let server;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({ data: { orgId: org.id, name: 'Sudo Co', slug: `sudo-${Date.now()}` } });
    user = await prisma.user.create({
      data: { orgId: org.id, email: `sudo-${Date.now()}@example.test`, name: 'Sudo Tester', role: 'admin' },
    });
    server = await prisma.server.create({
      data: { orgId: org.id, customerId: customer.id, hostname: 'app-1.internal', displayName: 'App 1', ipAddress: '10.1.1.1', sshUser: 'ubuntu', provisionStatus: 'provisioned' },
    });
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.credential.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
    await prisma.$disconnect().catch(() => {});
  });

  const actor = (perms = ALL) => ({ userId: user.id, permissions: perms });

  test('refuses to save without both permissions', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await expect(
      saveSudoPassword(org.id, server.id, { password: 'pw' }, actor(new Set(['servers.manage_credentials'])))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test('saves into the org Keystore, bound to the server, for its SSH user', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const res = await saveSudoPassword(org.id, server.id, { password: 's3cret' }, actor());
    expect(res.created).toBe(true);
    const cred = await prisma.credential.findUnique({ where: { id: res.credentialId } });
    expect(cred).toMatchObject({ ownerId: null, username: 'ubuntu', authType: 'password', name: 'sudo — App 1' });
    expect(cred.tags).toContain(SUDO_TAG);
    expect(cred.passwordEncrypted).not.toContain('s3cret');
    const row = await prisma.server.findUnique({ where: { id: server.id } });
    expect(row.sudoCredentialId).toBe(res.credentialId);
    // Binding a sudo password must never change how the host is logged into.
    expect(row.credentialId).toBeNull();
    expect(row.authMode).toBe('certificate');
  });

  test('saving again replaces the password in place', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const before = await prisma.server.findUnique({ where: { id: server.id } });
    const res = await saveSudoPassword(org.id, server.id, { password: 'n3w' }, actor());
    expect(res.created).toBe(false);
    expect(res.credentialId).toBe(before.sudoCredentialId);
    const got = await resolveSavedSudo(org.id, actor(), before.sudoCredentialId, 'ubuntu');
    expect(got.password).toBe('n3w');
  });

  test('is only used for the user it was saved for, and only by someone who may use stored identities', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { sudoCredentialId } = await prisma.server.findUnique({ where: { id: server.id } });
    const wrongUser = await resolveSavedSudo(org.id, actor(), sudoCredentialId, 'deploy');
    expect(wrongUser.password).toBeUndefined();
    expect(wrongUser.note).toMatch(/for "ubuntu", but this install connects as "deploy"/);

    const noView = await resolveSavedSudo(org.id, actor(new Set(['servers.onboard'])), sudoCredentialId, 'ubuntu');
    expect(noView.password).toBeUndefined();
    expect(noView.note).toMatch(/cannot use stored identities/);
  });

  test('forgetting unbinds and deletes the identity it created', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { sudoCredentialId } = await prisma.server.findUnique({ where: { id: server.id } });
    const res = await forgetSudoPassword(org.id, server.id, actor());
    expect(res).toEqual({ removed: true, deletedIdentity: true });
    expect(await prisma.credential.findUnique({ where: { id: sudoCredentialId } })).toBeNull();
    expect((await prisma.server.findUnique({ where: { id: server.id } })).sudoCredentialId).toBeNull();
  });
});
