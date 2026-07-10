/**
 * Central RBAC capability map for the UI. Keep button/nav/tab visibility in
 * sync with backend route guards.
 *
 * Roles: super_admin > admin > manager > member
 *   super_admin — everything
 *   admin       — everything except sensitive org settings (SSO/Storage/SMTP/MFA/CA)
 *   manager     — create customers, onboard/manage servers, approve requests
 *   member      — view servers/customers + connect (web SSH/RDP) per policy
 */

export const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, member: 1 };

export function roleAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

// capability -> minimum role
const CAPS = {
  // super_admin-only sensitive settings
  manageSso: 'super_admin',
  manageStorage: 'super_admin',
  manageSmtp: 'super_admin',
  manageMfa: 'super_admin',
  manageCa: 'super_admin',
  // admin
  manageOrg: 'admin',
  manageUsers: 'admin',
  manageGroups: 'admin',
  managePolicies: 'admin',
  viewAudit: 'admin',
  bulkImport: 'admin',
  deleteCustomers: 'admin',
  deleteServers: 'admin',
  bulkServers: 'admin',
  // manager
  manageCustomers: 'manager', // create / edit
  manageServers: 'manager', // create / edit / bootstrap / provision
  approveRequests: 'manager',
  viewSessions: 'manager',
  // member (any authenticated user)
  viewInventory: 'member',
};

export function can(user, capability) {
  const required = CAPS[capability];
  if (!required) return false;
  return roleAtLeast(user, required);
}

export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  manager: 'Manager',
  member: 'Member',
};
