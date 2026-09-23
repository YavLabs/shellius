/**
 * Disabling an account must cut its SSH access, not just its browser session.
 *
 * Before this fix, suspending a user revoked their refresh tokens, bumped
 * sessionsValidFrom and killed live terminals — but left their signed
 * certificates ACTIVE and their approved access requests standing. Hosts ask
 * check-principals whether the *certificate* is good, and the answer stayed
 * yes for the rest of the policy's maxSessionDuration (1–8h in the seeded
 * defaults). A suspended user kept shell access to the fleet.
 *
 * Two layers are tested here:
 *   1. userService — suspend/delete revoke the certificates and requests;
 *   2. certificateService.verify — a certificate whose owner is disabled is
 *      refused even if its own row somehow still says ACTIVE.
 *
 * Live-DB integration tests, auto-skipped when DATABASE_URL is unreachable
 * (this repo's existing convention).
 */

import prisma from '../../config/db.js';
import { verify } from '../certificateService.js';
import { updateUser, revokeAllAccessFor, deleteUser } from '../userService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let seq = 0;
const uniq = () => {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
};

let nextSerial = BigInt(Date.now()) * 1000n + 500_000n;
const newSerial = () => (nextSerial += 1n);

let org;
let ca;
let server;
let customer;

async function createCert(userId, overrides = {}) {
  return prisma.certificate.create({
    data: {
      orgId: org.id,
      caKeyPairId: ca.id,
      serial: newSerial(),
      type: 'USER',
      keyId: `key-${uniq()}`,
      principals: ['ubuntu'],
      publicKey: 'ssh-ed25519 AAAAtestuserkey',
      signedCert: 'ssh-ed25519-cert-v01@openssh.com AAAAtest',
      validAfter: new Date(Date.now() - 60_000),
      validBefore: new Date(Date.now() + 3_600_000),
      status: 'ACTIVE',
      issuedToId: userId,
      issuedForId: server.id,
      issuedVia: 'access_request',
      ...overrides,
    },
  });
}

async function createRequest(userId, status = 'APPROVED') {
  return prisma.accessRequest.create({
    data: {
      orgId: org.id,
      requesterId: userId,
      serverId: server.id,
      requestedPrincipal: 'ubuntu',
      requestedDuration: 3600,
      reason: 'test',
      status,
    },
  });
}

/** An actor with every permission the tested paths ask for. */
const adminActor = (userId) => ({
  userId,
  tier: 'super_admin',
  permissions: new Set(['users.suspend', 'users.update', 'users.delete', 'users.assign_role']),
  roleId: null,
});

describe('disabling an account revokes its standing access (live DB)', () => {
  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    ca = await prisma.caKeyPair.create({
      data: {
        orgId: org.id,
        name: 'test-ca',
        publicKey: 'ssh-ed25519 AAAAtest test-ca',
        encryptedPrivateKey: 'not-a-real-ciphertext',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
        fingerprint: `SHA256:suspend-${uniq()}`,
      },
    });
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Suspend Test Customer', slug: `suspend-${uniq()}` },
    });
    server = await prisma.server.create({
      data: { orgId: org.id, customerId: customer.id, hostname: `host-${uniq()}`, ipAddress: '10.0.0.11' },
    });
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.accessRequest.deleteMany({ where: { orgId: org.id } });
    await prisma.certificate.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.caKeyPair.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  test('suspending a user revokes their active certificates and approved requests', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const admin = await createTestUser(org.id, { role: 'super_admin' });
    const victim = await createTestUser(org.id);
    const cert = await createCert(victim.id);
    const request = await createRequest(victim.id);

    await updateUser(org.id, victim.id, { status: 'suspended' }, adminActor(admin.id));

    expect((await prisma.certificate.findUnique({ where: { id: cert.id } })).status).toBe('REVOKED');
    expect((await prisma.accessRequest.findUnique({ where: { id: request.id } })).status).toBe('REVOKED');
  });

  test('a suspended owner’s certificate is refused by verify', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const victim = await createTestUser(org.id, { status: 'suspended' });
    // Status set directly, so the cert row is still ACTIVE — this is the
    // window between a status change and the revoke landing.
    const cert = await createCert(victim.id);

    const result = await verify({ serial: cert.serial, principal: 'ubuntu' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('certificate owner is not active');
  });

  test('an active owner’s certificate still verifies', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id);
    const cert = await createCert(user.id);

    const result = await verify({ serial: cert.serial, principal: 'ubuntu' });
    expect(result.valid).toBe(true);
  });

  test('a certificate with no owner recorded is unaffected', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    // Direct issuance can leave issuedToId unset; that must not start failing.
    const cert = await createCert(null);

    const result = await verify({ serial: cert.serial, principal: 'ubuntu' });
    expect(result.valid).toBe(true);
  });

  test('changing only the role does not revoke certificates', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const admin = await createTestUser(org.id, { role: 'super_admin' });
    const user = await createTestUser(org.id);
    const cert = await createCert(user.id);

    await updateUser(org.id, user.id, { name: 'Renamed' }, adminActor(admin.id));

    expect((await prisma.certificate.findUnique({ where: { id: cert.id } })).status).toBe('ACTIVE');
  });

  test('reactivating a user does not revoke anything', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const admin = await createTestUser(org.id, { role: 'super_admin' });
    const user = await createTestUser(org.id, { status: 'suspended' });
    const cert = await createCert(user.id);

    await updateUser(org.id, user.id, { status: 'active' }, adminActor(admin.id));

    // Coming back in is not a disabling event — only the new status matters.
    expect((await prisma.certificate.findUnique({ where: { id: cert.id } })).status).toBe('ACTIVE');
  });

  test('hard delete revokes certificates rather than orphaning them', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const admin = await createTestUser(org.id, { role: 'super_admin' });
    const victim = await createTestUser(org.id);
    const cert = await createCert(victim.id);

    await deleteUser(org.id, victim.id, {}, admin.id, adminActor(admin.id));

    // issuedToId is SetNull on delete, so without the fix this row would sit
    // ACTIVE with no owner for verify to judge.
    const after = await prisma.certificate.findUnique({ where: { id: cert.id } });
    expect(after.status).toBe('REVOKED');
    expect(after.issuedToId).toBeNull();
  });

  test('revokeAllAccessFor reports what it revoked', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id);
    await createCert(user.id);
    await createRequest(user.id, 'PENDING');

    const counts = await revokeAllAccessFor(org.id, user.id, {
      reason: 'test',
      sessionReason: 'account_disabled',
    });

    expect(counts).toEqual({ accessRequests: 1, certificates: 1, apiTokens: 0 });
  });
});
