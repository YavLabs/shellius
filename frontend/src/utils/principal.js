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
