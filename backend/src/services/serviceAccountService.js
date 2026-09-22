/**
 * serviceAccountService.js — machine identities.
 *
 * A service account is a real User row with kind = 'service'. That is the
 * whole design decision, and it is what makes everything else free:
 * AuditLog.actorId is a foreign key to User, so a CI action is attributed to
 * a named robot rather than to nobody; roles and permissions resolve exactly
 * as they do for a person; customer scope applies; and a service account can
 * be a policy subject, so it can actually be granted access to servers.
 *
 * What it must never be is a login. It holds no password, its address is in
 * a reserved TLD that can't receive mail, password sign-in and SSO email
 * matching both exclude it, and the JWT path refuses it outright. Its only
 * credential is an API token.
 */

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { assertCanActOnRole, resolveRole } from './roleService.js';
import { ACTIONS, log as auditLog } from './auditService.js';
import * as apiTokenService from './apiTokenService.js';

const ROLE_BRIEF = { select: { id: true, key: true, name: true, isSystem: true, baseRole: true, permissions: true } };

/**
 * A reserved TLD (RFC 2606), so the address satisfies the per-org unique
 * email constraint while being impossible to deliver to or register at an
 * identity provider.
 */
export const SERVICE_EMAIL_DOMAIN = 'service.invalid';

const slugify = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'service';

export function serviceEmailFor(name, suffix) {
  return `svc-${slugify(name)}-${suffix}@${SERVICE_EMAIL_DOMAIN}`;
}

export function toPublic(row, { tokens = null } = {}) {
  if (!row) return row;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    email: row.email,
    status: row.status,
    roleId: row.roleId,
    roleName: row.assignedRole?.name ?? null,
    roleKey: row.assignedRole?.key ?? null,
    accessScope: row.accessScope,
    customerIds: (row.customerScopes || []).map((s) => s.customerId),
    tokenCount: row._count?.apiTokens ?? (tokens ? tokens.length : undefined),
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
    ...(tokens ? { tokens } : {}),
  };
}

const BASE_INCLUDE = {
  assignedRole: ROLE_BRIEF,
  customerScopes: { select: { customerId: true } },
  _count: { select: { apiTokens: { where: { revokedAt: null } } } },
};

/**
 * The role a service account may be given: it must exist in this org, and
 * the actor must already hold everything it grants — the same no-escalation
 * rule that governs assigning a role to a person. Without this an admin
 * could mint a super-admin robot and then use it.
 */
async function resolveAssignableRole(orgId, roleRef, actor) {
  const role = await resolveRole(orgId, roleRef);
  if (!role) throw new ApiError(400, 'Role not found');
  if (role.baseRole === 'super_admin') {
    throw new ApiError(400, 'A service account can never be a super admin', { code: 'ROLE_NOT_ASSIGNABLE' });
  }
  if (actor) assertCanActOnRole(actor, role, 'give a service account this role');
  return role;
}

export async function list(orgId) {
  const rows = await prisma.user.findMany({
    where: { orgId, kind: 'service', status: { not: 'deleted' } },
    include: BASE_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });

  // "Last used" is a property of the tokens, not of the row.
  const lastUsed = await prisma.apiToken.groupBy({
    by: ['userId'],
    where: { orgId, userId: { in: rows.map((r) => r.id) } },
    _max: { lastUsedAt: true },
  });
  const byUser = new Map(lastUsed.map((l) => [l.userId, l._max.lastUsedAt]));

  return rows.map((r) => toPublic({ ...r, lastUsedAt: byUser.get(r.id) ?? null }));
}

export async function get(orgId, id) {
  const row = await prisma.user.findFirst({
    where: { id, orgId, kind: 'service' },
    include: BASE_INCLUDE,
  });
  if (!row) throw new ApiError(404, 'Service account not found');
  const tokens = await apiTokenService.listForUser(orgId, id);
  return toPublic(row, { tokens });
}

/**
 * Normalize a customer-scope grant. 'ALL' always stores an empty set —
 * resolveScope never reads those rows, so keeping them would be dead weight
 * that later reads could disagree about.
 */
async function normalizeScope(orgId, accessScope, customerIds) {
  const scope = accessScope === 'CUSTOMERS' ? 'CUSTOMERS' : 'ALL';
  const ids = scope === 'CUSTOMERS' ? [...new Set(customerIds || [])] : [];
  if (scope === 'CUSTOMERS' && ids.length === 0) {
    throw new ApiError(400, 'Choose at least one customer, or give the account access to all of them');
  }
  if (ids.length) {
    const found = await prisma.customer.count({ where: { id: { in: ids }, orgId } });
    if (found !== ids.length) throw new ApiError(400, 'One of those customers does not exist');
  }
  return { scope, ids };
}

export async function create(orgId, { name, description, roleId, accessScope, customerIds }, actor) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new ApiError(400, 'Name is required');

  const role = await resolveAssignableRole(orgId, roleId, actor);
  const { scope, ids } = await normalizeScope(orgId, accessScope, customerIds);

  const suffix = Math.random().toString(36).slice(2, 8);
  const row = await prisma.user.create({
    data: {
      orgId,
      kind: 'service',
      name: trimmed,
      description: description ? String(description).trim() : null,
      email: serviceEmailFor(trimmed, suffix),
      passwordHash: null,
      role: role.baseRole,
      roleId: role.id,
      status: 'active',
      accessScope: scope,
      ...(ids.length ? { customerScopes: { create: ids.map((customerId) => ({ customerId })) } } : {}),
    },
    include: BASE_INCLUDE,
  });

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.service_account.create,
    resourceType: 'User',
    resourceId: row.id,
    metadata: { name: row.name, role: role.name, accessScope: scope, customerIds: ids },
  });

  logger.info('serviceAccountService.create', { orgId, id: row.id, role: role.key });
  return toPublic(row, { tokens: [] });
}

