/**
 * requestUser.js — the one place `req.user` is built.
 *
 * Two credentials can now authenticate a request: a browser's access JWT
 * (middleware/auth.js) and an API token (middleware/apiTokenAuth.js). They
 * differ in how they identify the caller and in nothing else — once the user
 * row is in hand, both must produce exactly the same `req.user` and
 * `req.scope`, because everything downstream reads only those:
 * `requirePermission`/`can` read `req.user.permissions`, `tenant` reads
 * `req.user.orgId`, `userRateLimiter` keys on `req.user.userId`, and some
 * 129 call sites read `req.user.userId` directly.
 *
 * Kept out of auth.js so apiTokenAuth can use it without an import cycle.
 */

import { permissionsForUser } from '../services/roleService.js';
import { resolveScope } from '../lib/scope.js';

/**
 * The user columns both authentication paths need. Anything added here is
 * loaded on every authenticated request, so keep it small.
 */
export const USER_AUTH_SELECT = {
  id: true,
  orgId: true,
  email: true,
  role: true,
  roleId: true,
  assignedRole: { select: { id: true, key: true, name: true, isSystem: true, baseRole: true, permissions: true } },
  status: true,
  kind: true,
  accessScope: true,
  sessionsValidFrom: true,
  mfaTotpEnabled: true,
  mfaEmailEnabled: true,
  mfaBackupCodes: true,
};

/**
 * Populate `req.scope` and `req.user` from a loaded user row.
 *
 * Customer scope is resolved per request like permissions — so narrowing or
 * widening someone's scope takes effect on their next call, not their next
 * login. Unscoped users (the default) cost nothing: resolveScope returns the
 * shared UNSCOPED constant without touching the database.
 *
 * @param {object} req
 * @param {object} user  row selected with USER_AUTH_SELECT
 * @param {object} [opts]
 * @param {string|null} [opts.fid]         refresh-token family id (JWT path only)
 * @param {Set<string>|null} [opts.permissions]  override, for a token that
 *   narrows its user's permissions. Defaults to the user's full live set.
 */
export async function hydrateRequestUser(req, user, { fid = undefined, permissions = null } = {}) {
  req.scope = await resolveScope(user);

  req.user = {
    userId: user.id,
    orgId: user.orgId,
    accessScope: user.accessScope,
    role: user.role, // base tier — DB-authoritative, demotions apply immediately
    roleId: user.roleId,
    roleKey: user.assignedRole?.key || user.role,
    permissions: permissions ?? new Set(permissionsForUser(user)),
    email: user.email,
    kind: user.kind,
    fid,
  };
}

export default { USER_AUTH_SELECT, hydrateRequestUser };
