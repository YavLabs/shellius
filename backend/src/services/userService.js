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
import { isUnscoped, customerScopeWhere } from '../lib/scope.js';
import { isDisabledStatus } from '../lib/userStatus.js';
import { endOfDayInclusive } from '../utils/dateRange.js';

const ROLE_BRIEF = { select: { id: true, key: true, name: true, isSystem: true, baseRole: true, permissions: true } };

function strip(user) {
  if (!user) return user;
  const { passwordHash, mfaTotpSecretEnc, mfaTotpPendingEnc, mfaBackupCodes, ssoSub, assignedRole, customerScopes, groupMemberships, ...rest } = user;
  return {
    ...rest,
    ...(assignedRole !== undefined
      ? { roleInfo: assignedRole ? { id: assignedRole.id, key: assignedRole.key, name: assignedRole.name, isSystem: assignedRole.isSystem } : null }
      : {}),
    // Customer scope (docs/rbac/customer-scope-spec.md) — only present when the
    // caller asked for the relation (getUser). accessScope itself is a plain
    // column and survives the ...rest spread on every call, including listUsers,
    // so the UI can badge scoped users without a second query.
    ...(customerScopes !== undefined ? { customerIds: customerScopes.map((s) => s.customerId) } : {}),
    // Group membership — only present when the caller asked for the relation
    // (getUser). The LIST shape is unchanged.
    ...(groupMemberships !== undefined ? { groups: groupMemberships.map((m) => ({ id: m.group.id, name: m.group.name })) } : {}),
    mfaEnabled: !!(user.mfaTotpEnabled || user.mfaEmailEnabled || (user.mfaBackupCodes || []).length > 0),
  };
}

// Whitelisted sort keys — never pass sortBy straight into Prisma's orderBy.
const USER_SORTABLE = {
  name: (dir) => ({ name: dir }),
  email: (dir) => ({ email: dir }),
  role: (dir) => ({ role: dir }),
  status: (dir) => ({ status: dir }),
  lastLogin: (dir) => ({ lastLoginAt: dir }),
};

