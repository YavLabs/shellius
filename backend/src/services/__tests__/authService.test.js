/**
 * authService.js — integration tests against a live Postgres.
 * Auto-skips (with a console.warn) when DATABASE_URL is unreachable, per
 * this repo's existing smoke-test convention.
 */

import prisma from '../../config/db.js';
import * as authService from '../authService.js';
import { generateRefreshToken, hashToken } from '../../utils/jwt.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let org;
let skip = false;

beforeAll(async () => {
  skip = !(await dbReachable());
  if (skip) {
    console.warn('[skip] authService integration tests — DATABASE_URL unreachable');
    return;
  }
  org = await createTestOrg();
});

afterAll(async () => {
  if (org) await cleanupOrg(org.id);
  await prisma.$disconnect().catch(() => {});
});

describe('authService.login — lockout', () => {
  test('locks the account after AUTH_LOCKOUT_THRESHOLD failed attempts and returns ACCOUNT_LOCKED', async () => {
    if (skip) return;
    const user = await createTestUser(org.id, { password: 'RightPassword123!' });

    // 5 wrong attempts (default threshold)
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await expect(authService.login(user.email, 'WrongPassword123!', '127.0.0.1', 'jest')).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
    }

    // 6th attempt (even with the CORRECT password) must be locked out
    await expect(authService.login(user.email, 'RightPassword123!', '127.0.0.1', 'jest')).rejects.toMatchObject({
      statusCode: 423,
      code: 'ACCOUNT_LOCKED',
    });

    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(fresh.lockedUntil).not.toBeNull();
    expect(fresh.lockedUntil.getTime()).toBeGreaterThan(Date.now());
  }, 15000);

  test('successful login resets failedLoginCount', async () => {
    if (skip) return;
    const user = await createTestUser(org.id, { password: 'RightPassword123!' });
    await expect(authService.login(user.email, 'wrong', '127.0.0.1', 'jest')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    let fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(fresh.failedLoginCount).toBe(1);

    const result = await authService.login(user.email, 'RightPassword123!', '127.0.0.1', 'jest');
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();

    fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(fresh.failedLoginCount).toBe(0);
  });

  test('unknown email returns the same generic INVALID_CREDENTIALS error (no enumeration)', async () => {
    if (skip) return;
    await expect(
      authService.login('does-not-exist@example.com', 'whatever', '127.0.0.1', 'jest')
    ).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
  });
});

describe('authService.refresh — rotation + reuse detection', () => {
  test('rotating a refresh token works and the old token cannot be reused', async () => {
    if (skip) return;
    const user = await createTestUser(org.id);
    const session = await authService.issueSession(user, '127.0.0.1', 'jest', 'web');

    const rotated = await authService.refresh(session.refreshToken, '127.0.0.1', 'jest');
    expect(rotated.accessToken).toBeDefined();
    expect(rotated.refreshToken).not.toBe(session.refreshToken);
  });

  test('reusing a rotated token OUTSIDE the grace window revokes the whole family', async () => {
    if (skip) return;
    const user = await createTestUser(org.id);
    const session = await authService.issueSession(user, '127.0.0.1', 'jest', 'web');
    const rotated = await authService.refresh(session.refreshToken, '127.0.0.1', 'jest');

    // Backdate the revocation so it's outside the reuse-grace window.
    const oldHash = hashToken(session.refreshToken);
    await prisma.refreshToken.updateMany({
      where: { tokenHash: oldHash },
      data: { revokedAt: new Date(Date.now() - 60 * 1000) },
    });

    await expect(authService.refresh(session.refreshToken, '127.0.0.1', 'jest')).rejects.toMatchObject({
      statusCode: 401,
    });

    // The whole family — including the just-rotated, still-fresh token — must
    // now be revoked (theft response).
    const newHash = hashToken(rotated.refreshToken);
    const newRow = await prisma.refreshToken.findUnique({ where: { tokenHash: newHash } });
    expect(newRow.revokedAt).not.toBeNull();

    // Immediately after the theft-triggered revocation, the "legit" rotated
    // token is inside its own reuse-grace window, so it gets the same benign
    // 409 "retry" as any other rotated-token reuse (never a fresh session).
    await expect(authService.refresh(rotated.refreshToken, '127.0.0.1', 'jest')).rejects.toMatchObject({
      statusCode: 409,
    });

    // Once outside the grace window it's unambiguously dead (401) — the
    // family stays revoked, it never "heals" into a working session.
    await prisma.refreshToken.updateMany({
      where: { tokenHash: newHash },
      data: { revokedAt: new Date(Date.now() - 60 * 1000) },
    });
    await expect(authService.refresh(rotated.refreshToken, '127.0.0.1', 'jest')).rejects.toMatchObject({
      statusCode: 401,
    });
  }, 15000);

  test('reusing a rotated token INSIDE the grace window returns 409 without revoking the family', async () => {
    if (skip) return;
    const user = await createTestUser(org.id);
    const session = await authService.issueSession(user, '127.0.0.1', 'jest', 'web');
    const rotated = await authService.refresh(session.refreshToken, '127.0.0.1', 'jest');

    // Immediately reuse the old token — well inside the 10s grace window.
    await expect(authService.refresh(session.refreshToken, '127.0.0.1', 'jest')).rejects.toMatchObject({
      statusCode: 409,
    });

    // The rotated token must still work.
    const stillWorks = await authService.refresh(rotated.refreshToken, '127.0.0.1', 'jest');
    expect(stillWorks.accessToken).toBeDefined();
  });

  test('an unknown/garbage refresh token is rejected', async () => {
    if (skip) return;
    const fake = generateRefreshToken({ userId: 'nope', tokenId: 'nope' });
    await expect(authService.refresh(fake, '127.0.0.1', 'jest')).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('authService.mfaGate', () => {
  test('returns null (no gate) for a user with no MFA factor enrolled', async () => {
    if (skip) return;
    const user = await createTestUser(org.id);
    const gate = await authService.mfaGate(user);
    expect(gate).toBeNull();
  });

  test('returns a challenge for a user with TOTP enrolled, regardless of org MFA config', async () => {
    if (skip) return;
    const user = await createTestUser(org.id, { data: { mfaTotpEnabled: true } });
    const gate = await authService.mfaGate(user);
    expect(gate.mfaRequired).toBe(true);
    expect(gate.methods).toContain('totp');
    expect(typeof gate.mfaToken).toBe('string');
  });
});