export async function update(orgId, id, data, actor) {
  const existing = await prisma.user.findFirst({ where: { id, orgId, kind: 'service' }, include: BASE_INCLUDE });
  if (!existing) throw new ApiError(404, 'Service account not found');

  const updateData = {};
  const changes = {};

  if (data.name !== undefined) {
    const trimmed = String(data.name).trim();
    if (!trimmed) throw new ApiError(400, 'Name is required');
    updateData.name = trimmed;
    changes.name = { from: existing.name, to: trimmed };
  }
  if (data.description !== undefined) {
    updateData.description = data.description ? String(data.description).trim() : null;
  }

  if (data.roleId !== undefined && data.roleId !== existing.roleId) {
    // Both ends: the actor must be able to grant the new role, and must
    // already be able to act on the one it holds.
    if (existing.assignedRole && actor) assertCanActOnRole(actor, existing.assignedRole, 'change this service account');
    const role = await resolveAssignableRole(orgId, data.roleId, actor);
    updateData.roleId = role.id;
    updateData.role = role.baseRole;
    changes.role = { from: existing.assignedRole?.name ?? null, to: role.name };
  }

  if (data.status !== undefined && data.status !== existing.status) {
    if (!['active', 'deactivated'].includes(data.status)) {
      throw new ApiError(400, 'A service account is either active or deactivated');
    }
    updateData.status = data.status;
    changes.status = { from: existing.status, to: data.status };
  }

  // Customer scope, if the caller is changing it. Rewritten wholesale rather
  // than diffed — the set is small and a partial update here would be a
  // silent widening.
  let scopeRows = null;
  if (data.accessScope !== undefined) {
    const { scope, ids } = await normalizeScope(orgId, data.accessScope, data.customerIds);
    if (scope !== existing.accessScope || ids.join() !== (existing.customerScopes || []).map((s) => s.customerId).sort().join()) {
      changes.accessScope = { from: existing.accessScope, to: scope };
    }
    updateData.accessScope = scope;
    scopeRows = ids;
  }

  const row = scopeRows
    ? (
        await prisma.$transaction([
          prisma.userCustomerScope.deleteMany({ where: { userId: id } }),
          ...(scopeRows.length
            ? [prisma.userCustomerScope.createMany({ data: scopeRows.map((customerId) => ({ userId: id, customerId })) })]
            : []),
          prisma.user.update({ where: { id }, data: updateData, include: BASE_INCLUDE }),
        ])
      ).at(-1)
    : await prisma.user.update({ where: { id }, data: updateData, include: BASE_INCLUDE });

  if (Object.keys(changes).length) {
    await auditLog({
      orgId,
      actorId: actor?.userId ?? null,
      action: changes.role ? ACTIONS.service_account.role_changed : ACTIONS.service_account.update,
      resourceType: 'User',
      resourceId: id,
      metadata: { name: row.name, changes },
    });
  }

  // Deactivating must stop the tokens, not just mark the row — otherwise
  // "turn this robot off" leaves its credentials working.
  if (changes.status && changes.status.to === 'deactivated') {
    await apiTokenService.revokeAllForUser(orgId, id, 'Service account deactivated', actor);
  }

  const tokens = await apiTokenService.listForUser(orgId, id);
  return toPublic(row, { tokens });
}

export async function remove(orgId, id, actor) {
  const existing = await prisma.user.findFirst({ where: { id, orgId, kind: 'service' }, include: BASE_INCLUDE });
  if (!existing) throw new ApiError(404, 'Service account not found');
  if (existing.assignedRole && actor) assertCanActOnRole(actor, existing.assignedRole, 'delete this service account');

  await auditLog({
    orgId,
    actorId: actor?.userId ?? null,
    action: ACTIONS.service_account.delete,
    resourceType: 'User',
    resourceId: id,
    metadata: { name: existing.name, role: existing.assignedRole?.name ?? null },
  });

  // The audit row is written first and deliberately: deleting the user
  // SetNulls actorId on everything it ever did, so this is the last moment
  // the name can be recorded.
  await prisma.user.delete({ where: { id } });
  logger.info('serviceAccountService.remove', { orgId, id });
  return { deleted: true };
}

/** Issue a token for a service account. */
export async function issueToken(orgId, id, { name, description, scopes, expiresInDays }, actor) {
  const existing = await prisma.user.findFirst({ where: { id, orgId, kind: 'service' }, include: BASE_INCLUDE });
  if (!existing) throw new ApiError(404, 'Service account not found');
  if (existing.status !== 'active') throw new ApiError(409, 'That service account is not active');
  if (existing.assignedRole && actor) {
    assertCanActOnRole(actor, existing.assignedRole, 'issue a token for this service account');
  }

  return apiTokenService.create(
    orgId,
    { userId: id, kind: 'service', name, description, scopes, expiresInDays },
    actor
  );
}

export async function revokeToken(orgId, id, tokenId, actor) {
  const existing = await prisma.user.findFirst({ where: { id, orgId, kind: 'service' }, include: BASE_INCLUDE });
  if (!existing) throw new ApiError(404, 'Service account not found');
  if (existing.assignedRole && actor) {
    assertCanActOnRole(actor, existing.assignedRole, 'revoke this service account’s tokens');
  }
  return apiTokenService.revoke(orgId, tokenId, { userId: id, reason: 'Revoked by an administrator' }, actor);
}

export default {
  SERVICE_EMAIL_DOMAIN,
  serviceEmailFor,
  toPublic,
  list,
  get,
  create,
  update,
  remove,
  issueToken,
  revokeToken,
};
