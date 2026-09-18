/**
 * certificateService.verify — per-host agent-token binding tests (B-1 fix).
 *
 * Before this fix, verify({serial, principal}) looked a certificate up by
 * serial GLOBALLY with no notion of which host was asking, so a cert minted
 * for server A also authenticated on server B/C in the same (or another!)
 * org. These tests exercise the fix end-to-end against a live test DB
 * (auto-skipped when DATABASE_URL isn't reachable, matching this repo's
 * existing convention).
 */

import prisma from '../../config/db.js';
import { verify } from '../certificateService.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

let seq = 0;
function uniq() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

async function createOrgWithCa() {
  const org = await createTestOrg();
  const caKeyPair = await prisma.caKeyPair.create({
    data: {
      orgId: org.id,
      name: 'test-ca',
      publicKey: 'ssh-ed25519 AAAAtest test-ca',
      encryptedPrivateKey: 'not-a-real-ciphertext',
      encryptionIv: 'iv',
      encryptionTag: 'tag',
      fingerprint: `SHA256:test-${uniq()}`,
    },
  });
  return { org, caKeyPair };
}

async function createServer(orgId) {
  const customer = await prisma.customer.create({
    data: { orgId, name: 'HostBinding Test Customer', slug: `hostbind-${uniq()}` },
  });
  return prisma.server.create({
    data: {
      orgId,
      customerId: customer.id,
      hostname: `host-${uniq()}`,
      ipAddress: '10.0.0.9',
    },
  });
}

let nextSerial = BigInt(Date.now()) * 1000n;
function newSerial() {
  nextSerial += 1n;
  return nextSerial;
}

async function createCert({ orgId, caKeyPairId, issuedForId, principals = ['ubuntu'] }) {
  return prisma.certificate.create({
    data: {
      orgId,
      caKeyPairId,
      serial: newSerial(),
      type: 'USER',
      keyId: 'test-key',
      principals,
      publicKey: 'ssh-ed25519 AAAAtestuserkey',
      signedCert: 'ssh-ed25519-cert-v01@openssh.com AAAAtest',
      validAfter: new Date(Date.now() - 60_000),
      validBefore: new Date(Date.now() + 3600_000),
      status: 'ACTIVE',
      issuedForId: issuedForId ?? null,
      issuedVia: 'access_request',
    },
  });
}

describe('certificateService.verify — per-host binding (live DB)', () => {
  let orgA;
  let orgB;
  let caA;
  let caB;
  let serverA1;
  let serverA2;
  let serverB1;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    ({ org: orgA, caKeyPair: caA } = await createOrgWithCa());
    ({ org: orgB, caKeyPair: caB } = await createOrgWithCa());
    serverA1 = await createServer(orgA.id);
    serverA2 = await createServer(orgA.id);
    serverB1 = await createServer(orgB.id);
  });

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      if (!org) continue;
      await prisma.accessRequest.deleteMany({ where: { orgId: org.id } });
      await prisma.certificate.deleteMany({ where: { orgId: org.id } });
      await prisma.server.deleteMany({ where: { orgId: org.id } });
      await prisma.customer.deleteMany({ where: { orgId: org.id } });
      await prisma.caKeyPair.deleteMany({ where: { orgId: org.id } });
      await cleanupOrg(org.id);
    }
    await prisma.$disconnect().catch(() => {});
  });

  test('valid: cert issued for serverA1, asked by serverA1', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const cert = await createCert({ orgId: orgA.id, caKeyPairId: caA.id, issuedForId: serverA1.id });
    const result = await verify({
      serial: cert.serial,
      principal: 'ubuntu',
      agentServer: { id: serverA1.id, orgId: orgA.id },
    });
    expect(result.valid).toBe(true);
  });

  test('invalid: cert issued for serverA1, asked by serverA2 (same org, different host)', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const cert = await createCert({ orgId: orgA.id, caKeyPairId: caA.id, issuedForId: serverA1.id });
    const result = await verify({
      serial: cert.serial,
      principal: 'ubuntu',
      agentServer: { id: serverA2.id, orgId: orgA.id },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('certificate not issued for this host');
  });

  test('invalid: cert issued for serverA1 (orgA), asked by serverB1 (orgB)', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const cert = await createCert({ orgId: orgA.id, caKeyPairId: caA.id, issuedForId: serverA1.id });
    const result = await verify({
      serial: cert.serial,
      principal: 'ubuntu',
      agentServer: { id: serverB1.id, orgId: orgB.id },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('certificate not issued for this host');
  });

  test('invalid: cert with no server binding (issuedForId null) is denied in per-host mode', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const cert = await createCert({ orgId: orgA.id, caKeyPairId: caA.id, issuedForId: null });
    const result = await verify({
      serial: cert.serial,
      principal: 'ubuntu',
      agentServer: { id: serverA1.id, orgId: orgA.id },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('certificate not issued for this host');
  });

  test('legacy mode (agentServer null) skips host binding — unchanged prior behaviour', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const cert = await createCert({ orgId: orgA.id, caKeyPairId: caA.id, issuedForId: serverA1.id });
    const result = await verify({ serial: cert.serial, principal: 'ubuntu', agentServer: null });
    expect(result.valid).toBe(true);
  });

  test('invalid: linked AccessRequest was revoked after approval — denied in per-host mode', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const cert = await createCert({ orgId: orgA.id, caKeyPairId: caA.id, issuedForId: serverA1.id });
    const user = await prisma.user.create({
      data: { orgId: orgA.id, email: `ar-${uniq()}@example.com`, name: 'AR Test User', role: 'member', status: 'active' },
    });
    await prisma.accessRequest.create({
      data: {
        orgId: orgA.id,
        requesterId: user.id,
        serverId: serverA1.id,
        status: 'REVOKED', // approved, then revoked — cert.status may not have caught up
        reason: 'test',
        requestedPrincipal: 'ubuntu',
        requestedDuration: 3600,
        certificateId: cert.id,
      },
    });
    const result = await verify({
      serial: cert.serial,
      principal: 'ubuntu',
      agentServer: { id: serverA1.id, orgId: orgA.id },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('access request is no longer approved');
    await prisma.accessRequest.deleteMany({ where: { certificateId: cert.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  });

  test('valid: linked AccessRequest still APPROVED and unexpired', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const cert = await createCert({ orgId: orgA.id, caKeyPairId: caA.id, issuedForId: serverA1.id });
    const user = await prisma.user.create({
      data: { orgId: orgA.id, email: `ar-${uniq()}@example.com`, name: 'AR Test User', role: 'member', status: 'active' },
    });
    await prisma.accessRequest.create({
      data: {
        orgId: orgA.id,
        requesterId: user.id,
        serverId: serverA1.id,
        status: 'APPROVED',
        reason: 'test',
        requestedPrincipal: 'ubuntu',
        requestedDuration: 3600,
        expiresAt: new Date(Date.now() + 3600_000),
        certificateId: cert.id,
      },
    });
    const result = await verify({
      serial: cert.serial,
      principal: 'ubuntu',
      agentServer: { id: serverA1.id, orgId: orgA.id },
    });
    expect(result.valid).toBe(true);
    await prisma.accessRequest.deleteMany({ where: { certificateId: cert.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  });
});
