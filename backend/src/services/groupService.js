import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { cleanupPolicySubjects } from './policyService.js';
import { customerScopeWhere } from '../lib/scope.js';
import { log as auditLog } from './auditService.js';
import { hasPermission } from './roleService.js';

// Lean user DTO used everywhere a user relation is embedded in a response —
// see docs/auth-hardening.md Revision 2 "Avatars".
const USER_DTO_SELECT = { id: true, name: true, email: true, avatarUrl: true };

export async function listGroups(orgId) {
  const groups = await prisma.group.findMany({
    where: { orgId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { memberships: true } } },
  });
  return groups;
}

export async function getGroup(orgId, groupId) {
  const group = await prisma.group.findFirst({
    where: { id: groupId, orgId },
    include: {
      memberships: {
        include: { user: { select: USER_DTO_SELECT }, addedBy: { select: USER_DTO_SELECT } },
        orderBy: { createdAt: 'asc' },
      },
      // Customer scope (docs/rbac/customer-scope-spec.md) — additive with each
      // member's own scope, only consulted for members whose accessScope is
      // CUSTOMERS (lib/scope.js resolveScope).
      customerScopes: { select: { customerId: true } },
    },
  });
  if (!group) throw new ApiError(404, 'Group not found');
  const { customerScopes, ...rest } = group;
  return { ...rest, customerIds: customerScopes.map((s) => s.customerId) };
}

export async function createGroup(orgId, { name, description }) {
  if (!name || typeof name !== 'string') throw new ApiError(400, 'name is required');
  try {
    return await prisma.group.create({
      data: { orgId, name, description: description || null },
    });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'Group name already exists');
    throw err;
  }
}

export async function updateGroup(orgId, groupId, data) {
  const existing = await prisma.group.findFirst({ where: { id: groupId, orgId } });
  if (!existing) throw new ApiError(404, 'Group not found');
  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  try {
    return await prisma.group.update({ where: { id: groupId }, data: updateData });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'Group name already exists');
    throw err;
  }
}

/**
 * Dependents handled when this group is deleted (for the confirm dialog):
 * members removed (cascade) and policies that reference the group as a subject
 * (the reference is removed; flag any policy that would be left with no
 * subjects at all).
 */
export async function getGroupDeleteImpact(orgId, groupId) {
  const group = await prisma.group.findFirst({ where: { id: groupId, orgId } });
  if (!group) throw new ApiError(404, 'Group not found');

  const [memberCount, subjectRows] = await Promise.all([
    prisma.groupMembership.count({ where: { groupId } }),
    prisma.policySubject.findMany({
      where: { subjectType: 'GROUP', subjectId: groupId },
      select: { policyId: true },
    }),
  ]);

  const policyIds = subjectRows.map((r) => r.policyId);
  let policies = [];
  if (policyIds.length) {
    const rows = await prisma.accessPolicy.findMany({
      where: { id: { in: policyIds }, orgId },
      select: { id: true, name: true, _count: { select: { subjects: true } } },
    });
    // A policy is "left empty" if this group is its only subject.
    policies = rows.map((p) => ({ id: p.id, name: p.name, leftEmpty: p._count.subjects <= 1 }));
  }

  return {
    group: { id: group.id, name: group.name },
    memberCount,
    policies,
    policyCount: policies.length,
    policiesLeftEmpty: policies.filter((p) => p.leftEmpty).length,
  };
}

/**
 * Delete a group: removes orphan policy-subject references (polymorphic, no
 * cascade) then deletes the group (cascade removes memberships).
 */
export async function deleteGroup(orgId, groupId) {
  const existing = await prisma.group.findFirst({ where: { id: groupId, orgId } });
  if (!existing) throw new ApiError(404, 'Group not found');
  await prisma.$transaction(async (tx) => {
    await cleanupPolicySubjects('GROUP', groupId, tx);
    await tx.group.delete({ where: { id: groupId } });
  });
  return { success: true };
}

export async function addMember(orgId, groupId, userId, addedById) {
  const group = await prisma.group.findFirst({ where: { id: groupId, orgId } });
  if (!group) throw new ApiError(404, 'Group not found');
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) throw new ApiError(404, 'User not found in organization');

  try {
    return await prisma.groupMembership.create({
      data: { groupId, userId, addedById: addedById || null },
    });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'User is already a member');
    throw err;
  }
}

