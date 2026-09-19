import bcrypt from 'bcryptjs';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import * as terminalService from './terminalService.js';
import { cleanupPolicySubjects } from './policyService.js';
import * as authService from './authService.js';
import { parseAvatarDataUrl } from '../utils/avatar.js';
import { log as auditLog } from './auditService.js';
import { assertCanActOnRole, getSystemRole, resolveRole, hasPermission } from './roleService.js';

const ROLE_BRIEF = { select: { id: true, key: true, name: true, isSystem: true, baseRole: true, permissions: true } };

function strip(user) {
  if (!user) return user;
  const { passwordHash, mfaTotpSecretEnc, mfaTotpPendingEnc, mfaBackupCodes, ssoSub, assignedRole, ...rest } = user;
  return {
    ...rest,
    ...(assignedRole !== undefined
      ? { roleInfo: assignedRole ? { id: assignedRole.id, key: assignedRole.key, name: assignedRole.name, isSystem: assignedRole.isSystem } : null }
      : {}),
    mfaEnabled: !!(user.mfaTotpEnabled || user.mfaEmailEnabled || (user.mfaBackupCodes || []).length > 0),
  };
}

export async function listUsers(orgId, { page = 1, pageSize = 25, role, roleId, status, managerId, search } = {}) {
  page = parseInt(page, 10) || 1;
  pageSize = Math.min(parseInt(pageSize, 10) || 25, 100);

  const where = { orgId, status: { not: 'deleted' } };
  if (role) where.role = role;
  if (roleId) where.roleId = roleId;
  if (status) where.status = status; // caller-supplied status overrides the default filter
  if (managerId) where.managerId = managerId;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: { manager: { select: { id: true, name: true } }, assignedRole: ROLE_BRIEF },
    }),
    prisma.user.count({ where }),
  ]);

  return { items: items.map(strip), total, page, pageSize };
}

export async function getUser(orgId, userId) {
  const user = await prisma.user.findFirst({
    where: { id: userId, orgId },
    include: {
      manager: { select: { id: true, name: true, email: true } },
      directReports: { select: { id: true, name: true, email: true, role: true, status: true } },
      assignedRole: ROLE_BRIEF,
    },
  });
  if (!user) throw new ApiError(404, 'User not found');
  return strip(user);
}

/**
 * Resolve the role a create/update asks for: `roleId` (id or key) wins over
 * the legacy `role` (tier key). Returns null when neither was given.
 */
async function requestedRole(orgId, data) {
  const ref = data.roleId || data.role;
  if (!ref) return null;
  const role = await resolveRole(orgId, ref);
  if (!role) throw new ApiError(400, 'Unknown role');
  return role;
}

/**
 * Throws unless `actor` may manage `target`: you can only act on a user whose
 * role you could assign yourself (its permissions are a subset of yours and
 * its base tier isn't above yours). Self is always allowed here — callers
 * restrict what self may change.
 */
export async function assertCanManageUser(orgId, actor, target, what = 'manage this user') {
  if (!actor || target.id === actor.userId) return;
  const role = target.assignedRole || (target.roleId ? await prisma.role.findFirst({ where: { id: target.roleId, orgId } }) : null);
  assertCanActOnRole(actor, role || { baseRole: target.role, permissions: [], isSystem: false }, what);
}

async function activeSuperAdminCount(orgId, excludeUserId) {
  return prisma.user.count({
    where: { orgId, role: 'super_admin', status: 'active', deletedAt: null, NOT: { id: excludeUserId } },
  });
}

export async function createUser(orgId, data, actor) {
  const { email, name, password, managerId, status } = data;
  // password is optional when the invite flow is used
  if (!email || !name) {
    throw new ApiError(400, 'email and name are required');
  }

  const member = await getSystemRole(orgId, 'member');
  const role = (await requestedRole(orgId, data)) || member;
  if (actor && role.id !== member.id) {
    if (!hasPermission(actor.permissions, 'users.assign_role')) {
      throw new ApiError(403, "You don't have permission to assign roles", { code: 'PERMISSION_DENIED' });
    }
    assertCanActOnRole(actor, role, 'assign this role');
  }

  if (managerId) {
    const mgr = await prisma.user.findFirst({ where: { id: managerId, orgId } });
    if (!mgr) throw new ApiError(400, 'Manager not found in organization');
  }

  const passwordHash = password ? await bcrypt.hash(password, config.bcryptRounds) : null;
  const userStatus = status || (password ? 'active' : 'invited');

  try {
    const user = await prisma.user.create({
      data: {
        orgId,
        email,
        name,
        passwordHash,
        role: role.baseRole,
        roleId: role.id,
        status: userStatus,
        managerId: managerId || null,
      },
      include: { assignedRole: ROLE_BRIEF },
    });
    return strip(user);
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'Email already exists in organization');
    throw err;
  }
}

