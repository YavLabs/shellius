/**
 * Permission helpers for the UI.
 *
 * What a user may do comes from their role's permissions, sent by the API on
 * login and /auth/me (`user.permissions`, keys from
 * backend/src/config/permissions.js). Never gate on the role name — roles are
 * editable and custom roles exist. The backend enforces every check again;
 * these only decide what to show.
 *
 *   can(user, 'servers.create')
 *   canAny(user, 'roles.view', 'users.assign_role')
 *   useAuth().can('servers.create')        // same, inside components
 */

export const PERMISSIONS_STALE_EVENT = 'shellius:permissions-stale';

export function can(user, permission) {
  return !!user?.permissions?.includes(permission);
}

export function canAny(user, ...permissions) {
  return permissions.some((p) => can(user, p));
}

export function canAll(user, ...permissions) {
  return permissions.every((p) => can(user, p));
}

/**
 * Customer scope (docs/rbac/customer-scope-spec.md). `user.scope` comes from
 * /auth/me: `{ kind: 'all' | 'customers', customerIds: string[] }`. Client
 * convenience only, e.g. to skip an out-of-scope option in a dropdown —
 * every list/detail endpoint enforces the same scope server-side. No scope,
 * or `kind: 'all'` (unscoped users, super admins), is unrestricted.
 *
 *   inScope(user, customer.id)
 */
export function inScope(user, customerId) {
  const scope = user?.scope;
  if (!scope || scope.kind !== 'customers') return true;
  return (scope.customerIds || []).includes(customerId);
}

// Built-in role names by key (the base tier of any role). Custom roles carry
// their own name in user.roleInfo.name.
export const ROLE_LABELS = {
  super_admin: 'Super admin',
  admin: 'Admin',
  manager: 'Manager',
  member: 'Member',
};

/** Display name of a user's role (custom name, else the built-in label). */
export function roleName(user) {
  return user?.roleInfo?.name || ROLE_LABELS[user?.role] || user?.role || '—';
}

