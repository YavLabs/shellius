/**
 * collectorUpdate.test.js — signed, staged collector updates.
 *
 * This is the feature most capable of taking a customer's whole fleet down,
 * so the assertions are weighted towards refusal rather than towards the
 * happy path: it must not offer when it is turned off, must not widen on a
 * bad step, must not treat a host that was already dead as an update failure,
 * and must not be able to hand a host anything the installation's own key did
 * not sign.
 */

import crypto from 'crypto';
import prisma from '../../config/db.js';
import * as releaseSigningService from '../releaseSigningService.js';
import {
  bucketFor,
  cohortSize,
  candidatesFor,
  offerFor,
  recordReportedVersion,
  failSilentAttempts,
  stepHealth,
  VERIFY_GRACE_MS,
  MAX_FAILURE_RATE,
} from '../collectorUpdateService.js';
import { advanceOrg, nextPercent } from '../../jobs/collectorRollout.js';
import { POSTURE_COLLECTOR_VERSION } from '../../utils/postureCollectorVersion.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

let seq = 0;
const unique = () => {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
};

const MINUTE = 60 * 1000;

describe('cohort maths', () => {
  test('a host keeps its position for the whole of one rollout', () => {
    const a = bucketFor('srv-1', '1.2.0');
    expect(bucketFor('srv-1', '1.2.0')).toBe(a);
  });

  // A canary that changed between steps would prove nothing about the step
  // that came before it.
  test('different hosts get different positions', () => {
    const buckets = new Set(
      Array.from({ length: 200 }, (_, i) => bucketFor(`srv-${i}`, '1.2.0'))
    );
    expect(buckets.size).toBeGreaterThan(150);
  });

  // ...but the same hosts must not be the canaries forever.
  test('a new version reshuffles the order', () => {
    const order = (v) =>
      Array.from({ length: 30 }, (_, i) => `srv-${i}`)
        .sort((x, y) => bucketFor(x, v) - bucketFor(y, v))
        .join(',');
    expect(order('1.2.0')).not.toBe(order('1.3.0'));
  });

  test('positions stay inside the range', () => {
    for (let i = 0; i < 500; i += 1) {
      const b = bucketFor(`srv-${i}`, '9.9.9');
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(10000);
    }
  });

  // The arithmetic trap that already bit the directory-sync safety valve:
  // ceil(2 * 10/100) is 0, so a small org would sit at "rolling" forever
  // having done nothing at all.
  test('a cohort is never empty while there is work and a percentage', () => {
    expect(cohortSize(1, 10)).toBe(1);
    expect(cohortSize(2, 10)).toBe(1);
    expect(cohortSize(9, 10)).toBe(1);
  });

  test('scales as expected, and 100% means everything', () => {
    expect(cohortSize(100, 10)).toBe(10);
    expect(cohortSize(100, 25)).toBe(25);
    expect(cohortSize(90, 50)).toBe(45);
    expect(cohortSize(90, 100)).toBe(90);
    expect(cohortSize(7, 100)).toBe(7);
  });

  test('nothing to do, or no percentage, offers nobody', () => {
    expect(cohortSize(0, 50)).toBe(0);
    expect(cohortSize(10, 0)).toBe(0);
    expect(cohortSize(-5, 50)).toBe(0);
  });

  test('steps widen and then stop', () => {
    expect(nextPercent(0)).toBe(10);
    expect(nextPercent(10)).toBe(25);
    expect(nextPercent(25)).toBe(50);
    expect(nextPercent(50)).toBe(100);
    expect(nextPercent(100)).toBeNull();
  });
});