async function wouldCreateCycle(orgId, userId, newManagerId) {
  let current = newManagerId;
  const seen = new Set();
  while (current) {
    if (current === userId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const m = await prisma.user.findFirst({
      where: { id: current, orgId },
      select: { managerId: true },
    });
    if (!m) return false;
    current = m.managerId;
  }
  return false;
}

/**
 * Update a user.
 *
 * `actor` is { userId, tier, permissions, roleId } (roleService.actorFromReq)
 * or null for trusted internal callers. Self-service may only change `name`;
 * everything else needs the matching permission AND the right to manage the
 * target (F-01): users.update (name/email/manager/avatar), users.assign_role
 * (roleId/role), users.suspend (status). A password can't be set for another
 * user — send a reset link instead. The last active super admin can't be
 * demoted or suspended.
 */
export async function updateUser(orgId, userId, data, actor, meta = {}) {
  const existing = await prisma.user.findFirst({ where: { id: userId, orgId }, include: { assignedRole: ROLE_BRIEF } });
  if (!existing) throw new ApiError(404, 'User not found');
  const isSelf = actor && actor.userId === userId;
  const need = (perm, field) => {
    if (actor && !hasPermission(actor.permissions, perm)) {
      throw new ApiError(403, `You don't have permission to change '${field}'`, { code: 'PERMISSION_DENIED' });
    }
  };

  if (actor && isSelf) {
    const bad = Object.keys(data).filter((k) => data[k] !== undefined && k !== 'name');
    if (bad.length > 0) throw new ApiError(403, `You cannot change '${bad[0]}' on your own account here`);
  }
  if (actor && !isSelf) await assertCanManageUser(orgId, actor, existing, 'edit this user');
  if (data.password !== undefined && actor) {
    throw new ApiError(400, "Passwords can't be set for other users — send a password reset link instead");
  }

  const updateData = {};
  const changes = {};

  for (const field of ['name', 'email', 'avatarUrl']) {
    if (data[field] !== undefined && data[field] !== existing[field]) {
      if (!isSelf) need('users.update', field);
      updateData[field] = data[field];
      changes[field] = field === 'avatarUrl' ? true : { from: existing[field], to: data[field] };
    }
  }

  const newRole = await requestedRole(orgId, data);
  if (newRole && newRole.id !== existing.roleId) {
    need('users.assign_role', 'role');
    if (actor) assertCanActOnRole(actor, newRole, 'assign this role');
    if (existing.role === 'super_admin' && newRole.baseRole !== 'super_admin' && existing.status === 'active') {
      if ((await activeSuperAdminCount(orgId, userId)) === 0) {
        throw new ApiError(409, 'This is the only active super admin — make someone else super admin first');
      }
    }
    updateData.roleId = newRole.id;
    updateData.role = newRole.baseRole;
    changes.role = { from: existing.assignedRole?.name || existing.role, to: newRole.name };
  }

  if (data.status !== undefined && data.status !== existing.status) {
    need('users.suspend', 'status');
    if (existing.role === 'super_admin' && existing.status === 'active') {
      if ((await activeSuperAdminCount(orgId, userId)) === 0) {
        throw new ApiError(409, 'This is the only active super admin — it cannot be suspended');
      }
    }
    updateData.status = data.status;
    changes.status = { from: existing.status, to: data.status };
  }

  if (data.managerId !== undefined) {
    if (data.managerId === null) {
      updateData.managerId = null;
    } else {
      if (data.managerId === userId) throw new ApiError(400, 'User cannot be their own manager');
      const mgr = await prisma.user.findFirst({ where: { id: data.managerId, orgId } });
      if (!mgr) throw new ApiError(400, 'Manager not found in organization');
      const cycle = await wouldCreateCycle(orgId, userId, data.managerId);
      if (cycle) throw new ApiError(400, 'Circular manager reference detected');
      updateData.managerId = data.managerId;
    }
    if (updateData.managerId !== undefined && updateData.managerId !== existing.managerId) {
      if (!isSelf) need('users.update', 'managerId');
      changes.managerId = { from: existing.managerId, to: updateData.managerId };
    } else {
      delete updateData.managerId;
    }
  }

  // Trusted internal callers (actor === null, e.g. seed) may still set one.
  if (data.password && !actor) {
    updateData.passwordHash = await bcrypt.hash(data.password, config.bcryptRounds);
  }

  if (Object.keys(updateData).length === 0) return strip(existing);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: updateData,
    include: { assignedRole: ROLE_BRIEF },
  });

  if (actor && Object.keys(changes).length > 0) {
    const action = changes.role ? 'user.role_changed' : changes.status ? 'user.status_changed' : 'user.updated';
    await auditLog({
      orgId,
      actorId: actor.userId,
      action,
      resourceType: 'User',
      resourceId: userId,
      metadata: { changes },
      ...meta,
    });
  }

  // Role or status changes must take effect immediately — kill every
  // outstanding session/access-token for the affected user rather than
  // waiting for their tokens to naturally expire.
  if (updateData.role !== undefined || updateData.status !== undefined) {
    await authService.revokeAllSessions(userId, orgId, updateData.status !== undefined ? 'account_disabled' : 'role_changed');
  }

  return strip(updated);
}

