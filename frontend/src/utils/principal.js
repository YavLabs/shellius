// POSIX-ish Linux username: starts with [a-z_], 1-32 chars of [a-z0-9_-]
export const LINUX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * Sanitise an arbitrary string into a valid Linux username fragment.
 */
export function toLinuxUser(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

/**
 * Derive a sensible default SSH principal from the authenticated user record.
 * Prefers user.username, falls back to the email local-part, finally 'ubuntu'.
 */
export function defaultPrincipal(user) {
  if (user?.username && LINUX_USER_RE.test(user.username)) return user.username;
  const fromEmail = toLinuxUser(user?.email?.split('@')[0]);
  if (fromEmail && LINUX_USER_RE.test(fromEmail)) return fromEmail;
  return 'ubuntu';
}

/**
 * Pick the principal to use when connecting to a specific server. Precedence:
 *   1. The principal already issued in the active access request (so the
 *      cert and the SSH login agree)
 *   2. The sshUser the operator stored on the server when creating it
 *   3. The current user's defaultPrincipal (email-local-part fallback)
 *   4. 'ubuntu'
 *
 * @param {object|null} activeRequest — approved access request row, or null
 * @param {object|null} server        — server row
 * @param {object|null} currentUser   — auth user from useAuth()
 * @returns {string}
 */
export function principalForServer(activeRequest, server, currentUser) {
  if (activeRequest?.requestedPrincipal && LINUX_USER_RE.test(activeRequest.requestedPrincipal)) {
    return activeRequest.requestedPrincipal;
  }
  if (server?.sshUser && LINUX_USER_RE.test(server.sshUser)) {
    return server.sshUser;
  }
  return defaultPrincipal(currentUser);
}
