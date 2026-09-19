import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

import { getSystemRole, permissionsOfRole } from './roleService.js';
import { normalizePermissions } from '../config/permissions.js';

// Settings have their own permission-gated routes; PUT /api/org must not be a
// way around them (docs/rbac F-10: admins could rewrite the prod setting).
const ALLOWED_UPDATE_FIELDS = ['name', 'domain', 'logoUrl'];

// ---------------------------------------------------------------------------
// Production approval bypass
//
// Who may skip prod approval is the `access.prod_bypass` permission on their
// role. On top of that, Organization.settings.access.prodBypassEnabled is an
// org-wide switch: when false, nobody skips approval (not even super admins).
//
// The legacy setting `prodApprovalBypassMinRole` ('admin' | 'super_admin' |
// 'none') is still accepted by the API and mapped onto the switch plus the
// built-in Admin role's permission.
// ---------------------------------------------------------------------------

export const PROD_BYPASS_ROLES = ['admin', 'super_admin', 'none'];

function accessSettingsOf(settings) {
  return settings && typeof settings === 'object' && settings.access && typeof settings.access === 'object'
    ? settings.access
    : {};
}

/** Is skipping prod approval allowed at all in this org? */
export async function isProdBypassEnabled(orgId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  const access = accessSettingsOf(org?.settings);
  if (typeof access.prodBypassEnabled === 'boolean') return access.prodBypassEnabled;
  return access.prodApprovalBypassMinRole !== 'none';
}

/**
 * Can a user holding `permissions` skip prod approval in this org?
 * @param {string} orgId
 * @param {Set<string>|string[]} permissions
 */
export async function canBypassProdApproval(orgId, permissions) {
  const has = permissions instanceof Set ? permissions.has('access.prod_bypass') : (permissions || []).includes('access.prod_bypass');
  if (!has) return false;
  return isProdBypassEnabled(orgId);
}

/**
 * @returns {Promise<{ prodBypassEnabled: boolean, rolesWithBypass: {id,name,key,isSystem}[], prodApprovalBypassMinRole: string }>}
 */
export async function getAccessSettings(orgId) {
  const prodBypassEnabled = await isProdBypassEnabled(orgId);
  const roles = await prisma.role.findMany({ where: { orgId }, select: { id: true, key: true, name: true, isSystem: true, permissions: true } });
  const rolesWithBypass = roles
    .filter((r) => permissionsOfRole(r).includes('access.prod_bypass'))
    .map(({ id, key, name, isSystem }) => ({ id, key, name, isSystem }));
  // Legacy summary for older clients (and the CLI).
  const adminHas = rolesWithBypass.some((r) => r.isSystem && r.key === 'admin');
  const prodApprovalBypassMinRole = !prodBypassEnabled ? 'none' : adminHas ? 'admin' : 'super_admin';
  return { prodBypassEnabled, rolesWithBypass, prodApprovalBypassMinRole };
}

/**
 * @param {string} orgId
 * @param {{ prodBypassEnabled?: boolean, prodApprovalBypassMinRole?: string }} data
 */
export async function updateAccessSettings(orgId, data) {
  let enabled = data.prodBypassEnabled;
  const legacy = data.prodApprovalBypassMinRole;
  if (legacy !== undefined) {
    if (!PROD_BYPASS_ROLES.includes(legacy)) {
      throw new ApiError(400, `prodApprovalBypassMinRole must be one of: ${PROD_BYPASS_ROLES.join(', ')}`);
    }
    enabled = legacy !== 'none';
    if (legacy !== 'none') {
      // 'admin' grants the built-in Admin role the bypass, 'super_admin' removes it.
      const adminRole = await getSystemRole(orgId, 'admin');
      const current = permissionsOfRole(adminRole).filter((p) => p !== 'access.prod_bypass');
      const next = legacy === 'admin' ? [...current, 'access.prod_bypass'] : current;
      await prisma.role.update({ where: { id: adminRole.id }, data: { permissions: normalizePermissions(next) } });
    }
  }
  if (typeof enabled !== 'boolean') throw new ApiError(400, 'prodBypassEnabled must be true or false');

  const existing = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  if (!existing) throw new ApiError(404, 'Organization not found');
  const settings = existing.settings && typeof existing.settings === 'object' ? existing.settings : {};
  const { prodApprovalBypassMinRole: _legacy, ...access } = accessSettingsOf(settings);
  await prisma.organization.update({
    where: { id: orgId },
    data: { settings: { ...settings, access: { ...access, prodBypassEnabled: enabled } } },
  });

  logger.info('orgService.updateAccessSettings: production approval bypass updated', { orgId, prodBypassEnabled: enabled });
  return getAccessSettings(orgId);
}

/**
 * Get an organization by id.
 *
 * @param {string} orgId
 * @returns {Promise<object>}
 */
export async function getOrg(orgId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new ApiError(404, 'Organization not found');
  return org;
}

/**
 * Update allowed fields on an organization.
 * Does NOT allow updating `slug` or `id`.
 *
 * @param {string} orgId
 * @param {object} data - subset of { name, domain, logoUrl }
 * @returns {Promise<object>}
 */
export async function updateOrg(orgId, data) {
  const existing = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!existing) throw new ApiError(404, 'Organization not found');

  const updateData = {};
  for (const field of ALLOWED_UPDATE_FIELDS) {
    if (data[field] !== undefined) updateData[field] = data[field];
  }

  if (Object.keys(updateData).length === 0) {
    throw new ApiError(400, 'No valid fields to update');
  }

  const org = await prisma.organization.update({
    where: { id: orgId },
    data: updateData,
  });

  logger.info('orgService.updateOrg: organization updated', { orgId });
  return org;
}