// ---------------------------------------------------------------------------
// Admin: unlock a locked-out account
// ---------------------------------------------------------------------------

export async function unlockUser(orgId, userId, actor = null) {
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) throw new ApiError(404, 'User not found');
  await assertCanManageUser(orgId, actor, user, 'unlock this user');
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null },
  });
  return strip(updated);
}

// ---------------------------------------------------------------------------
// Admin: revoke every session for a user ("sign out everywhere")
// ---------------------------------------------------------------------------

export async function adminRevokeSessions(orgId, userId, actor = null) {
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) throw new ApiError(404, 'User not found');
  await assertCanManageUser(orgId, actor, user, 'sign this user out');
  await authService.revokeAllSessions(userId, orgId, 'admin_revoked');
  return { success: true };
}

/** Dependents handled/removed when this user is hard-deleted (for the dialog). */
export async function getUserDeleteImpact(orgId, userId) {
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) throw new ApiError(404, 'User not found');

  const [superAdminCount, activeSessions, directReports, pendingRequests, groupMemberships, activeCerts, policyRefs, managers] =
    await Promise.all([
      prisma.user.count({ where: { orgId, role: 'super_admin', status: { not: 'deleted' } } }),
      prisma.session.count({ where: { orgId, userId, status: 'ACTIVE' } }),
      prisma.user.findMany({ where: { orgId, managerId: userId }, select: { id: true, name: true, email: true } }),
      prisma.accessRequest.count({ where: { orgId, requesterId: userId, status: { in: ['PENDING', 'APPROVED'] } } }),
      prisma.groupMembership.count({ where: { userId } }),
      prisma.certificate.count({ where: { orgId, issuedToId: userId, status: 'ACTIVE' } }),
      prisma.policySubject.count({ where: { subjectType: 'USER', subjectId: userId } }),
      prisma.user.findMany({
        where: { orgId, status: { not: 'deleted' }, id: { not: userId } },
        select: { id: true, name: true, email: true },
        orderBy: { name: 'asc' },
      }),
    ]);

  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    isLastSuperAdmin: user.role === 'super_admin' && superAdminCount <= 1,
    activeSessions,
    directReports,
    directReportCount: directReports.length,
    pendingRequests,
    groupMemberships,
    activeCertificates: activeCerts,
    policyReferences: policyRefs,
    availableManagers: managers,
  };
}

/**
 * Hard-delete a user. Guards the last super_admin, force-terminates live
 * sessions, optionally reassigns direct reports to another manager, removes
 * orphan policy-subject rows (polymorphic, no cascade), then deletes — which
 * cascades sessions, access requests, group memberships and tokens (and
 * the user's personal vault: identities, keys, My hosts), and
 * SetNulls audit-log actor / issued certificates.
 *
 * @param {object} [options] - { reassignReportsTo?: string }
 */
