/**
 * roleService — custom roles and the permission model.
 *
 * A Role is an org-scoped, named set of permission keys (see
 * config/permissions.js). Every org has four system roles whose key equals
 * the legacy tier (super_admin / admin / manager / member); orgs may add
 * custom roles on top. Users point at exactly one role (User.roleId) and
 * User.role mirrors that role's base tier, which policies still match on.
 *
 * Escalation rules (enforced here, not just in the UI):
 *   - super_admin (the system role) always holds every permission and can't
 *     be edited or deleted.
 *   - You can only create, edit, clone, assign or delete a role whose
 *     permissions are a subset of your own, and whose base tier is not above
 *     yours. So an admin can never produce anything stronger than an admin.
 *   - You can't edit the role you hold yourself.
 *   - Deleting a role requires moving its users to another role first.
 */
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { log as auditLog } from './auditService.js';
import {
  CATALOG_VERSION,
  PERMISSIONS,
  PERMISSION_KEYS,
  SYSTEM_ROLES,
  TIERS,
  defaultPermissionsFor,
  normalizePermissions,
} from '../config/permissions.js';

export const TIER_RANK = { member: 1, manager: 2, admin: 3, super_admin: 4 };
const SENSITIVE = new Set(PERMISSIONS.filter((p) => p.sensitive).map((p) => p.key));
const ROLE_SELECT = {
  id: true,
  key: true,
  name: true,
  description: true,
  baseRole: true,
  permissions: true,
  isSystem: true,
  catalogVersion: true,
  createdAt: true,
  updatedAt: true,
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function isOwnerRole(role) {
  return !!role && role.isSystem && role.key === 'super_admin';
}

/** Effective permission list for a role row (super_admin: everything). */
export function permissionsOfRole(role) {
  if (!role) return [];
  if (isOwnerRole(role)) return [...PERMISSION_KEYS];
  return normalizePermissions(role.permissions);
}

/**
 * Effective permissions for a user row that has `role` (tier) and optionally
 * `assignedRole` loaded. Falls back to the tier's defaults when the user
 * hasn't been linked to a role yet (only possible before syncSystemRoles ran).
 */
export function permissionsForUser(user) {
  if (!user) return [];
  if (user.assignedRole) return permissionsOfRole(user.assignedRole);
  return defaultPermissionsFor(user.role);
}

export function hasPermission(perms, key) {
  if (!perms) return false;
  return perms instanceof Set ? perms.has(key) : perms.includes(key);
}

/** Does `actorPerms` cover every permission in `perms`? */
export function coversAll(actorPerms, perms) {
  const set = actorPerms instanceof Set ? actorPerms : new Set(actorPerms);
  return perms.every((p) => set.has(p));
}

function missingFrom(actorPerms, perms) {
  const set = actorPerms instanceof Set ? actorPerms : new Set(actorPerms);
  return perms.filter((p) => !set.has(p));
}

/**
 * Can `actor` ({ permissions, tier }) act on something holding `role`?
 * True when the role's permissions are a subset of the actor's and its base
 * tier isn't above the actor's. Used for role editing, assignment and for
 * managing other users (you can manage a user only if you could assign
 * their role).
 */
export function canActOnRole(actor, role) {
  if (!role) return true;
  if (isOwnerRole(role) && actor.tier !== 'super_admin') return false;
  if ((TIER_RANK[role.baseRole] || 0) > (TIER_RANK[actor.tier] || 0)) return false;
  return coversAll(actor.permissions, permissionsOfRole(role));
}

export function assertCanActOnRole(actor, role, what = 'manage this role') {
  if (canActOnRole(actor, role)) return;
  const missing = missingFrom(actor.permissions, permissionsOfRole(role));
  throw new ApiError(403, `You can't ${what}: it has permissions you don't hold`, {
    code: 'ROLE_ESCALATION',
    details: { missing },
  });
}

/** Actor shape from req.user (see middleware/auth.js). */
export function actorFromReq(req) {
  return {
    userId: req.user.userId,
    roleId: req.user.roleId,
    tier: req.user.role,
    permissions: req.user.permissions,
  };
}

// ---------------------------------------------------------------------------
// System-role sync (boot, seed, new orgs) — idempotent
// ---------------------------------------------------------------------------

/**
 * Apply the two legacy role-keyed org settings to freshly created system
 * roles, so an upgrade keeps today's behaviour exactly:
 *   settings.access.prodApprovalBypassMinRole  -> access.prod_bypass
 *   settings.quickConnect.minRole              -> quick_connect.use
 */
function legacyAdjustments(settings, tier, perms) {
  const out = new Set(perms);
  const bypass = settings?.access?.prodApprovalBypassMinRole;
  if (bypass === 'super_admin' || bypass === 'none') {
    if (tier !== 'super_admin') out.delete('access.prod_bypass');
  }
  const qcMin = settings?.quickConnect?.minRole;
  if (TIER_RANK[qcMin]) {
    if ((TIER_RANK[tier] || 0) >= TIER_RANK[qcMin]) out.add('quick_connect.use');
    else out.delete('quick_connect.use');
  }
  return normalizePermissions([...out]);
}

/**
 * Make sure `orgId` has its four system roles, that every user is linked to
 * a role, that User.role mirrors the role's base tier, and that permissions
 * added to the catalogue since a role was last synced are granted per base
 * tier. Safe to run on every boot.
 */
export async function syncSystemRoles(orgId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  if (!org) return;
  const existing = await prisma.role.findMany({ where: { orgId } });
  const byKey = new Map(existing.map((r) => [r.key, r]));

  for (const sys of SYSTEM_ROLES) {
    const row = byKey.get(sys.key);
    if (!row) {
      const created = await prisma.role.create({
        data: {
          orgId,
          key: sys.key,
          name: sys.name,
          description: sys.description,
          baseRole: sys.key,
          isSystem: true,
          permissions: legacyAdjustments(org.settings, sys.key, defaultPermissionsFor(sys.key)),
          catalogVersion: CATALOG_VERSION,
        },
      });
      byKey.set(sys.key, created);
    }
  }

  // Catalogue upgrades: grant permissions introduced after the role's
  // catalogVersion to every role (system or custom) whose base tier gets
  // them by default.
  for (const role of byKey.values()) {
    if (role.catalogVersion >= CATALOG_VERSION) continue;
    const added = PERMISSIONS.filter(
      (p) => p.since > role.catalogVersion && (role.baseRole === 'super_admin' || p.defaults.includes(role.baseRole))
    ).map((p) => p.key);
    await prisma.role.update({
      where: { id: role.id },
      data: {
        permissions: normalizePermissions([...role.permissions, ...added]),
        catalogVersion: CATALOG_VERSION,
      },
    });
  }

  // Link users without a role to the system role for their tier.
  for (const tier of TIERS) {
    await prisma.user.updateMany({
      where: { orgId, roleId: null, role: tier },
      data: { roleId: byKey.get(tier).id },
    });
  }

  // Keep User.role (tier) in step with the role's base tier.
  for (const role of byKey.values()) {
    await prisma.user.updateMany({
      where: { orgId, roleId: role.id, NOT: { role: role.baseRole } },
      data: { role: role.baseRole },
    });
  }
}

export async function syncAllOrgs() {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  for (const { id } of orgs) {
    try {
      await syncSystemRoles(id);
    } catch (err) {
      logger.error('syncSystemRoles failed', { orgId: id, error: err.message });
    }
  }
}

export async function getSystemRole(orgId, tier) {
  let role = await prisma.role.findFirst({ where: { orgId, key: tier, isSystem: true } });
  if (!role) {
    await syncSystemRoles(orgId);
    role = await prisma.role.findFirst({ where: { orgId, key: tier, isSystem: true } });
  }
  return role;
}

/**
 * Resolve a role reference used by APIs, imports and SSO config: a role id,
 * a role key, or (case-insensitive) a role name. Returns null when unknown.
 */
export async function resolveRole(orgId, ref) {
  if (!ref || typeof ref !== 'string') return null;
  const byIdOrKey = await prisma.role.findFirst({ where: { orgId, OR: [{ id: ref }, { key: ref }] } });
  if (byIdOrKey) return byIdOrKey;
  return prisma.role.findFirst({ where: { orgId, name: { equals: ref, mode: 'insensitive' } } });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function shape(role, userCount) {
  const permissions = permissionsOfRole(role);
  return {
    ...role,
    permissions,
    locked: isOwnerRole(role),
    sensitivePermissions: permissions.filter((p) => SENSITIVE.has(p)),
    ...(userCount !== undefined ? { userCount } : {}),
  };
}

export async function listRoles(orgId, actor) {
  const [roles, counts] = await Promise.all([
    prisma.role.findMany({ where: { orgId }, select: ROLE_SELECT }),
    prisma.user.groupBy({ by: ['roleId'], where: { orgId, deletedAt: null }, _count: { _all: true } }),
  ]);
  const countBy = new Map(counts.map((c) => [c.roleId, c._count._all]));
  const order = (r) => (r.isSystem ? -TIER_RANK[r.key] : 0);
  return roles
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .map((r) => ({
      ...shape(r, countBy.get(r.id) || 0),
      // What the caller may do with it — the UI uses these, the API
      // re-checks everything.
      assignable: actor ? canActOnRole(actor, r) : false,
      editable: actor ? !isOwnerRole(r) && r.id !== actor.roleId && canActOnRole(actor, r) : false,
    }));
}

export async function getRole(orgId, id, actor) {
  const role = await prisma.role.findFirst({ where: { id, orgId }, select: ROLE_SELECT });
  if (!role) throw new ApiError(404, 'Role not found');
  const users = await prisma.user.findMany({
    where: { orgId, roleId: id, deletedAt: null },
    select: { id: true, name: true, email: true, avatarUrl: true, status: true },
    orderBy: { name: 'asc' },
    take: 200,
  });
  const policyRefs = await prisma.policySubject.count({
    where: { subjectType: 'ROLE', subjectId: role.key, policy: { orgId } },
  });
  return {
    ...shape(role, users.length),
    users,
    policyRefs,
    assignable: actor ? canActOnRole(actor, role) : false,
    editable: actor ? !isOwnerRole(role) && role.id !== actor.roleId && canActOnRole(actor, role) : false,
    defaults: role.isSystem ? defaultPermissionsFor(role.key) : null,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'role'
  );
}

async function uniqueKey(orgId, name) {
  const base = slugify(name);
  const reserved = new Set(TIERS);
  let key = reserved.has(base) ? `${base}_custom` : base;
  for (let i = 2; await prisma.role.findFirst({ where: { orgId, key }, select: { id: true } }); i += 1) {
    key = `${base}_${i}`;
  }
  return key;
}

function assertGrantable(actor, permissions) {
  const missing = missingFrom(actor.permissions, permissions);
  if (missing.length > 0) {
    throw new ApiError(403, "You can only grant permissions you hold yourself", {
      code: 'ROLE_ESCALATION',
      details: { missing },
    });
  }
}

function assertBaseRole(actor, baseRole) {
  if (!TIER_RANK[baseRole] || baseRole === 'super_admin') {
    throw new ApiError(400, 'baseRole must be one of: member, manager, admin');
  }
  if (TIER_RANK[baseRole] > (TIER_RANK[actor.tier] || 0)) {
    throw new ApiError(403, "A role's base can't be above your own", { code: 'ROLE_ESCALATION' });
  }
}

async function assertNameFree(orgId, name, exceptId) {
  const clash = await prisma.role.findFirst({
    where: { orgId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ApiError(409, `A role named "${name}" already exists`);
}

function diff(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((p) => !b.has(p)), removed: before.filter((p) => !a.has(p)) };
}

export async function createRole(orgId, actor, data, meta = {}) {
  const name = String(data.name || '').trim();
  if (!name) throw new ApiError(400, 'name is required');
  await assertNameFree(orgId, name);

  let baseRole = data.baseRole || 'member';
  let permissions = data.permissions;
  if (data.copyFromRoleId) {
    const source = await prisma.role.findFirst({ where: { id: data.copyFromRoleId, orgId } });
    if (!source) throw new ApiError(404, 'Role to copy not found');
    if (permissions === undefined) permissions = permissionsOfRole(source);
    if (!data.baseRole) baseRole = source.baseRole === 'super_admin' ? 'admin' : source.baseRole;
  }
  permissions = normalizePermissions(permissions || []);
  assertBaseRole(actor, baseRole);
  assertGrantable(actor, permissions);

  const role = await prisma.role.create({
    data: {
      orgId,
      key: await uniqueKey(orgId, name),
      name,
      description: data.description?.trim() || null,
      baseRole,
      permissions,
      isSystem: false,
      catalogVersion: CATALOG_VERSION,
      createdById: actor.userId,
    },
    select: ROLE_SELECT,
  });
  await auditLog({
    orgId,
    actorId: actor.userId,
    action: 'role.created',
    resourceType: 'Role',
    resourceId: role.id,
    metadata: { name: role.name, key: role.key, baseRole, permissions, copiedFrom: data.copyFromRoleId || undefined },
    ...meta,
  });
  return shape(role, 0);
}

export async function updateRole(orgId, actor, id, data, meta = {}) {
  const role = await prisma.role.findFirst({ where: { id, orgId } });
  if (!role) throw new ApiError(404, 'Role not found');
  if (isOwnerRole(role)) throw new ApiError(403, 'The Super admin role always has every permission and cannot be edited');
  if (role.id === actor.roleId) throw new ApiError(403, "You can't edit the role you hold", { code: 'ROLE_SELF_EDIT' });
  assertCanActOnRole(actor, role, 'edit this role');

  const update = {};
  if (data.name !== undefined) {
    if (role.isSystem) throw new ApiError(400, 'Built-in roles cannot be renamed');
    const name = String(data.name).trim();
    if (!name) throw new ApiError(400, 'name cannot be empty');
    await assertNameFree(orgId, name, id);
    update.name = name;
  }
  if (data.description !== undefined) update.description = data.description?.trim() || null;
  if (data.baseRole !== undefined && data.baseRole !== role.baseRole) {
    if (role.isSystem) throw new ApiError(400, "A built-in role's base cannot change");
    assertBaseRole(actor, data.baseRole);
    update.baseRole = data.baseRole;
  }
  let changes = null;
  if (data.permissions !== undefined) {
    const next = normalizePermissions(data.permissions);
    assertGrantable(actor, next);
    changes = diff(permissionsOfRole(role), next);
    update.permissions = next;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.role.update({ where: { id }, data: update, select: ROLE_SELECT });
    if (update.baseRole) {
      await tx.user.updateMany({ where: { orgId, roleId: id }, data: { role: update.baseRole } });
    }
    return r;
  });

  await auditLog({
    orgId,
    actorId: actor.userId,
    action: 'role.updated',
    resourceType: 'Role',
    resourceId: id,
    metadata: {
      name: updated.name,
      ...(update.name ? { renamedFrom: role.name } : {}),
      ...(update.baseRole ? { baseRole: { from: role.baseRole, to: update.baseRole } } : {}),
      ...(changes ? changes : {}),
    },
    ...meta,
  });
  return shape(updated);
}

export async function resetRole(orgId, actor, id, meta = {}) {
  const role = await prisma.role.findFirst({ where: { id, orgId } });
  if (!role) throw new ApiError(404, 'Role not found');
  if (!role.isSystem) throw new ApiError(400, 'Only built-in roles can be reset to defaults');
  return updateRole(orgId, actor, id, { permissions: defaultPermissionsFor(role.key) }, meta);
}

export async function deleteRole(orgId, actor, id, { reassignToRoleId } = {}, meta = {}) {
  const role = await prisma.role.findFirst({ where: { id, orgId } });
  if (!role) throw new ApiError(404, 'Role not found');
  if (role.isSystem) throw new ApiError(400, 'Built-in roles cannot be deleted');
  if (role.id === actor.roleId) throw new ApiError(403, "You can't delete the role you hold");
  assertCanActOnRole(actor, role, 'delete this role');

  const userCount = await prisma.user.count({ where: { orgId, roleId: id } });
  let target = null;
  if (userCount > 0) {
    if (!reassignToRoleId) {
      throw new ApiError(409, `${userCount} user(s) have this role — choose a role to move them to`, {
        code: 'ROLE_IN_USE',
        details: { userCount },
      });
    }
    target = await prisma.role.findFirst({ where: { id: reassignToRoleId, orgId } });
    if (!target || target.id === id) throw new ApiError(400, 'Choose a different, existing role to move users to');
    assertCanActOnRole(actor, target, 'move users to that role');
  }

  const removedSubjects = await prisma.$transaction(async (tx) => {
    if (target) {
      await tx.user.updateMany({ where: { orgId, roleId: id }, data: { roleId: target.id, role: target.baseRole } });
    }
    const subjects = await tx.policySubject.deleteMany({
      where: { subjectType: 'ROLE', subjectId: role.key, policy: { orgId } },
    });
    await tx.role.delete({ where: { id } });
    return subjects.count;
  });

  await auditLog({
    orgId,
    actorId: actor.userId,
    action: 'role.deleted',
    resourceType: 'Role',
    resourceId: id,
    metadata: {
      name: role.name,
      key: role.key,
      usersMoved: userCount,
      movedTo: target ? target.name : undefined,
      policySubjectsRemoved: removedSubjects,
    },
    ...meta,
  });
  return { deleted: true, usersMoved: userCount, policySubjectsRemoved: removedSubjects };
}

/**
 * Roles SSO / self-sign-up may hand out automatically: never the Super admin
 * role, and never a role with sensitive permissions (every IdP user in the
 * allowed domains would get them).
 */
export function isAutoAssignable(role) {
  return !!role && !isOwnerRole(role) && permissionsOfRole(role).every((p) => !SENSITIVE.has(p));
}

/** Validate an SSO default-role reference on save; returns the role key. */
export async function assertSsoDefaultRole(orgId, ref) {
  if (ref === undefined || ref === null || ref === '') return undefined;
  const role = await resolveRole(orgId, ref);
  if (!role) throw new ApiError(400, `Unknown role "${ref}"`);
  if (!isAutoAssignable(role)) {
    throw new ApiError(400, `"${role.name}" has sensitive permissions and can't be given automatically to new SSO users`);
  }
  return role.key;
}

/** Role for a new SSO user: the configured default if still safe, else Member. */
export async function ssoDefaultRole(orgId, ref) {
  const role = ref ? await resolveRole(orgId, ref) : null;
  if (isAutoAssignable(role)) return role;
  if (ref && ref !== 'member') logger.warn('SSO default role is missing or sensitive — using Member', { orgId, ref });
  return getSystemRole(orgId, 'member');
}

/** Users (id) in an org whose role grants `permission` — for notifications. */
export async function usersWithPermission(orgId, permission, { excludeUserId } = {}) {
  const roles = await prisma.role.findMany({ where: { orgId }, select: { id: true, key: true, isSystem: true, permissions: true } });
  const roleIds = roles.filter((r) => permissionsOfRole(r).includes(permission)).map((r) => r.id);
  if (roleIds.length === 0) return [];
  return prisma.user.findMany({
    where: {
      orgId,
      roleId: { in: roleIds },
      status: 'active',
      deletedAt: null,
      ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}),
    },
    select: { id: true, email: true, name: true },
  });
}

export default {
  syncSystemRoles,
  syncAllOrgs,
  getSystemRole,
  resolveRole,
  listRoles,
  getRole,
  createRole,
  updateRole,
  resetRole,
  deleteRole,
  usersWithPermission,
  permissionsOfRole,
  permissionsForUser,
  canActOnRole,
  assertCanActOnRole,
  actorFromReq,
};
