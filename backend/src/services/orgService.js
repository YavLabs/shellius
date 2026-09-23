import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

import { getSystemRole, permissionsOfRole, permissionsForUser, hasPermission } from './roleService.js';
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

// ---------------------------------------------------------------------------
// Chat approvals (docs/chat-notifications.md)
//
// Organization.settings.notifications.chatApprovalsAllowProd — default OFF.
//
// Off, a production request posted to chat carries a link and no buttons; the
// decision is made in Shellius. Turning it on is a deliberate choice, and a
// defensible one: there is no MFA gate on approval in the web UI either, and a
// Slack press needs a live Slack session, an explicitly linked identity and a
// request signed within five minutes. What it does add is a message visible to
// a whole channel, which is why a fresh install does not start this way.
// ---------------------------------------------------------------------------

function notificationSettingsOf(settings) {
  return settings && typeof settings === 'object' && settings.notifications && typeof settings.notifications === 'object'
    ? settings.notifications
    : {};
}

export async function chatApprovalsAllowProd(orgId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  return notificationSettingsOf(org?.settings).chatApprovalsAllowProd === true;
}

export async function setChatApprovalsAllowProd(orgId, allow) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  const settings = org?.settings && typeof org.settings === 'object' ? org.settings : {};
  const notifications = { ...notificationSettingsOf(settings), chatApprovalsAllowProd: !!allow };
  await prisma.organization.update({ where: { id: orgId }, data: { settings: { ...settings, notifications } } });
  return !!allow;
}

// ---------------------------------------------------------------------------
// Personal vault switch (docs/personal-vault.md)
//
// Organization.settings.vault.enabled — default on. Off: nobody can list,
// create or use personal identities, keys or hosts (the data is kept).
// ---------------------------------------------------------------------------

export function vaultEnabledFromSettings(settings) {
  const vault = settings && typeof settings === 'object' && settings.vault && typeof settings.vault === 'object' ? settings.vault : {};
  return vault.enabled !== false;
}

export async function isVaultEnabled(orgId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  return vaultEnabledFromSettings(org?.settings);
}

// ---------------------------------------------------------------------------
// Require single sign-on (docs/auth-hardening.md "Require single sign-on")
//
// Organization.settings.access.ssoRequired — default off. On: password
// sign-in, password reset and setting a password are refused for everyone
// EXCEPT users whose role holds `settings.sso` (the people who can fix the
// IdP configuration), so a broken identity provider can't lock the org out.
// ---------------------------------------------------------------------------

/** The permission that exempts a user from `ssoRequired`. */
export const SSO_REQUIRED_EXEMPT_PERMISSION = 'settings.sso';

export function ssoRequiredFromSettings(settings) {
  return accessSettingsOf(settings).ssoRequired === true;
}

export async function isSsoRequired(orgId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  return ssoRequiredFromSettings(org?.settings);
}

/**
 * Is password sign-in (login, reset, set) refused for this user because the
 * org requires SSO and their role doesn't exempt them?
 * @param {object} user - User row (orgId, role, roleId; assignedRole optional)
 */
export async function passwordSignInBlocked(user) {
  if (!user?.orgId) return false;
  if (!(await isSsoRequired(user.orgId))) return false;
  const assignedRole =
    user.assignedRole !== undefined
      ? user.assignedRole
      : user.roleId
        ? await prisma.role.findFirst({ where: { id: user.roleId, orgId: user.orgId } })
        : null;
  const perms = permissionsForUser({ ...user, assignedRole });
  return !hasPermission(perms, SSO_REQUIRED_EXEMPT_PERMISSION);
}

/**
 * @returns {Promise<{ prodBypassEnabled: boolean, rolesWithBypass: {id,name,key,isSystem}[], prodApprovalBypassMinRole: string, personalVaultEnabled: boolean, ssoRequired: boolean, rolesExemptFromSso: object[], ssoProvidersActive: number }>}
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
  const personalVaultEnabled = await isVaultEnabled(orgId);
  const ssoRequired = await isSsoRequired(orgId);
  const rolesExemptFromSso = roles
    .filter((r) => permissionsOfRole(r).includes(SSO_REQUIRED_EXEMPT_PERMISSION))
    .map(({ id, key, name, isSystem }) => ({ id, key, name, isSystem }));
  const ssoProvidersActive = await prisma.ssoConfig.count({ where: { orgId, isActive: true } });
  return {
    prodBypassEnabled,
    rolesWithBypass,
    prodApprovalBypassMinRole,
    personalVaultEnabled,
    ssoRequired,
    rolesExemptFromSso,
    ssoProvidersActive,
  };
}

async function updateSsoRequired(orgId, value) {
  if (typeof value !== 'boolean') throw new ApiError(400, 'ssoRequired must be true or false');
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  if (!org) throw new ApiError(404, 'Organization not found');
  if (value) {
    // Turning it on with no working provider would leave every non-exempt
    // user with no way in at all.
    const active = await prisma.ssoConfig.count({ where: { orgId, isActive: true } });
    if (active === 0) {
      throw new ApiError(409, 'Add and enable a single sign-on provider before requiring it', {
        code: 'SSO_NOT_CONFIGURED',
      });
    }
  }
  const current = org.settings && typeof org.settings === 'object' ? org.settings : {};
  const access = accessSettingsOf(current);
  await prisma.organization.update({
    where: { id: orgId },
    data: { settings: { ...current, access: { ...access, ssoRequired: value } } },
  });
  logger.info('orgService.updateAccessSettings: require-SSO switch updated', { orgId, ssoRequired: value });
}

/**
 * @param {string} orgId
 * @param {{ prodBypassEnabled?: boolean, prodApprovalBypassMinRole?: string, personalVaultEnabled?: boolean, ssoRequired?: boolean }} data
 */
export async function updateAccessSettings(orgId, data) {
  if (data.ssoRequired !== undefined) {
    await updateSsoRequired(orgId, data.ssoRequired);
    if (
      data.personalVaultEnabled === undefined &&
      data.prodBypassEnabled === undefined &&
      data.prodApprovalBypassMinRole === undefined
    ) {
      return getAccessSettings(orgId);
    }
  }
  if (data.personalVaultEnabled !== undefined) {
    if (typeof data.personalVaultEnabled !== 'boolean') throw new ApiError(400, 'personalVaultEnabled must be true or false');
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
    if (!org) throw new ApiError(404, 'Organization not found');
    const current = org.settings && typeof org.settings === 'object' ? org.settings : {};
    const vault = current.vault && typeof current.vault === 'object' ? current.vault : {};
    await prisma.organization.update({
      where: { id: orgId },
      data: { settings: { ...current, vault: { ...vault, enabled: data.personalVaultEnabled } } },
    });
    logger.info('orgService.updateAccessSettings: personal vault switch updated', { orgId, enabled: data.personalVaultEnabled });
    if (data.prodBypassEnabled === undefined && data.prodApprovalBypassMinRole === undefined) return getAccessSettings(orgId);
  }

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