export async function deleteUser(orgId, userId, options = {}, callerId = null, actor = null) {
  const existing = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!existing) throw new ApiError(404, 'User not found');
  await assertCanManageUser(orgId, actor, existing, 'delete this user');

  if (existing.role === 'super_admin') {
    const superAdminCount = await prisma.user.count({
      where: { orgId, role: 'super_admin', status: { not: 'deleted' } },
    });
    if (superAdminCount <= 1) {
      throw new ApiError(409, 'Cannot delete the only super_admin in the organization');
    }
  }

  // Validate reassignment target before any destructive work.
  const reassignTo = options.reassignReportsTo;
  if (reassignTo) {
    if (reassignTo === userId) throw new ApiError(400, 'Cannot reassign reports to the user being deleted');
    const target = await prisma.user.findFirst({ where: { id: reassignTo, orgId, status: { not: 'deleted' } } });
    if (!target) throw new ApiError(400, 'Reassignment target manager not found');
  }

  await terminalService.terminateActiveSessionsFor(orgId, { userId }, callerId);

  await prisma.$transaction(async (tx) => {
    if (reassignTo) {
      await tx.user.updateMany({ where: { orgId, managerId: userId }, data: { managerId: reassignTo } });
    }
    await cleanupPolicySubjects('USER', userId, tx);
    // Personal vault (docs/personal-vault.md) goes with its owner. Explicit
    // order: identities reference keys with ON DELETE RESTRICT.
    await tx.personalHost.deleteMany({ where: { orgId, ownerId: userId } });
    await tx.credential.deleteMany({ where: { orgId, ownerId: userId } });
    await tx.sshKey.deleteMany({ where: { orgId, ownerId: userId } });
    await tx.user.delete({ where: { id: userId } });
  });

  logger.info('userService.deleteUser: user hard-deleted', { orgId, userId, reassignTo: reassignTo || null });
  return { success: true };
}

const SSH_PREFIXES = ['ssh-rsa ', 'ssh-ed25519 ', 'ecdsa-sha2-'];

export async function uploadSshKey(orgId, userId, publicKey) {
  if (typeof publicKey !== 'string') throw new ApiError(400, 'publicKey must be a string');
  const trimmed = publicKey.trim();
  if (trimmed.length < 20 || trimmed.length > 8192) {
    throw new ApiError(400, 'Invalid SSH key length');
  }
  const hasPrefix = SSH_PREFIXES.some((p) => trimmed.startsWith(p));
  if (!hasPrefix) throw new ApiError(400, 'Unsupported SSH key type');
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || !parts[1]) throw new ApiError(400, 'Invalid SSH key format');

  const existing = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!existing) throw new ApiError(404, 'User not found');

  await prisma.user.update({ where: { id: userId }, data: { sshPublicKey: trimmed } });
  return { success: true };
}

export async function removeSshKey(orgId, userId) {
  const existing = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!existing) throw new ApiError(404, 'User not found');
  await prisma.user.update({ where: { id: userId }, data: { sshPublicKey: null } });
  return { success: true };
}

export async function getDirectReports(orgId, managerId) {
  const users = await prisma.user.findMany({
    where: { orgId, managerId },
    orderBy: { name: 'asc' },
  });
  return users.map(strip);
}

// ---------------------------------------------------------------------------
// Profile: update name only
// ---------------------------------------------------------------------------

/**
 * Update the calling user's name. Only 'name' is allowed via this function
 * (email and role changes go through updateUser with admin privileges).
 *
 * @param {string} userId
 * @param {string} name
 * @returns {Promise<object>} stripped user
 */
export async function updateProfile(userId, name) {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) throw new ApiError(404, 'User not found');
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { name },
  });
  return strip(updated);
}

// ---------------------------------------------------------------------------
// Avatar upload/removal (self-service)
// ---------------------------------------------------------------------------

/**
 * Set the calling user's avatar from a strictly-validated base64 data URL.
 * Never stores anything that fails MIME/magic-byte/size checks — see
 * utils/avatar.js. Stored verbatim as the `data:` URL (User.avatarUrl is a
 * plain string column); SSO-derived avatar URLs are plain https URLs, so a
 * `data:` prefix unambiguously marks "user uploaded a custom avatar" for
 * login flows that would otherwise overwrite it from the IdP picture.
 *
 * @param {string} userId
 * @param {string} dataUrl
 * @returns {Promise<object>} stripped user
 */