describe('release signing', () => {
  test('signs and verifies its own output', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const payload = Buffer.from('#!/bin/bash\necho hello\n');
    const { signature, algorithm, fingerprint } = await releaseSigningService.sign(payload);
    expect(algorithm).toBe('rsa-4096');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await releaseSigningService.verify(payload, signature)).toBe(true);
  });

  test('a tampered payload fails verification', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const payload = Buffer.from('#!/bin/bash\necho hello\n');
    const { signature } = await releaseSigningService.sign(payload);
    expect(await releaseSigningService.verify(Buffer.from('#!/bin/bash\nrm -rf /\n'), signature)).toBe(false);
  });

  test('a signature from another key fails verification', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const payload = Buffer.from('payload');
    const other = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const foreign = crypto.sign('sha256', payload, other.privateKey).toString('base64');
    expect(await releaseSigningService.verify(payload, foreign)).toBe(false);
  });

  test('garbage in the signature field is a failure, not a crash', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    expect(await releaseSigningService.verify(Buffer.from('x'), 'not-base64-!!')).toBe(false);
    expect(await releaseSigningService.verify(Buffer.from('x'), '')).toBe(false);
  });

  // The verifier on the host is `openssl dgst -sha256 -verify`, so node must
  // be producing PKCS#1 v1.5 — not PSS, whose signatures openssl would reject
  // without extra flags the updater does not pass.
  test('produces a signature openssl dgst can check (PKCS#1 v1.5)', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const payload = Buffer.from('bytes to sign');
    const { signature } = await releaseSigningService.sign(payload);
    const { publicKeyPem } = await releaseSigningService.getPublicKey();
    const ok = crypto.verify(
      'sha256',
      payload,
      { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(signature, 'base64')
    );
    expect(ok).toBe(true);
  });

  test('the key is created once and reused', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const a = await releaseSigningService.getOrCreateKey();
    const b = await releaseSigningService.getOrCreateKey();
    expect(b.id).toBe(a.id);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  test('the private key is not stored in the clear', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const key = await releaseSigningService.getOrCreateKey();
    expect(key.privateKeyEncrypted).not.toContain('PRIVATE KEY');
  });
});