export async function removeMember(orgId, groupId, userId) {
  const group = await prisma.group.findFirst({ where: { id: groupId, orgId } });
  if (!group) throw new ApiError(404, 'Group not found');
  const membership = await prisma.groupMembership.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  if (!membership) throw new ApiError(404, 'Membership not found');
  await prisma.groupMembership.delete({ where: { id: membership.id } });
  return { success: true };
}

export async function getUserGroups(orgId, userId) {
  const memberships = await prisma.groupMembership.findMany({
    where: { userId, group: { orgId } },
    include: { group: true },
    orderBy: { createdAt: 'asc' },
  });
  return memberships.map((m) => m.group);
}

/**
 * Set a group's customer scope: `accessScope` (`ALL`|`CUSTOMERS`) plus the
 * exact set of `GroupCustomerScope` rows (docs/rbac/customer-scope-spec.md).
 * Every member whose own `accessScope` is CUSTOMERS inherits this
 * additively (lib/scope.js resolveScope):
 *   - `accessScope: 'ALL'` is a deliberate widening path — every CUSTOMERS
 *     member becomes effectively unscoped while in this group. It always
 *     normalizes `customerIds` to empty (resolveScope never reads them for
 *     an ALL group; they'd be dead weight, same as a user's ALL grant).
 *   - `accessScope: 'CUSTOMERS'` behaves exactly as before.
 * Same permission/validation rules as `userService.assignUserScope`:
 *   - every customerId must exist in the caller's org (404 otherwise)
 *   - a caller who is themselves scoped may only grant customers inside
 *     their own scope
 *   - the accessScope + customer rows are replaced transactionally
 *
 * @param {string} orgId
 * @param {string} groupId
 * @param {{ accessScope: 'ALL'|'CUSTOMERS', customerIds?: string[] }} data
 * @param {{ userId: string }|null} actor
 * @param {{ mode: 'all'|'customers', customerIds: string[] }|null} [callerScope] - req.scope
 * @param {object} [meta] - { ipAddress, userAgent } for the audit entry
 * @returns {Promise<object>} group with `customerIds`
 */
export async function assignGroupScope(orgId, groupId, data, actor, callerScope = null, meta = {}) {
  if (actor && !hasPermission(actor.permissions, 'users.assign_scope')) {
    throw new ApiError(403, "You don't have permission to assign customer scope", { code: 'PERMISSION_DENIED' });
  }

  const { accessScope } = data;
  const group = await prisma.group.findFirst({ where: { id: groupId, orgId } });
  if (!group) throw new ApiError(404, 'Group not found');

  const ids = accessScope === 'CUSTOMERS' ? [...new Set(data.customerIds || [])] : [];
  let found = [];
  if (ids.length > 0) {
    // Caller's own scope folded into the existence check — a distinct "exists
    // but you may not grant it" reply would be a customer-id oracle for a
    // scoped admin (docs/rbac/customer-scope-spec.md §2.3.2).
    found = await prisma.customer.findMany({
      where: { id: { in: ids }, orgId, AND: [customerScopeWhere(callerScope)] },
      select: { id: true, name: true },
    });
    if (found.length !== ids.length) throw new ApiError(404, 'One or more customers not found');
  }

  const before = await prisma.groupCustomerScope.findMany({
    where: { groupId },
    include: { customer: { select: { id: true, name: true } } },
  });

  const [updated] = await prisma.$transaction([
    prisma.group.update({ where: { id: groupId }, data: { accessScope } }),
    prisma.groupCustomerScope.deleteMany({ where: { groupId } }),
    ...(ids.length ? [prisma.groupCustomerScope.createMany({ data: ids.map((customerId) => ({ groupId, customerId })) })] : []),
  ]);

  if (actor) {
    await auditLog({
      orgId,
      actorId: actor.userId,
      action: 'group.scope.updated',
      resourceType: 'Group',
      resourceId: groupId,
      metadata: {
        // The accessScope transition is the headline of this audit entry —
        // widening a whole group (CUSTOMERS -> ALL) is exactly the change
        // someone will need to find later.
        accessScope: { from: group.accessScope, to: accessScope },
        before: before.map((b) => ({ id: b.customer.id, name: b.customer.name })),
        after: found.map((c) => ({ id: c.id, name: c.name })),
      },
      ...meta,
    });
  }

  return { ...updated, customerIds: ids };
}