export async function setAvatar(userId, dataUrl) {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) throw new ApiError(404, 'User not found');

  const { dataUrl: normalized } = parseAvatarDataUrl(dataUrl);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl: normalized },
  });
  logger.info('userService.setAvatar: avatar updated', { userId, bytes: normalized.length });
  return strip(updated);
}

/**
 * Clear the calling user's avatar (reverts to the UI's default initials
 * avatar; does not restore an SSO-provided picture).
 *
 * @param {string} userId
 * @returns {Promise<object>} stripped user
 */
export async function clearAvatar(userId) {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) throw new ApiError(404, 'User not found');

  const updated = await prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
  logger.info('userService.clearAvatar: avatar removed', { userId });
  return strip(updated);
}

// ---------------------------------------------------------------------------
// Password change (local accounts only)
// ---------------------------------------------------------------------------

/**
 * Change a local user's password after verifying the current one. Revokes
 * every other session (bumping sessionsValidFrom invalidates ALL outstanding
 * access tokens, including the caller's), then mints a fresh token pair so
 * the caller isn't logged out by their own request.
 * Throws 400 if this is an SSO account or the current password is wrong.
 *
 * @param {string} userId
 * @param {string} currentPassword
 * @param {string} newPassword
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<{ accessToken: string, refreshToken: string }>}
 */
export async function changePassword(userId, currentPassword, newPassword, ipAddress, userAgent) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'User not found');

  if (!user.passwordHash || user.ssoProvider) {
    throw new ApiError(400, 'Password change is not available for SSO accounts');
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new ApiError(400, 'Current password is incorrect');

  const newHash = await bcrypt.hash(newPassword, config.bcryptRounds);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: newHash,
      passwordChangedAt: new Date(),
    },
  });

  await authService.revokeAllSessions(userId, user.orgId, 'password_changed');
  const session = await authService.issueSession(updated, ipAddress, userAgent, 'web');
  return { accessToken: session.accessToken, refreshToken: session.refreshToken };
}

// ---------------------------------------------------------------------------
// GDPR data export
// ---------------------------------------------------------------------------

/**
 * Assemble a GDPR-compliant export for a user.
 * Strips secrets (passwordHash, ssoSub, signedCert).
 *
 * @param {string} orgId
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function exportUserData(orgId, userId) {
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) throw new ApiError(404, 'User not found');

  const [accessRequests, certificates, sessions, auditLogs] = await Promise.all([
    prisma.accessRequest.findMany({
      where: { requesterId: userId, orgId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.certificate.findMany({
      where: { issuedToId: userId, orgId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        serial: true,
        type: true,
        keyId: true,
        principals: true,
        publicKey: true,
        // signedCert intentionally omitted — never export cert contents
        validAfter: true,
        validBefore: true,
        status: true,
        revokedAt: true,
        createdAt: true,
      },
    }),
    prisma.session.findMany({
      where: { userId, orgId },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        serverId: true,
        sessionType: true,
        status: true,
        clientIp: true,
        startedAt: true,
        endedAt: true,
        durationSeconds: true,
        // recordingPath excluded — internal server path
      },
    }),
    prisma.auditLog.findMany({
      where: { actorId: userId, orgId },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  // Strip sensitive fields from the user object
  const { passwordHash, ssoSub, ...safeUser } = user;

  // Convert BigInt serials to string to allow JSON serialisation
  const safeCertificates = certificates.map((c) => ({
    ...c,
    serial: c.serial != null ? String(c.serial) : null,
  }));

  return {
    exportedAt: new Date().toISOString(),
    user: safeUser,
    accessRequests,
    certificates: safeCertificates,
    sessions,
    auditLogs,
  };
}

// ---------------------------------------------------------------------------
// Soft-delete (self-service)
// ---------------------------------------------------------------------------

/**
 * Soft-delete the calling user's account.
 * - Rejects if already deleted (409)
 * - Rejects if the only super_admin in the org (409)
 * - Sets status='deleted', deletedAt=now
 * - Revokes PENDING+APPROVED access requests
 * - Revokes ACTIVE certificates
 * - Deletes all refresh tokens
 *
 * @param {string} orgId
 * @param {string} userId
 * @returns {Promise<void>}
 */
