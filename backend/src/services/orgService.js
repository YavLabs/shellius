import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

const ALLOWED_UPDATE_FIELDS = ['name', 'domain', 'logoUrl', 'settings'];

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
