import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

const ALLOWED_UPDATE_FIELDS = ['name', 'domain', 'logoUrl', 'settings'];

// ---------------------------------------------------------------------------
// Production approval bypass setting — Organization.settings.access.prodApprovalBypassMinRole
// ---------------------------------------------------------------------------

export const PROD_BYPASS_ROLES = ['admin', 'super_admin', 'none'];
export const DEFAULT_PROD_BYPASS_ROLE = 'admin';

/**
 * Read the org's configured production-approval bypass role, defaulting to
 * 'admin' when unset or invalid. Read directly from Organization.settings
 * (no schema field — see docs/auth-hardening.md Revision 2 "Production approval").
 *
 * @param {string} orgId
 * @returns {Promise<'admin'|'super_admin'|'none'>}
 */
export async function getProdApprovalBypassRole(orgId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  const val = org?.settings?.access?.prodApprovalBypassMinRole;
  return PROD_BYPASS_ROLES.includes(val) ? val : DEFAULT_PROD_BYPASS_ROLE;
}

/**
 * @param {string} orgId
 * @returns {Promise<{ prodApprovalBypassMinRole: string }>}
 */
export async function getAccessSettings(orgId) {
  const prodApprovalBypassMinRole = await getProdApprovalBypassRole(orgId);
  return { prodApprovalBypassMinRole };
}

/**
 * @param {string} orgId
 * @param {{ prodApprovalBypassMinRole: string }} data
 * @returns {Promise<{ prodApprovalBypassMinRole: string }>}
 */
export async function updateAccessSettings(orgId, data) {
  const { prodApprovalBypassMinRole } = data;
  if (!PROD_BYPASS_ROLES.includes(prodApprovalBypassMinRole)) {
    throw new ApiError(400, `prodApprovalBypassMinRole must be one of: ${PROD_BYPASS_ROLES.join(', ')}`);
  }

  const existing = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  if (!existing) throw new ApiError(404, 'Organization not found');

  const settings = (existing.settings && typeof existing.settings === 'object') ? existing.settings : {};
  const access = (settings.access && typeof settings.access === 'object') ? settings.access : {};

  const updatedSettings = {
    ...settings,
    access: { ...access, prodApprovalBypassMinRole },
  };

  await prisma.organization.update({ where: { id: orgId }, data: { settings: updatedSettings } });

  logger.info('orgService.updateAccessSettings: production approval bypass role updated', {
    orgId,
    prodApprovalBypassMinRole,
  });

  return { prodApprovalBypassMinRole };
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
 * @param {object} data - subset of { name, domain, logoUrl, settings }
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
