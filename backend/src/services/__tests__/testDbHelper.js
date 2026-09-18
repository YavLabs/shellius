/**
 * testDbHelper.js — shared helper for integration tests that need a live
 * Postgres + Redis. NOT a test suite itself (no .test.js suffix, so jest
 * ignores it as a file to run).
 *
 * Tests that depend on this should call `dbReachable()` first and skip
 * (console.warn + return) when it resolves false, so `npm test` stays green
 * in environments without DATABASE_URL/REDIS configured (matching the
 * existing "smokeIt" pattern used elsewhere in this repo).
 */

import prisma from '../../config/db.js';

let cachedReachable = null;

export async function dbReachable() {
  if (cachedReachable !== null) return cachedReachable;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    cachedReachable = true;
  } catch {
    cachedReachable = false;
  }
  return cachedReachable;
}

let seq = 0;
function uniqueSuffix() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

/** Create a throwaway org for a single test run. */
export async function createTestOrg() {
  const suffix = uniqueSuffix();
  return prisma.organization.create({
    data: { name: `Auth Test Org ${suffix}`, slug: `auth-test-${suffix}` },
  });
}

/** Create a throwaway active user with a password hash for `password`. */
export async function createTestUser(orgId, overrides = {}) {
  const bcrypt = (await import('bcryptjs')).default;
  const suffix = uniqueSuffix();
  const password = overrides.password || 'CorrectHorse123!';
  const passwordHash = overrides.passwordHash !== undefined
    ? overrides.passwordHash
    : await bcrypt.hash(password, 4); // low rounds — tests only
  const user = await prisma.user.create({
    data: {
      orgId,
      email: overrides.email || `user-${suffix}@example.com`,
      name: overrides.name || 'Test User',
      passwordHash,
      role: overrides.role || 'member',
      status: overrides.status || 'active',
      ...overrides.data,
    },
  });
  return { ...user, _plainPassword: password };
}

export async function cleanupOrg(orgId) {
  if (!orgId) return;
  await prisma.refreshToken.deleteMany({ where: { user: { orgId } } });
  await prisma.userToken.deleteMany({ where: { user: { orgId } } });
  await prisma.auditLog.deleteMany({ where: { orgId } });
  await prisma.groupMembership.deleteMany({ where: { user: { orgId } } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.ssoConfig.deleteMany({ where: { orgId } });
  await prisma.mfaConfig.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
}

export default { dbReachable, createTestOrg, createTestUser, cleanupOrg };