describe('rollout (live DB)', () => {
  let org;
  let customer;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${unique()}` },
    });
  });

  afterAll(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.collectorUpdateAttempt.deleteMany({ where: { orgId: org.id } });
    await prisma.collectorRollout.deleteMany({ where: { orgId: org.id } });
    await prisma.hostSnapshot.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.postureSettings.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  afterEach(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.collectorUpdateAttempt.deleteMany({ where: { orgId: org.id } });
    await prisma.collectorRollout.deleteMany({ where: { orgId: org.id } });
    await prisma.hostSnapshot.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
  });

  const settings = (over = {}) =>
    prisma.postureSettings.upsert({
      where: { orgId: org.id },
      create: { orgId: org.id, enabled: true, collectorAutoUpdate: true, ...over },
      update: { enabled: true, collectorAutoUpdate: true, ...over },
    });

  /** A bootstrapped host that is reporting an old collector. */
  async function host({ version = '0.0.1', at = new Date(), osType = 'linux', protocol = 'ssh' } = {}) {
    const s = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: `h-${unique()}.example.com`,
        ipAddress: '10.7.0.1',
        environment: 'prod',
        osType,
        protocol,
        provisionStatus: 'provisioned',
        agentId: `agent-${unique()}`,
        postureInstalledAt: new Date(Date.now() - 60 * MINUTE),
      },
    });
    if (version !== null) {
      await prisma.hostSnapshot.create({
        data: {
          orgId: org.id,
          serverId: s.id,
          collectedAt: at,
          receivedAt: at,
          collectorOk: true,
          agentVersion: version,
          raw: {},
        },
      });
    }
    return s;
  }

  test('a reporting host on an older collector is a candidate', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    await host({ version: '0.0.1' });
    const c = await candidatesFor(org.id, POSTURE_COLLECTOR_VERSION);
    expect(c).toHaveLength(1);
  });

  test('a host already on the target version is not a candidate', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    await host({ version: POSTURE_COLLECTOR_VERSION });
    expect(await candidatesFor(org.id, POSTURE_COLLECTOR_VERSION)).toHaveLength(0);
  });

  // Offering to a host that was already silent means its continued silence
  // gets counted as an update failure, and a fleet with a few dead machines
  // would halt every rollout.
  test('a host that has never reported is not a candidate', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    await host({ version: null });
    expect(await candidatesFor(org.id, POSTURE_COLLECTOR_VERSION)).toHaveLength(0);
  });

  test('a host that has gone quiet is not a candidate', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    await host({ version: '0.0.1', at: new Date(Date.now() - 24 * 60 * MINUTE) });
    expect(await candidatesFor(org.id, POSTURE_COLLECTOR_VERSION)).toHaveLength(0);
  });

  test('Windows and RDP-only hosts are never candidates', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    await host({ osType: 'windows' });
    await host({ protocol: 'rdp' });
    expect(await candidatesFor(org.id, POSTURE_COLLECTOR_VERSION)).toHaveLength(0);
  });

  test('does nothing at all while auto-update is off', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings({ collectorAutoUpdate: false });
    await host();
    const result = await advanceOrg(org.id);
    expect(result.action).toBe('disabled');
    expect(await prisma.collectorRollout.count({ where: { orgId: org.id } })).toBe(0);
  });

  test('turning auto-update off mid-rollout cancels it', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    await host();
    await advanceOrg(org.id);
    await settings({ collectorAutoUpdate: false });

    const result = await advanceOrg(org.id);
    expect(result.action).toBe('cancelled');
    const r = await prisma.collectorRollout.findFirst({ where: { orgId: org.id } });
    expect(r.status).toBe('cancelled');
  });

  test('the first step offers the canary cohort, not the fleet', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings({ collectorCanaryPercent: 10 });
    for (let i = 0; i < 10; i += 1) await host();

    const result = await advanceOrg(org.id);
    expect(result.action).toBe('stepped');
    expect(result.percent).toBe(10);
    expect(await prisma.collectorUpdateAttempt.count({ where: { orgId: org.id } })).toBe(1);
  });

  test('a two-host organization still gets exactly one canary', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings({ collectorCanaryPercent: 10 });
    await host();
    await host();
    await advanceOrg(org.id);
    expect(await prisma.collectorUpdateAttempt.count({ where: { orgId: org.id } })).toBe(1);
  });

  test('it does not widen while the current step is still pending', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    for (let i = 0; i < 10; i += 1) await host();
    await advanceOrg(org.id);

    const again = await advanceOrg(org.id);
    expect(again.action).toBe('waiting');
    expect(await prisma.collectorUpdateAttempt.count({ where: { orgId: org.id } })).toBe(1);
  });

  test('a healthy step widens the rollout', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    for (let i = 0; i < 10; i += 1) await host();
    await advanceOrg(org.id);

    // The canary comes back on the new version.
    const attempt = await prisma.collectorUpdateAttempt.findFirst({ where: { orgId: org.id } });
    await recordReportedVersion(org.id, attempt.serverId, POSTURE_COLLECTOR_VERSION);

    // Dwell time has passed.
    const later = new Date(Date.now() + 60 * MINUTE);
    const result = await advanceOrg(org.id, { now: later });
    expect(result.action).toBe('stepped');
    expect(result.percent).toBe(25);
  });

  // The whole point of the gate.
  test('a failed step halts the rollout instead of widening it', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings({ collectorCanaryPercent: 50 });
    for (let i = 0; i < 10; i += 1) await host();
    await advanceOrg(org.id);

    // Every host in the step comes back still on the old version, well after
    // the grace period — which is what a host-side rollback looks like.
    const attempts = await prisma.collectorUpdateAttempt.findMany({ where: { orgId: org.id } });
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    const late = new Date(Date.now() + VERIFY_GRACE_MS + MINUTE);
    for (const a of attempts) {
      await recordReportedVersion(org.id, a.serverId, '0.0.1', late);
    }

    const result = await advanceOrg(org.id, { now: late });
    expect(result.action).toBe('halted');
    const r = await prisma.collectorRollout.findFirst({ where: { orgId: org.id } });
    expect(r.status).toBe('halted');
    expect(r.haltedReason).toMatch(/did not come back healthy/);
  });

  test('a halted rollout is not silently started again', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings({ collectorCanaryPercent: 100 });
    await host();
    await host();
    await advanceOrg(org.id);
    const attempts = await prisma.collectorUpdateAttempt.findMany({ where: { orgId: org.id } });
    const late = new Date(Date.now() + VERIFY_GRACE_MS + MINUTE);
    for (const a of attempts) await recordReportedVersion(org.id, a.serverId, '0.0.1', late);
    await advanceOrg(org.id, { now: late });

    const after = await advanceOrg(org.id, { now: new Date(late.getTime() + 60 * MINUTE) });
    expect(after.action).toBe('previously-ended');
    expect(after.status).toBe('halted');
  });

  test('one failure out of one host does not halt a small organization', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings({ collectorCanaryPercent: 10 });
    for (let i = 0; i < 10; i += 1) await host();
    await advanceOrg(org.id);
    const attempt = await prisma.collectorUpdateAttempt.findFirst({ where: { orgId: org.id } });
    const late = new Date(Date.now() + VERIFY_GRACE_MS + MINUTE);
    await recordReportedVersion(org.id, attempt.serverId, '0.0.1', late);

    const result = await advanceOrg(org.id, { now: late });
    expect(result.action).not.toBe('halted');
  });

  test('a host that goes silent after the offer is judged a failure', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    await host();
    await advanceOrg(org.id);
    const rollout = await prisma.collectorRollout.findFirst({ where: { orgId: org.id } });

    const n = await failSilentAttempts(rollout.id, new Date(Date.now() + VERIFY_GRACE_MS + MINUTE));
    expect(n).toBe(1);
    const a = await prisma.collectorUpdateAttempt.findFirst({ where: { rolloutId: rollout.id } });
    expect(a.status).toBe('failed');
    expect(a.detail).toMatch(/went silent/);
  });

  test('a host still on the old version inside the grace period is not judged yet', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    await host();
    await advanceOrg(org.id);
    const attempt = await prisma.collectorUpdateAttempt.findFirst({ where: { orgId: org.id } });

    await recordReportedVersion(org.id, attempt.serverId, '0.0.1', new Date(Date.now() + MINUTE));
    const after = await prisma.collectorUpdateAttempt.findUnique({ where: { id: attempt.id } });
    expect(after.status).toBe('offered');
    expect(after.reportedAt).not.toBeNull();
  });

  test('a host that jumped ahead of the target counts as verified', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    await host();
    await advanceOrg(org.id);
    const attempt = await prisma.collectorUpdateAttempt.findFirst({ where: { orgId: org.id } });

    await recordReportedVersion(org.id, attempt.serverId, '99.0.0');
    const after = await prisma.collectorUpdateAttempt.findUnique({ where: { id: attempt.id } });
    expect(after.status).toBe('verified');
  });

  test('offerFor returns the offer, and nothing once it is verified', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    const s = await host();
    await advanceOrg(org.id);

    const offer = await offerFor(s.id);
    expect(offer).not.toBeNull();
    expect(offer.version).toBe(POSTURE_COLLECTOR_VERSION);

    await recordReportedVersion(org.id, s.id, POSTURE_COLLECTOR_VERSION);
    expect(await offerFor(s.id)).toBeNull();
  });

  test('a host with no offer gets nothing', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    const s = await host();
    expect(await offerFor(s.id)).toBeNull();
  });

  test('a halted rollout stops offering, even to hosts already in it', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings();
    const s = await host();
    await advanceOrg(org.id);
    expect(await offerFor(s.id)).not.toBeNull();

    await prisma.collectorRollout.updateMany({
      where: { orgId: org.id },
      data: { status: 'halted', haltedReason: 'stopped by a person' },
    });
    expect(await offerFor(s.id)).toBeNull();
  });

  test('stepHealth counts what the gate reads', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await settings({ collectorCanaryPercent: 100 });
    for (let i = 0; i < 4; i += 1) await host();
    await advanceOrg(org.id);
    const rollout = await prisma.collectorRollout.findFirst({ where: { orgId: org.id } });
    const attempts = await prisma.collectorUpdateAttempt.findMany({ where: { rolloutId: rollout.id } });

    await recordReportedVersion(org.id, attempts[0].serverId, POSTURE_COLLECTOR_VERSION);
    const late = new Date(Date.now() + VERIFY_GRACE_MS + MINUTE);
    await recordReportedVersion(org.id, attempts[1].serverId, '0.0.1', late);

    const health = await stepHealth(rollout.id);
    expect(health.verified).toBe(1);
    expect(health.failed).toBe(1);
    expect(health.pending).toBe(2);
    expect(health.rate).toBeCloseTo(0.5);
    expect(health.rate).toBeGreaterThan(MAX_FAILURE_RATE);
  });
});
