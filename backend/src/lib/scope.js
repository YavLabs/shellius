/**
 * scope.js — customer scope, the one place the predicate lives.
 *
 * A user is either unscoped (`User.accessScope === 'ALL'`, the default and
 * today's behaviour) or restricted to a set of customers. Groups now carry
 * their own `accessScope` too (default `CUSTOMERS`, additive — an unassigned
 * group contributes nothing). A user is ALSO unscoped when they belong to
 * any group whose `accessScope` is `ALL` — a deliberate widening path a
 * group owner opts into knowingly. Short of either of those, the effective
 * set is the union of the user's own `UserCustomerScope` rows and the
 * `GroupCustomerScope` rows of every `CUSTOMERS` group they belong to (an
 * `ALL` group contributes no customer rows of its own — it short-circuits
 * the whole resolution instead). See docs/rbac/customer-scope-spec.md.
 *
 * Rules that are easy to get wrong and are therefore enforced here:
 *   - super_admin is never scoped (they can edit their own scope, so
 *     enforcing it would be theatre).
 *   - Out of scope is a 404, never a 403 — we do not disclose existence.
 *   - An empty customer set means nothing is visible. That is a legitimate
 *     (if usually accidental) configuration, not a reason to fall back to
 *     "see everything".
 *
 * Scope NARROWS; it never grants. A scoped user still needs an access policy
 * to connect to anything.
 */

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';

/** The scope every unscoped caller gets. */
export const UNSCOPED = Object.freeze({ mode: 'all', customerIds: [] });

/**
 * Resolve a user's effective scope. Called once per request from the auth
 * middleware; everything downstream reads the result off `req.scope`.
 *
 * @param {{ id: string, role: string, accessScope: string }} user
 * @returns {Promise<{ mode: 'all'|'customers', customerIds: string[] }>}
 */
export async function resolveScope(user) {
  if (!user) return UNSCOPED;
  if (user.role === 'super_admin') return UNSCOPED;
  if (user.accessScope !== 'CUSTOMERS') return UNSCOPED;

  const memberships = await prisma.groupMembership.findMany({
    where: { userId: user.id },
    select: { group: { select: { id: true, accessScope: true } } },
  });
  const groups = memberships.map((m) => m.group);

  // Any ALL group makes the member unscoped, full stop — it never even
  // reaches the union below.
  if (groups.some((g) => g.accessScope === 'ALL')) return UNSCOPED;

  const customersGroupIds = groups.filter((g) => g.accessScope === 'CUSTOMERS').map((g) => g.id);

  const [own, viaGroups] = await Promise.all([
    prisma.userCustomerScope.findMany({
      where: { userId: user.id },
      select: { customerId: true },
    }),
    customersGroupIds.length
      ? prisma.groupCustomerScope.findMany({
          where: { groupId: { in: customersGroupIds } },
          select: { customerId: true },
        })
      : Promise.resolve([]),
  ]);

  const ids = new Set([...own, ...viaGroups].map((r) => r.customerId));
  return { mode: 'customers', customerIds: [...ids] };
}

/** True when this scope lets everything through. */
export function isUnscoped(scope) {
  return !scope || scope.mode !== 'customers';
}

/**
 * Predicate for a model with its own `customerId` column (Server).
 * Spread into a Prisma `where`: `{ orgId, ...serverScopeWhere(scope) }`.
 */
export function serverScopeWhere(scope) {
  if (isUnscoped(scope)) return {};
  return { customerId: { in: scope.customerIds } };
}

/**
 * Predicate for the Customer model itself.
 *
 * ⚠️ This one returns an `id` key, so it must NEVER be spread into a `where`
 * that already looks up an id:
 *
 *   { id: customerId, orgId, ...customerScopeWhere(scope) }   // WRONG
 *
 * The spread silently REPLACES `id: customerId` with `id: { in: [...] }`,
 * turning "this customer, if in scope" into "any customer in scope" — the
 * lookup then succeeds and the caller happily returns data for the customer
 * that was asked for. Use `AND` instead, which composes rather than clobbers:
 *
 *   { id: customerId, orgId, AND: [customerScopeWhere(scope)] }   // RIGHT
 */
export function customerScopeWhere(scope) {
  if (isUnscoped(scope)) return {};
  return { id: { in: scope.customerIds } };
}

/**
 * Predicate for a model that reaches a server through a relation — e.g.
 * `{ orgId, ...relationScopeWhere(scope, 'server') }`. Rows whose relation is
 * null (a Quick Connect session has no server) are excluded; use
 * `sessionScopeWhere` where those must stay visible to their own user.
 */
export function relationScopeWhere(scope, relation = 'server') {
  if (isUnscoped(scope)) return {};
  return { [relation]: { customerId: { in: scope.customerIds } } };
}

/**
 * Sessions are special: `Session.serverId` is null for Quick Connect, and a
 * scoped user must not lose sight of their own ad-hoc sessions.
 */
export function sessionScopeWhere(scope, userId) {
  if (isUnscoped(scope)) return {};
  return {
    OR: [
      { server: { customerId: { in: scope.customerIds } } },
      { serverId: null, userId },
    ],
  };
}

/** The SQL fragment for the raw-SQL paths (search, audit search). */
export function scopeSqlIds(scope) {
  return isUnscoped(scope) ? null : scope.customerIds;
}

/**
 * Guard for a server the caller named by id. `server` may be a row or just a
 * `{ customerId }`. Throws 404 — never 403 — when it is out of scope.
 */
export function assertServerInScope(scope, server) {
  if (isUnscoped(scope)) return;
  if (!server || !scope.customerIds.includes(server.customerId)) {
    throw new ApiError(404, 'Server not found');
  }
}

/** Guard for a customer id the caller named (create/move/assign paths). */
export function assertCustomerInScope(scope, customerId) {
  if (isUnscoped(scope)) return;
  if (!customerId || !scope.customerIds.includes(customerId)) {
    throw new ApiError(404, 'Customer not found');
  }
}

export default {
  UNSCOPED,
  resolveScope,
  isUnscoped,
  serverScopeWhere,
  customerScopeWhere,
  relationScopeWhere,
  sessionScopeWhere,
  scopeSqlIds,
  assertServerInScope,
  assertCustomerInScope,
};
