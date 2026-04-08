/**
 * jitUidService.js
 *
 * Atomic allocator for per-org JIT Linux UIDs in the reserved range
 * 70000-79999. Each Shellius user gets a stable UID assigned the first
 * time they receive a JIT provisioning manifest; subsequent allocations
 * return the same UID so file ownership is consistent across every
 * target host and across reconnects.
 *
 * UIDs are scoped per org: the same numeric UID may be reused in two
 * different organizations (which don't share targets anyway).
 */

import prisma from '../config/db.js';
import logger from '../utils/logger.js';

const MIN_UID = 70000;
const MAX_UID = 79999;

/**
 * Returns the stable per-org JIT UID for a user, allocating a new one
 * on first call. Idempotent — subsequent calls for the same user return
 * the same UID.
 *
 * @param {string} orgId
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function getOrAllocateUid(orgId, userId) {
  // Fast path: user already has a UID.
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { jitUid: true },
  });
  if (!existing) {
    const err = new Error('User not found');
    err.statusCode = 404;
    err.errorCode = 'USER_NOT_FOUND';
    throw err;
  }
  if (existing.jitUid != null) return existing.jitUid;

  // Allocate: find the current max UID for this org and add 1. We use
  // an advisory lock on the org to serialize concurrent allocators and
  // avoid a race on max+1. Postgres advisory locks are released on txn
  // commit.
  return prisma.$transaction(async (tx) => {
    // Hash the orgId into a stable 32-bit integer for pg_advisory_xact_lock.
    // The classifier is a second 32-bit int so we don't collide with other
    // advisory-lock users in the codebase.
    const classifier = 0x4a495455; // "JITU"
    const lockKey = hashOrgId(orgId);
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1, $2)`, classifier, lockKey);

    // Re-check inside the txn to avoid double-allocation if another
    // caller beat us to the lock.
    const reRead = await tx.user.findUnique({
      where: { id: userId },
      select: { jitUid: true },
    });
    if (reRead?.jitUid != null) return reRead.jitUid;

    const max = await tx.user.aggregate({
      where: { orgId, jitUid: { not: null } },
      _max: { jitUid: true },
    });
    const next = (max._max.jitUid ?? MIN_UID - 1) + 1;
    if (next > MAX_UID) {
      const err = new Error('JIT UID range exhausted for org');
      err.statusCode = 500;
      err.errorCode = 'JIT_UID_RANGE_EXHAUSTED';
      throw err;
    }
    if (next < MIN_UID) {
      // Defensive — shouldn't happen given the default.
      throw new Error(`Computed UID ${next} below minimum ${MIN_UID}`);
    }

    await tx.user.update({ where: { id: userId }, data: { jitUid: next } });
    logger.info('jitUidService: allocated UID', { orgId, userId, uid: next });
    return next;
  });
}

/**
 * Map an orgId (cuid string) to a stable signed 32-bit integer suitable
 * for pg_advisory_xact_lock. We use a simple FNV-1a hash — collisions
 * are fine here since the classifier scopes the lock to JIT allocation
 * only and the worst case is brief serialization between two orgs.
 */
function hashOrgId(orgId) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < orgId.length; i++) {
    hash ^= orgId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to signed 32-bit int (Postgres advisory lock keys are int4).
  return hash | 0;
}