export async function listUsers(orgId, {
  page = 1,
  pageSize = 25,
  role,
  roleId,
  status,
  managerId,
  mfaEnabled,
  search,
  locked,
  lastLoginFrom,
  lastLoginTo,
  accessScope,
  groupId,
  sortBy,
  sortDir,
} = {}) {
  page = parseInt(page, 10) || 1;
  pageSize = Math.min(parseInt(pageSize, 10) || 25, 100);

  const where = { orgId, status: { not: 'deleted' } };
  if (role) where.role = role;
  if (roleId) where.roleId = roleId;
  if (status) where.status = status; // caller-supplied status overrides the default filter
  if (managerId) where.managerId = managerId;
  if (mfaEnabled !== undefined) where.mfaEnabled = mfaEnabled;
  if (accessScope) where.accessScope = accessScope;
  if (groupId) where.groupMemberships = { some: { groupId } };
  // Locked = lockedUntil in the future (the same rule the login flow uses).
  if (locked === true || locked === 'true') where.lockedUntil = { gt: new Date() };
  else if (locked === false || locked === 'false') {
    where.OR = (where.OR || []).concat([{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }]);
  }
  if (lastLoginFrom || lastLoginTo) {
    where.lastLoginAt = {};
    if (lastLoginFrom) where.lastLoginAt.gte = new Date(lastLoginFrom);
    if (lastLoginTo) where.lastLoginAt.lte = endOfDayInclusive(lastLoginTo);
  }
  if (search) {
    const searchOr = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
    // `search` and the locked=false OR both want the top-level OR key — AND
    // them together instead of letting one clobber the other.
    if (where.OR) {
      where.AND = [...(where.AND || []), { OR: where.OR }, { OR: searchOr }];
      delete where.OR;
    } else {
      where.OR = searchOr;
    }
  }

  const dir = sortDir === 'desc' ? 'desc' : 'asc';
  const orderBy = USER_SORTABLE[sortBy] ? USER_SORTABLE[sortBy](dir) : { createdAt: 'desc' };

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy,
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
      customerScopes: { select: { customerId: true } },
      groupMemberships: { include: { group: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
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

/**
 * Validate and normalize a customer-scope grant (`accessScope` +
 * `customerIds`) against the caller's own permission and scope. Shared by
 * `createUser` and `assignUserScope` so every path that can set scope
 * enforces the exact same rules (docs/rbac/customer-scope-spec.md §2.3-2.4):
 * every customerId must exist in the caller's org, and a caller who is
 * themselves scoped may only grant customers within their own scope.
 * `accessScope: 'ALL'` always normalizes to an empty set — those rows would
 * be dead weight, resolveScope() never reads them.
 *
 * @param {string} orgId
 * @param {{ permissions: Set<string> }|null} actor
 * @param {{ mode: 'all'|'customers', customerIds: string[] }|null} callerScope - req.scope
 * @param {'ALL'|'CUSTOMERS'} accessScope
 * @param {string[]} [customerIds]
 * @returns {Promise<string[]>} deduplicated, validated customer ids to store
 */
async function validateScopeGrant(orgId, actor, callerScope, accessScope, customerIds) {
  if (actor && !hasPermission(actor.permissions, 'users.assign_scope')) {
    throw new ApiError(403, "You don't have permission to assign customer scope", { code: 'PERMISSION_DENIED' });
  }
  const ids = accessScope === 'CUSTOMERS' ? [...new Set(customerIds || [])] : [];
  if (ids.length > 0) {
    // The caller's OWN scope is part of the existence check, not a separate
    // check afterwards. Answering "that customer exists, but you may not grant
    // it" would let a scoped admin enumerate every customer id in the org one
    // guess at a time; out-of-scope and nonexistent must be indistinguishable
    // (docs/rbac/customer-scope-spec.md §2.3.2).
    const found = await prisma.customer.findMany({
      where: { id: { in: ids }, orgId, AND: [customerScopeWhere(callerScope)] },
      select: { id: true },
    });
    if (found.length !== ids.length) throw new ApiError(404, 'One or more customers not found');
  }
  return ids;
}

/**
 * Validate a `groupIds` grant: every id must be a group in the caller's org
 * (404 otherwise, never a silent drop — same posture as `validateScopeGrant`).
 * Requires `groups.manage`, checked here rather than at the route so every
 * path that can move group membership (create, update) enforces the same
 * rule, mirroring how `users.assign_scope` is layered onto `createUser`/
 * `assignUserScope`.
 *
 * @param {string} orgId
 * @param {{ permissions: Set<string> }|null} actor
 * @param {string[]} [groupIds]
 * @returns {Promise<{ id: string, name: string }[]>} deduplicated, validated groups
 */
async function validateGroupIds(orgId, actor, groupIds) {
  if (actor && !hasPermission(actor.permissions, 'groups.manage')) {
    throw new ApiError(403, "You don't have permission to change group membership", { code: 'PERMISSION_DENIED' });
  }
  const ids = [...new Set(groupIds || [])];
  if (ids.length === 0) return [];
  const found = await prisma.group.findMany({ where: { id: { in: ids }, orgId }, select: { id: true, name: true } });
  if (found.length !== ids.length) throw new ApiError(404, 'One or more groups not found');
  return found;
}

/**
 * Replace a user's group memberships with the exact set named by
 * `groupIds`, transactionally, and audit the add/remove delta
 * (`user.groups.updated`) — same shape as `assignUserScope`/
 * `assignGroupScope`'s before/after audit entries.
 *
 * @param {string} orgId
 * @param {string} userId - target
 * @param {string[]} groupIds
 * @param {{ userId: string, permissions: Set<string> }|null} actor
 * @param {object} [meta] - { ipAddress, userAgent } for the audit entry
 * @returns {Promise<{ id: string, name: string }[]>} the resulting group set
 */
async function applyGroupMembership(orgId, userId, groupIds, actor, meta = {}) {
  const groups = await validateGroupIds(orgId, actor, groupIds);

  const before = await prisma.groupMembership.findMany({
    where: { userId, group: { orgId } },
    select: { group: { select: { id: true, name: true } } },
  });
  const beforeGroups = before.map((m) => m.group);
  const beforeIds = new Set(beforeGroups.map((g) => g.id));
  const afterIds = new Set(groups.map((g) => g.id));

  const added = groups.filter((g) => !beforeIds.has(g.id));
  const removed = beforeGroups.filter((g) => !afterIds.has(g.id));

  await prisma.$transaction([
    prisma.groupMembership.deleteMany({ where: { userId, group: { orgId } } }),
    ...(groups.length
      ? [
          prisma.groupMembership.createMany({
            data: groups.map((g) => ({ groupId: g.id, userId, addedById: actor?.userId || null })),
          }),
        ]
      : []),
  ]);

  if (actor && (added.length > 0 || removed.length > 0)) {
    await auditLog({
      orgId,
      actorId: actor.userId,
      action: 'user.groups.updated',
      resourceType: 'User',
      resourceId: userId,
      metadata: {
        added: added.map((g) => ({ id: g.id, name: g.name })),
        removed: removed.map((g) => ({ id: g.id, name: g.name })),
      },
      ...meta,
    });
  }

  return groups;
}

/**
 * @param {string} orgId
 * @param {object} data
 * @param {object|null} actor
 * @param {{ mode: 'all'|'customers', customerIds: string[] }|null} [callerScope] - req.scope;
 *   only consulted when `data.accessScope` is set (customer scope at creation).
 * @param {object} [meta] - { ipAddress, userAgent }; only used when `data.groupIds` is set.
 */
export async function createUser(orgId, data, actor, callerScope = null, meta = {}) {
  const { email, name, password, managerId, status, accessScope, customerIds, groupIds } = data;
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

  // Customer scope at creation (docs/rbac/customer-scope-spec.md) — optional,
  // same rules as PUT /:id/scope.
  let scopeCustomerIds = [];
  if (accessScope !== undefined) {
    if (role.baseRole === 'super_admin' && accessScope === 'CUSTOMERS') {
      throw new ApiError(400, 'Super admins are never scoped — they always see the whole organization');
    }
    scopeCustomerIds = await validateScopeGrant(orgId, actor, callerScope, accessScope, customerIds);
  }

  // Group membership at creation (docs/rbac/customer-scope-spec.md §2) —
  // optional, requires groups.manage; validated up front so a bad id fails
  // before the user is ever created (same posture as the scope grant above).
  let groups = [];
  if (groupIds !== undefined) {
    groups = await validateGroupIds(orgId, actor, groupIds);
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
        ...(accessScope !== undefined ? { accessScope } : {}),
      },
      include: { assignedRole: ROLE_BRIEF },
    });
    if (scopeCustomerIds.length > 0) {
      await prisma.userCustomerScope.createMany({
        data: scopeCustomerIds.map((customerId) => ({ userId: user.id, customerId })),
      });
    }
    if (groups.length > 0) {
      await prisma.groupMembership.createMany({
        data: groups.map((g) => ({ groupId: g.id, userId: user.id, addedById: actor?.userId || null })),
      });
      if (actor) {
        await auditLog({
          orgId,
          actorId: actor.userId,
          action: 'user.groups.updated',
          resourceType: 'User',
          resourceId: user.id,
          metadata: { added: groups.map((g) => ({ id: g.id, name: g.name })), removed: [] },
          ...meta,
        });
      }
    }
    return accessScope !== undefined ? { ...strip(user), customerIds: scopeCustomerIds } : strip(user);
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'Email already exists in organization');
    throw err;
  }
}

