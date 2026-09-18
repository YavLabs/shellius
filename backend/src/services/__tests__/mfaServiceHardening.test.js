/**
 * mfaService.js — hardening-pass behavior: pending TOTP secrets never
 * clobber an active one until confirmed, backup-code entropy, and the
 * per-challenge/per-user Redis attempt limiter.
 *
 * Live-DB/Redis tests auto-skip (with console.warn) when unreachable.
 */

import prisma from '../../config/db.js';
import * as mfaService from '../mfaService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let org;
let skip = false;

beforeAll(async () => {
  skip = !(await dbReachable());
  if (skip) {
    console.warn('[skip] mfaService hardening tests — DATABASE_URL unreachable');
    return;
  }
  org = await createTestOrg();
});

afterAll(async () => {
  if (org) await cleanupOrg(org.id);
  await prisma.$disconnect().catch(() => {});
});

describe('TOTP enrollment — pending secret never breaks a working authenticator', () => {
  test('beginTotpEnroll writes mfaTotpPendingEnc and leaves an existing active secret untouched', async () => {
    if (skip) return;
    const { authenticator } = await import('otplib');

    const user = await createTestUser(org.id);

    // First enrollment.
    const first = await mfaService.beginTotpEnroll(user);
    let fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(fresh.mfaTotpPendingEnc).not.toBeNull();
    expect(fresh.mfaTotpEnabled).toBe(false);

    await mfaService.confirmTotpEnroll(fresh, authenticator.generate(first.secret));
    fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(fresh.mfaTotpEnabled).toBe(true);
    expect(fresh.mfaTotpPendingEnc).toBeNull();
    const activeSecretAfterFirst = fresh.mfaTotpSecretEnc;

    // Re-enroll (restart setup) — must NOT touch the active secret until a
    // NEW code is confirmed.
    await mfaService.beginTotpEnroll(fresh);
    fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(fresh.mfaTotpSecretEnc).toBe(activeSecretAfterFirst); // unchanged
    expect(fresh.mfaTotpEnabled).toBe(true); // still enabled with the OLD secret
    expect(fresh.mfaTotpPendingEnc).not.toBeNull();

    // The OLD authenticator code must still verify — re-enrolling never broke it.
    expect(mfaService.verifyTotp(fresh, authenticator.generate(first.secret))).toBe(true);
  }, 15000);

  test('confirmTotpEnroll only mints new backup codes on first enrollment, not on re-enroll', async () => {
    if (skip) return;
    const { authenticator } = await import('otplib');
    const user = await createTestUser(org.id);

    const first = await mfaService.beginTotpEnroll(user);
    const afterBegin = await prisma.user.findUnique({ where: { id: user.id } });
    const { backupCodes: firstCodes } = await mfaService.confirmTotpEnroll(afterBegin, authenticator.generate(first.secret));
    expect(Array.isArray(firstCodes)).toBe(true);
    expect(firstCodes.length).toBe(10);
    // 4-4-4 base32 formatting
    expect(firstCodes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    let fresh = await prisma.user.findUnique({ where: { id: user.id } });
    const second = await mfaService.beginTotpEnroll(fresh);
    fresh = await prisma.user.findUnique({ where: { id: user.id } });
    const { backupCodes: secondCodes } = await mfaService.confirmTotpEnroll(fresh, authenticator.generate(second.secret));
    expect(secondCodes).toBeNull(); // codes already existed — not silently invalidated
  }, 15000);
});

describe('backup codes', () => {
  test('regenerateBackupCodes produces 10 codes with ~60 bits of entropy (4-4-4 base32)', async () => {
    if (skip) return;
    const user = await createTestUser(org.id, { data: { mfaEmailEnabled: true } });
    const codes = await mfaService.regenerateBackupCodes(user);
    expect(codes.length).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
    expect(new Set(codes).size).toBe(10); // no collisions
  });

  test('verifyBackupCode accepts a code regardless of dash/case formatting, and is single-use', async () => {
    if (skip) return;
    const user = await createTestUser(org.id, { data: { mfaEmailEnabled: true } });
    const codes = await mfaService.regenerateBackupCodes(user);
    let fresh = await prisma.user.findUnique({ where: { id: user.id } });
    const code = codes[0];

    const ok = await mfaService.verifyBackupCode(fresh, code.toLowerCase().replace(/-/g, ''));
    expect(ok).toBe(true);

    fresh = await prisma.user.findUnique({ where: { id: user.id } });
    const reused = await mfaService.verifyBackupCode(fresh, code);
    expect(reused).toBe(false); // already consumed
  });
});

describe('login-challenge attempt limiting (Redis)', () => {
  test('recordChallengeFailure burns the challenge after 5 failures', async () => {
    if (skip) return;
    const jti = `test-${Date.now()}`;
    let result;
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      result = await mfaService.recordChallengeFailure(jti);
    }
    expect(result.burned).toBe(true);
    expect(await mfaService.isChallengeBurned(jti)).toBe(true);
  });

  test('clearChallengeAttempts resets the counter', async () => {
    if (skip) return;
    const jti = `test-clear-${Date.now()}`;
    await mfaService.recordChallengeFailure(jti);
    await mfaService.clearChallengeAttempts(jti);
    expect(await mfaService.isChallengeBurned(jti)).toBe(false);
  });
});