export async function softDeleteSelf(orgId, userId) {
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) throw new ApiError(404, 'User not found');

  if (user.status === 'deleted') {
    throw new ApiError(409, 'Account is already deleted');
  }

  // Guard: must not be the only super_admin
  if (user.role === 'super_admin') {
    const superAdminCount = await prisma.user.count({
      where: { orgId, role: 'super_admin', status: { not: 'deleted' } },
    });
    if (superAdminCount <= 1) {
      throw new ApiError(409, 'Cannot delete the only super_admin in the organization');
    }
  }

  const now = new Date();

  // Revoke PENDING and APPROVED access requests
  await prisma.accessRequest.updateMany({
    where: {
      requesterId: userId,
      orgId,
      status: { in: ['PENDING', 'APPROVED'] },
    },
    data: {
      status: 'REVOKED',
      revokedAt: now,
      revokedReason: 'User deleted account',
    },
  });

  // Revoke ACTIVE certificates
  await prisma.certificate.updateMany({
    where: {
      issuedToId: userId,
      orgId,
      status: 'ACTIVE',
    },
    data: {
      status: 'REVOKED',
      revokedAt: now,
      revokedById: userId,
    },
  });

  // Sign out everywhere AND end any live terminal sessions (a deleted
  // account must not keep an open shell), then drop the refresh tokens.
  await authService.revokeAllSessions(userId, orgId, 'account_deleted');
  await prisma.refreshToken.deleteMany({ where: { userId } });

  // Mark user as deleted
  await prisma.user.update({
    where: { id: userId },
    data: { status: 'deleted', deletedAt: now },
  });

  logger.info('userService.softDeleteSelf: user soft-deleted', { userId, orgId });
}

// ---------------------------------------------------------------------------
// Self-service registration helpers
// ---------------------------------------------------------------------------

/**
 * Create a user in the pending_verification state for the self-registration flow.
 * The caller is responsible for validating that self-registration is enabled on
 * the org and that no duplicate email exists before calling this function.
 *
 * @param {string} orgId
 * @param {{ email: string, name: string, passwordHash: string }} data
 * @returns {Promise<object>} stripped user row
 */
export async function createPendingUser(orgId, { email, name, passwordHash }) {
  const member = await getSystemRole(orgId, 'member');
  try {
    const user = await prisma.user.create({
      data: {
        orgId,
        email,
        name,
        passwordHash,
        role: 'member',
        roleId: member.id,
        status: 'pending_verification',
        passwordChangedAt: new Date(),
      },
    });
    return strip(user);
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'Email already exists in organization');
    throw err;
  }
}

/**
 * Flip a user's status from pending_verification to active.
 * Used by the verify-email flow after the one-time token is consumed.
 *
 * @param {string} userId
 * @returns {Promise<object>} stripped user row
 */
export async function markEmailVerified(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.status !== 'pending_verification') {
    throw new ApiError(400, 'Account is not pending verification');
  }
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { status: 'active' },
  });
  return strip(updated);
}

// ---------------------------------------------------------------------------
// User preferences
// ---------------------------------------------------------------------------

const ALLOWED_PREF_KEYS = ['emailNotifications', 'expiringSoonAlerts'];

/**
 * Return the preferences object for a user.
 *
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function getPreferences(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  if (!user) throw new ApiError(404, 'User not found');
  return (user.preferences && typeof user.preferences === 'object') ? user.preferences : {};
}

/**
 * Merge validated preference updates into the existing preferences object.
 * Only allow-listed keys are accepted.
 *
 * @param {string} userId
 * @param {object} data - only keys in ALLOWED_PREF_KEYS are applied
 * @returns {Promise<object>} the new merged preferences
 */
export async function updatePreferences(userId, data) {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  if (!existing) throw new ApiError(404, 'User not found');

  const current = (existing.preferences && typeof existing.preferences === 'object')
    ? existing.preferences
    : {};

  const patch = {};
  for (const key of ALLOWED_PREF_KEYS) {
    if (data[key] !== undefined) patch[key] = data[key];
  }

  const merged = { ...current, ...patch };

  await prisma.user.update({
    where: { id: userId },
    data: { preferences: merged },
  });

  return merged;
}
