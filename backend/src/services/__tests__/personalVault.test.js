/**
 * Personal vault + My hosts (docs/personal-vault.md): isolation between
 * users and between personal/org scope, the "no mixing" rules, the prod
 * guard on personal hosts, move-to-org and offboarding.
 *
 * Live-DB tests (dbReachable() skip pattern — see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import * as keystoreService from '../keystoreService.js';
import * as vaultService from '../vaultService.js';
import * as quickConnectService from '../quickConnectService.js';
import * as keyDeploymentService from '../keyDeploymentService.js';
import { createServer } from '../serverService.js';
import { deleteUser } from '../userService.js';
import { updateAccessSettings } from '../orgService.js';
import { PERMISSION_KEYS, defaultPermissionsFor } from '../../config/permissions.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

const memberPerms = () => new Set(defaultPermissionsFor('member'));

describe('personal vault', () => {
  let reachable;
  let org;
  let alice; // member
  let bob; // member
  let admin; // super admin
  let customer;
  let actorA;
  let actorB;
  let actorAdmin;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] personalVault: no live DB');
      return;
    }
    org = await createTestOrg();
    alice = await createTestUser(org.id, { role: 'member' });
    bob = await createTestUser(org.id, { role: 'member' });
    admin = await createTestUser(org.id, { role: 'super_admin' });
    customer = await prisma.customer.create({ data: { orgId: org.id, name: 'Acme', slug: `acme-${Date.now()}` } });
    actorA = { id: alice.id, role: 'member', permissions: memberPerms() };
    actorB = { id: bob.id, role: 'member', permissions: memberPerms() };
    actorAdmin = { id: admin.id, role: 'super_admin', permissions: new Set(PERMISSION_KEYS) };
  });

  afterAll(async () => {
    if (!reachable) return;
    await prisma.personalHost.deleteMany({ where: { orgId: org.id } });
    await prisma.keyDeployment.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.credential.deleteMany({ where: { orgId: org.id } });
    await prisma.sshKey.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const dbTest = (name, fn) =>
    test(name, async () => {
      if (!reachable) return;
      await fn();
    });

  const personal = (user) => ({ ownerId: user.id });

  dbTest('members get vault.use and vault.hosts by default', () => {
    expect(memberPerms().has('vault.use')).toBe(true);
    expect(memberPerms().has('vault.hosts')).toBe(true);
  });

  dbTest('personal items are invisible to other users and to the org Keystore', async () => {
    const { credential } = await keystoreService.createCredential(
      org.id,
      { name: 'home', username: 'alice', authType: 'password', password: 'pw-1' },
      alice.id,
      personal(alice)
    );
    expect(credential.scope).toBe('personal');

    const own = await keystoreService.listCredentials(org.id, personal(alice));
    expect(own.credentials.map((c) => c.id)).toContain(credential.id);

    const bobs = await keystoreService.listCredentials(org.id, personal(bob));
    expect(bobs.credentials.map((c) => c.id)).not.toContain(credential.id);

    const orgList = await keystoreService.listCredentials(org.id); // org scope
    expect(orgList.credentials.map((c) => c.id)).not.toContain(credential.id);

    await expect(keystoreService.getCredential(org.id, credential.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(keystoreService.getCredential(org.id, credential.id, personal(bob))).rejects.toMatchObject({ statusCode: 404 });
    await expect(keystoreService.deleteCredential(org.id, credential.id, personal(bob), bob.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  dbTest('names are unique per scope: two users can both have "home"; org names stay unique', async () => {
    const { credential } = await keystoreService.createCredential(
      org.id,
      { name: 'home', username: 'bob', authType: 'password', password: 'pw-2' },
      bob.id,
      personal(bob)
    );
    expect(credential.name).toBe('home');
    await expect(
      keystoreService.createCredential(org.id, { name: 'home', username: 'x', authType: 'password', password: 'p' }, bob.id, personal(bob))
    ).rejects.toMatchObject({ statusCode: 409 });

    await keystoreService.createCredential(org.id, { name: 'shared', username: 'ops', authType: 'password', password: 'p' }, admin.id);
    await expect(
      keystoreService.createCredential(org.id, { name: 'shared', username: 'ops', authType: 'password', password: 'p' }, admin.id)
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  dbTest('a personal identity can only use the owner’s personal keys', async () => {
    const { key: orgKey } = await keystoreService.generateKey(org.id, { name: 'org-key', keyType: 'ed25519' }, admin.id);
    const { key: bobKey } = await keystoreService.generateKey(org.id, { name: 'bob-key', keyType: 'ed25519' }, bob.id, personal(bob));
    const { key: aliceKey } = await keystoreService.generateKey(org.id, { name: 'alice-key', keyType: 'ed25519' }, alice.id, personal(alice));

    const attempt = (sshKeyId) =>
      keystoreService.createCredential(
        org.id,
        { name: `k-${sshKeyId.slice(-5)}`, username: 'alice', authType: 'key', sshKeyId },
        alice.id,
        personal(alice)
      );
    await expect(attempt(orgKey.id)).rejects.toMatchObject({ statusCode: 400 });
    await expect(attempt(bobKey.id)).rejects.toMatchObject({ statusCode: 400 });
    await expect(attempt(aliceKey.id)).resolves.toBeTruthy();

    // …and an org identity can't use a personal key.
    await expect(
      keystoreService.createCredential(org.id, { name: 'org-with-personal', username: 'ops', authType: 'key', sshKeyId: aliceKey.id }, admin.id)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  dbTest('personal identities and keys can never reach org servers', async () => {
    const aliceCred = await prisma.credential.findFirst({ where: { orgId: org.id, ownerId: alice.id, name: 'home' } });
    await expect(
      createServer(org.id, customer.id, {
        hostname: 'dev-1',
        ipAddress: '203.0.113.20',
        environment: 'dev',
        authMode: 'credential',
        credentialId: aliceCred.id,
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    const server = await prisma.server.create({
      data: { orgId: org.id, customerId: customer.id, hostname: 'dev-2', ipAddress: '203.0.113.21', environment: 'dev' },
    });
    const aliceKey = await prisma.sshKey.findFirst({ where: { orgId: org.id, ownerId: alice.id } });
    await expect(
      keyDeploymentService.createBatch(org.id, { sshKeyId: aliceKey.id, serverIds: [server.id], action: 'deploy', auth: { mode: 'server' } }, admin.id)
    ).rejects.toMatchObject({ statusCode: 404 });

    const orgKey = await prisma.sshKey.findFirst({ where: { orgId: org.id, ownerId: null, name: 'org-key' } });
    await expect(
      keyDeploymentService.createBatch(
        org.id,
        { sshKeyId: orgKey.id, serverIds: [server.id], action: 'deploy', auth: { mode: 'credential', credentialId: aliceCred.id } },
        admin.id
      )
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      quickConnectService.saveAsServer(org.id, actorAdmin, {
        host: '203.0.113.22',
        username: 'ops',
        customerId: customer.id,
        identity: { mode: 'existing', credentialId: aliceCred.id },
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  dbTest('Quick Connect: own personal identity yes, someone else’s never', async () => {
    const aliceCred = await prisma.credential.findFirst({ where: { orgId: org.id, ownerId: alice.id, name: 'home' } });
    const managerLike = { ...actorB, permissions: new Set([...memberPerms(), 'quick_connect.use']) };
    await expect(
      quickConnectService.createTicket(org.id, managerLike, {
        host: '203.0.113.30',
        port: 22,
        auth: { type: 'credential', credentialId: aliceCred.id },
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    const aliceQc = { ...actorA, permissions: new Set([...memberPerms(), 'quick_connect.use']) };
    const { ticket } = await quickConnectService.createTicket(org.id, aliceQc, {
      host: '203.0.113.30',
      port: 22,
      auth: { type: 'credential', credentialId: aliceCred.id },
    });
    // Only Alice can redeem it.
    await expect(quickConnectService.consumeTicket(ticket, { userId: bob.id, orgId: org.id })).rejects.toMatchObject({ statusCode: 403 });
  });

  dbTest('My hosts: private per user, prod refused, org identities need permission', async () => {
    const aliceCred = await prisma.credential.findFirst({ where: { orgId: org.id, ownerId: alice.id, name: 'home' } });
    const { host } = await vaultService.createHost(org.id, actorA, {
      name: 'lab',
      host: '203.0.113.40',
      port: 22,
      credentialId: aliceCred.id,
    });
    expect(host.credential.scope).toBe('personal');
    expect(host.username).toBeNull();

    expect((await vaultService.listHosts(org.id, actorB)).hosts.map((h) => h.id)).not.toContain(host.id);
    await expect(vaultService.connectHost(org.id, actorB, host.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(vaultService.updateHost(org.id, actorB, host.id, { name: 'mine' })).rejects.toMatchObject({ statusCode: 404 });

    // Bob can't point his host at Alice's identity.
    await expect(
      vaultService.createHost(org.id, actorB, { name: 'sneaky', host: '203.0.113.41', credentialId: aliceCred.id })
    ).rejects.toMatchObject({ statusCode: 400 });

    // Org identities need quick_connect.use_stored_identity.
    const orgCred = await prisma.credential.findFirst({ where: { orgId: org.id, ownerId: null, name: 'shared' } });
    await expect(
      vaultService.createHost(org.id, actorB, { name: 'org-cred', host: '203.0.113.42', credentialId: orgCred.id })
    ).rejects.toMatchObject({ statusCode: 403 });

    // A host that is a saved prod server is refused at save time and at connect time.
    await prisma.server.create({
      data: { orgId: org.id, customerId: customer.id, hostname: 'prod-db', ipAddress: '203.0.113.50', environment: 'prod' },
    });
    await expect(
      vaultService.createHost(org.id, actorA, { name: 'prod', host: '203.0.113.50', username: 'alice' })
    ).rejects.toMatchObject({ code: 'PROD_HOST_REQUIRES_APPROVAL' });
    await prisma.personalHost.update({ where: { id: host.id }, data: { host: '203.0.113.50' } }); // e.g. saved before the server existed
    await expect(vaultService.connectHost(org.id, actorA, host.id)).rejects.toMatchObject({ code: 'PROD_HOST_REQUIRES_APPROVAL' });
    await prisma.personalHost.update({ where: { id: host.id }, data: { host: '203.0.113.40' } });

    // Connect works without quick_connect.use (members don't have it).
    const { ticket } = await vaultService.connectHost(org.id, actorA, host.id);
    const connect = await quickConnectService.consumeTicket(ticket, { userId: alice.id, orgId: org.id });
    expect(connect.personalHostId).toBe(host.id);
    expect(connect.username).toBe('alice');

    // No identity → needs a one-off secret.
    const { host: bare } = await vaultService.createHost(org.id, actorA, { name: 'bare', host: '203.0.113.43', username: 'root' });
    await expect(vaultService.connectHost(org.id, actorA, bare.id)).rejects.toMatchObject({ code: 'SECRET_REQUIRED' });
    await expect(vaultService.connectHost(org.id, actorA, bare.id, { auth: { type: 'password', password: 'x' } })).resolves.toHaveProperty('ticket');
  });

  dbTest('org switch off blocks My hosts and personal identities', async () => {
    await updateAccessSettings(org.id, { personalVaultEnabled: false });
    try {
      await expect(vaultService.listHosts(org.id, actorA)).rejects.toMatchObject({ code: 'VAULT_DISABLED' });
      const aliceCred = await prisma.credential.findFirst({ where: { orgId: org.id, ownerId: alice.id, name: 'home' } });
      const aliceQc = { ...actorA, permissions: new Set([...memberPerms(), 'quick_connect.use']) };
      await expect(
        quickConnectService.createTicket(org.id, aliceQc, { host: '203.0.113.30', auth: { type: 'credential', credentialId: aliceCred.id } })
      ).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await updateAccessSettings(org.id, { personalVaultEnabled: true });
    }
  });

  dbTest('move to org: identity takes its key; a shared key blocks the move', async () => {
    const { credential } = await keystoreService.createCredential(
      org.id,
      { name: 'deploy-bot', username: 'deploy', authType: 'key', newKey: { generate: true, keyType: 'ed25519' } },
      alice.id,
      personal(alice)
    );
    const moved = await keystoreService.moveCredentialToOrg(org.id, credential.id, alice.id);
    expect(moved.credential.scope).toBe('org');
    const key = await prisma.sshKey.findUnique({ where: { id: moved.credential.sshKey.id } });
    expect(key.ownerId).toBeNull();

    const aliceKey = await prisma.sshKey.findFirst({ where: { orgId: org.id, ownerId: alice.id, name: 'alice-key' } });
    await expect(keystoreService.moveKeyToOrg(org.id, aliceKey.id, alice.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(keystoreService.moveKeyToOrg(org.id, aliceKey.id, bob.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  dbTest('deleting a user deletes their personal vault', async () => {
    const actorSA = { userId: admin.id, roleId: null, tier: 'super_admin', permissions: new Set(PERMISSION_KEYS) };
    await deleteUser(org.id, bob.id, {}, admin.id, actorSA);
    expect(await prisma.credential.count({ where: { ownerId: bob.id } })).toBe(0);
    expect(await prisma.sshKey.count({ where: { ownerId: bob.id } })).toBe(0);
    expect(await prisma.personalHost.count({ where: { ownerId: bob.id } })).toBe(0);
  });
});
