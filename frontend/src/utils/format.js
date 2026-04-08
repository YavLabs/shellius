/**
 * format.js — shared human-label helpers for UI chips, badges and text.
 *
 * Every user-visible enum string in Shellius should pass through one of
 * these so we never render raw database values like "super_admin",
 * "PENDING", or "access_request.break_glass" in the interface.
 */

/**
 * Title Case a single token, accounting for acronyms that should stay
 * uppercase. Extend this set as new ones come up.
 */
const PRESERVE_UPPERCASE = new Set([
  'ssh',
  'rdp',
  'sso',
  'ca',
  'jit',
  'acl',
  'ip',
  'os',
  'dns',
  'tls',
  'url',
  'uri',
  'api',
  'id',
  'ttl',
  'rbac',
  'uid',
  'gdpr',
  'smtp',
  'cors',
]);

function titleCaseToken(token) {
  if (!token) return token;
  if (PRESERVE_UPPERCASE.has(token.toLowerCase())) return token.toUpperCase();
  return token[0].toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * formatLabel — generic "turn machine value into a human label" helper.
 *
 *   formatLabel('super_admin')            → 'Super Admin'
 *   formatLabel('PENDING')                → 'Pending'
 *   formatLabel('access_request.break_glass') → 'Access Request · Break Glass'
 *   formatLabel('SSH')                    → 'SSH' (preserved acronym)
 *   formatLabel('ssh.key_downloaded')     → 'SSH · Key Downloaded'
 *
 * The dot separator becomes " · " so hierarchical action strings stay
 * readable. Underscores and hyphens become spaces. Null/undefined/empty
 * input returns an empty string so callers can safely interpolate.
 */
export function formatLabel(value) {
  if (value == null) return '';
  const s = String(value).trim();
  if (!s) return '';

  // Hierarchical keys like "access_request.break_glass" → split on '.'
  if (s.includes('.')) {
    return s.split('.').map(formatLabel).join(' · ');
  }

  // Split on underscore / hyphen / whitespace.
  const tokens = s.split(/[_\-\s]+/).filter(Boolean);
  return tokens.map(titleCaseToken).join(' ');
}

/**
 * Convenience wrappers — identical to formatLabel but communicate intent
 * at the call site.
 */
export const formatRole = formatLabel;
export const formatStatus = formatLabel;
export const formatAction = formatLabel;