/**
 * Set a user's customer scope: `accessScope` plus the exact set of
 * `UserCustomerScope` rows (docs/rbac/customer-scope-spec.md). Requires
 * users.assign_scope (re-checked here via `validateScopeGrant` so direct
 * callers stay honest, not just the route). Rules enforced here:
 *   - every customerId must exist in the caller's org (404 otherwise)
 *   - the target must be in the caller's org (404)
 *   - a super_admin target can never be scoped (400) — they can edit their
 *     own scope, so enforcing it would be theatre
 *   - nobody may change their OWN scope (403), mirroring
 *     roleService.canActOnRole's no-self-escalation rule
 *   - a scoped caller may only grant customers inside their OWN scope
 *   - the customer rows are replaced transactionally
 *
 * @param {string} orgId
 * @param {string} userId - target
 * @param {{ accessScope: 'ALL'|'CUSTOMERS', customerIds?: string[] }} data
 * @param {{ userId: string, permissions: Set<string> }|null} actor
 * @param {{ mode: 'all'|'customers', customerIds: string[] }|null} [callerScope] - req.scope
 * @param {object} [meta] - { ipAddress, userAgent } for the audit entry
 * @returns {Promise<object>} stripped user with `customerIds`
 */
export async function assignUserScope(orgId, userId, data, actor, callerScope = null, meta = {}) {
  const { accessScope } = data;

  if (actor && actor.userId === userId) {
    throw new ApiError(403, 'You cannot change your own customer scope');
  }

  const target = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!target) throw new ApiError(404, 'User not found');
  if (target.role === 'super_admin') {
    throw new ApiError(400, 'Super admins are never scoped — they always see the whole organization');
  }

  const customerIds = await validateScopeGrant(orgId, actor, callerScope, accessScope, data.customerIds);

  const before = await prisma.userCustomerScope.findMany({
    where: { userId },
    include: { customer: { select: { id: true, name: true } } },
  });
  const afterCustomers = customerIds.length
    ? await prisma.customer.findMany({ where: { id: { in: customerIds }, orgId }, select: { id: true, name: true } })
    : [];

  const [updated] = await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { accessScope }, include: { assignedRole: ROLE_BRIEF } }),
    prisma.userCustomerScope.deleteMany({ where: { userId } }),
    ...(customerIds.length
      ? [prisma.userCustomerScope.createMany({ data: customerIds.map((customerId) => ({ userId, customerId })) })]
      : []),
  ]);

  if (actor) {
    await auditLog({
      orgId,
      actorId: actor.userId,
      action: 'user.scope.updated',
      resourceType: 'User',
      resourceId: userId,
      metadata: {
        accessScope,
        before: before.map((b) => ({ id: b.customer.id, name: b.customer.name })),
        after: afterCustomers.map((c) => ({ id: c.id, name: c.name })),
      },
      ...meta,
    });
  }

  return { ...strip(updated), customerIds };
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

  // Group membership (docs/rbac/customer-scope-spec.md §2) — optional,
  // requires groups.manage (checked in applyGroupMembership, not the route),
  // and is independent of the field updates above: it can be the only thing
  // this call changes.
  if (data.groupIds !== undefined) {
    await applyGroupMembership(orgId, userId, data.groupIds, actor, meta);
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
  //
  // Being disabled goes further than being re-roled: an account that is no
  // longer allowed in must also lose its signed certificates and standing
  // access requests, or it keeps SSH access to hosts for the rest of the
  // certificate's life.
  if (isDisabledStatus(updateData.status)) {
    await revokeAllAccessFor(orgId, userId, {
      reason: `Account ${updateData.status}`,
      sessionReason: 'account_disabled',
      revokedById: actor?.userId ?? null,
    });
  } else if (updateData.role !== undefined || updateData.status !== undefined) {
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

  // Revoke before deleting. Certificate.issuedToId is SetNull, so deleting
  // the user detaches their live certificates instead of ending them — they
  // would stay ACTIVE with no owner left to check, which is the one case
  // certificateService.verify can no longer reason about.
  await revokeAllAccessFor(orgId, userId, {
    reason: 'User deleted',
    sessionReason: 'account_deleted',
    revokedById: callerId,
  });

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

  // Only "no password yet" blocks a change — an account with a linked SSO
  // identity AND a password may change it (SSO-only accounts use
  // POST /api/auth/password/set instead).
  if (!user.passwordHash) {
    throw new ApiError(400, 'This account has no password yet — set one from your profile instead');
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
// Cutting off access
// ---------------------------------------------------------------------------

/**
 * Cut every live path this user has into the fleet.
 *
 * Revoking sessions alone is not enough. A certificate already signed by the
 * CA keeps authenticating on hosts until it expires — check-principals asks
 * whether the *certificate* is still good, and the answer stays yes for the
 * rest of the policy's maxSessionDuration. So a disabled account must have
 * its certificates and its standing access requests revoked too, not just
 * its browser sessions.
 *
 * Used by suspension, self soft-delete and SSO deprovisioning, so the three
 * can't drift apart.
 *
 * @param {string} orgId
 * @param {string} userId
 * @param {object} opts
 * @param {string} opts.reason        stored on the revoked access requests
 * @param {string} opts.sessionReason passed to authService.revokeAllSessions
 * @param {string|null} [opts.revokedById] actor recorded on the certificates
 * @returns {Promise<{accessRequests: number, certificates: number}>}
 */
export async function revokeAllAccessFor(orgId, userId, { reason, sessionReason, revokedById = null }) {
  const now = new Date();

  const [requests, certificates] = await Promise.all([
    prisma.accessRequest.updateMany({
      where: { requesterId: userId, orgId, status: { in: ['PENDING', 'APPROVED'] } },
      data: { status: 'REVOKED', revokedAt: now, revokedReason: reason },
    }),
    prisma.certificate.updateMany({
      where: { issuedToId: userId, orgId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: now, revokedById: revokedById ?? userId },
    }),
  ]);

  // Sign out everywhere AND end any live terminal sessions — a disabled
  // account must not keep an open shell.
  await authService.revokeAllSessions(userId, orgId, sessionReason);

  if (requests.count || certificates.count) {
    logger.info('userService.revokeAllAccessFor: standing access revoked', {
      userId,
      orgId,
      reason: sessionReason,
      accessRequests: requests.count,
      certificates: certificates.count,
    });
  }

  return { accessRequests: requests.count, certificates: certificates.count };
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

  await revokeAllAccessFor(orgId, userId, {
    reason: 'User deleted account',
    sessionReason: 'account_deleted',
  });
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

// ---------------------------------------------------------------------------
// Effective customer scope — explains WHY (for the UI), not just what
// (docs/rbac/customer-scope-spec.md §2, groups accessScope decision).
// ---------------------------------------------------------------------------

/**
 * Resolve and explain a user's effective customer scope: the same decision
 * `lib/scope.js#resolveScope` makes for request-time enforcement, but with
 * the "why" and every contributing source attached for the admin UI.
 * `sources` is always populated (direct grant + every group with its own
 * accessScope and customers), even when the top-level reason is `user_all`
 * or `group_all` — a caller widened past their own CUSTOMERS grant, or past
 * a specific group, should still be able to see what's "underneath" it.
 *
 * Priority mirrors resolveScope(): the user's own ALL wins outright, then
 * any ALL group, then the union, which may be empty.
 *
 * @param {string} orgId
 * @param {string} userId
 * @returns {Promise<{
 *   kind: 'all'|'customers',
 *   customerIds: string[],
 *   reason: 'user_all'|'group_all'|'union'|'empty',
 *   sources: {
 *     direct: { id: string, name: string }[],
 *     groups: { id: string, name: string, accessScope: 'ALL'|'CUSTOMERS', customers: { id: string, name: string }[] }[],
 *   },
 * }>}
 */
export async function getEffectiveScope(orgId, userId) {
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) throw new ApiError(404, 'User not found');

  const [directRows, memberships] = await Promise.all([
    prisma.userCustomerScope.findMany({
      where: { userId },
      include: { customer: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.groupMembership.findMany({
      where: { userId, group: { orgId } },
      include: {
        group: {
          include: { customerScopes: { include: { customer: { select: { id: true, name: true } } } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const direct = directRows.map((r) => ({ id: r.customer.id, name: r.customer.name }));
  const groups = memberships.map((m) => ({
    id: m.group.id,
    name: m.group.name,
    accessScope: m.group.accessScope,
    customers: m.group.customerScopes.map((s) => ({ id: s.customer.id, name: s.customer.name })),
  }));
  const sources = { direct, groups };

  // super_admin is never scoped, same as resolveScope().
  if (user.role === 'super_admin' || user.accessScope !== 'CUSTOMERS') {
    return { kind: 'all', customerIds: [], reason: 'user_all', sources };
  }

  const allGroup = groups.find((g) => g.accessScope === 'ALL');
  if (allGroup) {
    return { kind: 'all', customerIds: [], reason: 'group_all', sources };
  }

  const idSet = new Set([
    ...direct.map((c) => c.id),
    ...groups.filter((g) => g.accessScope === 'CUSTOMERS').flatMap((g) => g.customers.map((c) => c.id)),
  ]);
  const customerIds = [...idSet];

  return {
    kind: 'customers',
    customerIds,
    reason: customerIds.length > 0 ? 'union' : 'empty',
    sources,
  };
}
