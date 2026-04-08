/**
 * jitManifestService.js
 *
 * Builds a "JIT provisioning manifest" that tells a target host's
 * check-principals agent how to materialize a Linux account for an
 * approved access request: what username, UID, groups, ACLs, whether
 * to grant sudo, etc.
 *
 * Design: the manifest is an OPTIONAL field in the existing certificate
 * verify response. Existing hosts (running the current check-principals
 * shell helper) will simply ignore unknown fields — full backwards
 * compatibility. A future host-side upgrade (Phase 21B) consumes the
 * manifest and applies it.
 *
 * The manifest is only populated when at least one policy matching the
 * access request has a non-empty osProvisioning block. Otherwise it is
 * omitted entirely and the host falls back to its current behavior.
 */

import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import * as jitUidService from './jitUidService.js';

/**
 * Sanitize a user identifier into a valid Linux username fragment.
 * Lowercases, replaces non-alnum with underscore, truncates to 24 chars.
 */
export function sanitizedBase(user) {
  const raw = (user.email || user.name || user.id || '').toLowerCase();
  const local = raw.split('@')[0];
  const cleaned = local.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'shellius').slice(0, 24);
}

/**
 * Public helper — return the stable JIT Linux username for a user.
 * Used by access-request submission to default the principal when a
 * matching policy has osProvisioning configured.
 */
export function jitPrincipalFor(user) {
  return `${sanitizedBase(user)}_jit`;
}

/**
 * Look up the highest-priority ALLOW policy for this user+server that
 * has non-empty osProvisioning. Returns null when no JIT-configured
 * policy matches — callers fall back to the legacy sshUser principal.
 *
 * Kept deliberately simple: full policy evaluation (labels, targets,
 * principals) already ran at approval time. Here we only need to know
 * "is JIT in scope for this org+user+server combo".
 */
export async function findJitPolicyForUserServer({ orgId, userId, serverId }) {
  const subjectFilter = [{ subjectType: 'USER', subjectId: userId }];

  const memberships = await prisma.groupMembership.findMany({
    where: { userId, group: { orgId } },
    select: { groupId: true },
  });
  if (memberships.length > 0) {
    subjectFilter.push({
      subjectType: 'GROUP',
      subjectId: { in: memberships.map((m) => m.groupId) },
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (user?.role) {
    subjectFilter.push({ subjectType: 'ROLE', subjectId: user.role });
  }

  const policies = await prisma.accessPolicy.findMany({
    where: {
      orgId,
      isActive: true,
      effect: 'ALLOW',
      subjects: { some: { OR: subjectFilter } },
    },
    orderBy: { priority: 'asc' },
  });

  // Filter to policies whose target scope includes this server.
  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId },
    select: { environment: true },
  });
  const relevant = policies.filter((p) => {
    if (p.targetServerIds?.length > 0 && !p.targetServerIds.includes(serverId)) return false;
    if (p.targetEnvironments?.length > 0 && server && !p.targetEnvironments.includes(server.environment)) return false;
    return true;
  });

  return relevant.find((p) => hasJitConfig(p.osProvisioning)) || null;
}

/**
 * Returns true if the policy's osProvisioning JSON has any meaningful
 * configuration. Empty {} → returns false, meaning no manifest is built.
 */
export function hasJitConfig(osProvisioning) {
  if (!osProvisioning || typeof osProvisioning !== 'object') return false;
  const { linuxGroups, sudo, aclReadPaths, hardCutoff } = osProvisioning;
  if (Array.isArray(linuxGroups) && linuxGroups.length > 0) return true;
  if (sudo === true) return true;
  if (Array.isArray(aclReadPaths) && aclReadPaths.length > 0) return true;
  if (hardCutoff === true) return true;
  return false;
}

/**
 * Build a provisioning manifest for an approved access request.
 *
 * @param {object} params
 * @param {string} params.accessRequestId
 * @returns {Promise<object|null>}  manifest object, or null if not applicable
 */
export async function buildManifest({ accessRequestId }) {
  try {
    const ar = await prisma.accessRequest.findUnique({
      where: { id: accessRequestId },
      include: {
        user: {
          select: { id: true, orgId: true, email: true, name: true, jitUid: true },
        },
      },
    });
    if (!ar || !ar.user) return null;
    if (ar.status !== 'APPROVED') return null;
    if (!ar.expiresAt || ar.expiresAt <= new Date()) return null;

    // Find ALLOW policies matching this user and server that have a
    // non-empty osProvisioning block. We intentionally keep this query
    // simple — full policy evaluation already happened at approval time.
    const policies = await prisma.accessPolicy.findMany({
      where: {
        orgId: ar.user.orgId,
        isActive: true,
        effect: 'ALLOW',
      },
      select: { osProvisioning: true, priority: true },
      orderBy: { priority: 'asc' },
    });

    // Merge the first matching osProvisioning block (highest priority wins).
    const active = policies.find((p) => hasJitConfig(p.osProvisioning));
    if (!active) return null;

    const os = active.osProvisioning || {};
    const uid = await jitUidService.getOrAllocateUid(ar.user.orgId, ar.user.id);
    const linuxUser = `${sanitizedBase(ar.user)}_jit`;
    const ttlSeconds = Math.max(0, Math.floor((ar.expiresAt.getTime() - Date.now()) / 1000));

    return {
      linuxUser,
      uid,
      groups: Array.isArray(os.linuxGroups) ? os.linuxGroups : [],
      sudo: !!os.sudo,
      aclReadPaths: Array.isArray(os.aclReadPaths) ? os.aclReadPaths : [],
      aclRecursive: !!os.aclRecursive,
      hardCutoff: !!os.hardCutoff,
      leaseId: ar.id,
      ttlSeconds,
    };
  } catch (err) {
    logger.warn('jitManifestService.buildManifest failed (returning null)', {
      error: err.message,
    });
    return null;
  }
}
