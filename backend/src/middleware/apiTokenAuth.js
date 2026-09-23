/**
 * apiTokenAuth.js — authenticate a request carrying an API token.
 *
 * Produces exactly the same `req.user` as the JWT path (see requestUser.js),
 * so every existing route, permission check and scope rule applies to a token
 * unchanged. What differs is what a token is *allowed* to be:
 *
 *   - It can never widen. A personal token's permissions are intersected with
 *     its owner's live role on every request, so a demotion narrows every
 *     outstanding token on the next call, with nothing to re-mint and no
 *     snapshot to go stale.
 *   - It can never reach the endpoints that would let it escalate or escape
 *     its own audit trail (FORBIDDEN_PREFIXES): minting more tokens, changing
 *     MFA or SSO, reading someone's personal vault, opening a terminal.
 *   - It can never hold a non-delegable permission, whatever its owner holds
 *     (NON_DELEGABLE_PERMISSIONS in config/permissions.js).
 *
 * Deliberately NOT applied, both documented in docs/api-tokens.md:
 *   - `sessionsValidFrom`. "Sign out everywhere" ends interactive sessions;
 *     silently killing a CI credential because someone changed their password
 *     would be a bad surprise. Revoking tokens is its own explicit action,
 *     shown next to it in the UI.
 *   - The org MFA gate. A token is minted from an MFA-satisfied session and
 *     then used by a machine that cannot answer a challenge.
 */

import ApiError from '../utils/ApiError.js';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { hashApiToken, looksLikeApiToken } from '../utils/apiToken.js';
import { NON_DELEGABLE_PERMISSIONS } from '../config/permissions.js';
import { permissionsForUser } from '../services/roleService.js';
import { USER_AUTH_SELECT, hydrateRequestUser } from './requestUser.js';

/**
 * Paths no API token may reach, matched on prefix before any database work.
 *
 * The rule behind the list: a token must not be able to create another
 * credential, weaken the controls that protect the account, read a human's
 * private data, or open an interactive session that its audit trail can't
 * describe.
 */
export const FORBIDDEN_PREFIXES = [
  '/api/auth', // sign-in, sessions, refresh — a token is not a login
  '/api/mfa',
  '/api/settings/mfa',
  '/api/auth/sso',
  '/api/vault', // another person's personal vault, never
  '/api/terminal', // interactive shells belong to people
  '/api/tokens', // a token must not mint or revoke tokens
  '/api/service-accounts',
];

/** The one exception: machines legitimately need a whoami. */
const ALLOWED_EXACT = [{ method: 'GET', path: '/api/auth/me' }];

const LAST_USED_THROTTLE_MS = 60_000;

const pathOf = (req) => (req.originalUrl || req.url || '').split('?')[0];

export function isForbiddenPath(req) {
  const path = pathOf(req);
  if (ALLOWED_EXACT.some((a) => a.method === req.method && a.path === path)) return false;
  return FORBIDDEN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

const bearerOf = (req) => {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

/**
 * The permissions a token actually gets: its own scopes narrowed to whatever
 * its user's role currently allows, minus anything non-delegable.
 */
export function effectivePermissions(user, scopes) {
  const live = new Set(permissionsForUser(user));
  const granted = scopes?.length ? new Set(scopes.filter((k) => live.has(k))) : live;
  for (const key of NON_DELEGABLE_PERMISSIONS) granted.delete(key);
  return granted;
}

const apiTokenAuth = async (req, res, next) => {
  const raw = bearerOf(req);
  if (!looksLikeApiToken(raw)) {
    return next(new ApiError(401, 'Authentication token required'));
  }

  // Before any database work, so a token can't even probe these.
  if (isForbiddenPath(req)) {
    return next(
      new ApiError(403, 'This endpoint cannot be used with an API token', { code: 'TOKEN_NOT_ALLOWED_HERE' })
    );
  }

  let token;
  try {
    token = await prisma.apiToken.findUnique({
      where: { tokenHash: hashApiToken(raw) },
      include: { user: { select: USER_AUTH_SELECT } },
    });
  } catch (err) {
    return next(err);
  }

  const invalid = (message, code) => next(new ApiError(401, message, { code }));

  if (!token) return invalid('Invalid API token', 'TOKEN_INVALID');
  if (token.revokedAt) return invalid('This API token has been revoked', 'TOKEN_REVOKED');
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
    return invalid('This API token has expired', 'TOKEN_EXPIRED');
  }

  const user = token.user;
  if (!user || user.orgId !== token.orgId || user.status !== 'active') {
    return invalid('The identity behind this token is no longer active', 'TOKEN_PRINCIPAL_INACTIVE');
  }

  try {
    await hydrateRequestUser(req, user, { permissions: effectivePermissions(user, token.scopes) });
  } catch (err) {
    return next(err);
  }

  req.auth = { type: 'api_token', tokenId: token.id, tokenName: token.name, tokenKind: token.kind };
  req.user.tokenId = token.id;
  req.user.isToken = true;

  // Throttled, fire-and-forget: this is telemetry for the UI's "last used"
  // column, not something a request should wait on or fail for.
  const stale = !token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS;
  if (stale) {
    prisma.apiToken
      .update({
        where: { id: token.id },
        data: { lastUsedAt: new Date(), lastUsedIp: req.ip || null },
      })
      .catch((err) => logger.warn('apiTokenAuth: last-used update failed', { error: err.message }));
  }

  next();
};

export default apiTokenAuth;
