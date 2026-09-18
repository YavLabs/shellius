import { formatLabel } from '@/utils/format';
import { ROLE_LABELS } from './permissions';

/**
 * lib/labels.js — single source of truth for turning enum/machine values
 * (role, status, environment, protocol, ...) into human-readable text for
 * selects, filters, radios and segmented controls.
 *
 * The value on the wire (sent to the API, stored in state) never changes —
 * only the displayed text does. Where lib/badgeTones.js already maps a
 * value to a label for a Badge, the strings here match it so a badge and a
 * select showing the same value always agree.
 *
 * Use `labelize(MAP, value)` to look a value up with a sensible fallback
 * (case-insensitive match, then formatLabel's generic title-casing) instead
 * of ever rendering a raw enum value straight into the UI.
 */

// Re-exported so callers only need to import from one place. Source of
// truth stays in lib/permissions.js (used for RBAC too).
export { ROLE_LABELS };

export const USER_STATUS_LABELS = {
  active: 'Active',
  invited: 'Invited',
  suspended: 'Suspended',
  deactivated: 'Deactivated',
};

// Title case, NOT the short uppercase codes used on environment Badges
// (lib/badgeTones.js ENV_TONES) — those are intentionally DEV/STAGING/PROD/
// DEMO. Selects and filters use the friendlier form.
export const ENVIRONMENT_LABELS = {
  demo: 'Demo',
  dev: 'Dev',
  staging: 'Staging',
  prod: 'Production',
};

export const PROTOCOL_LABELS = {
  ssh: 'SSH',
  rdp: 'RDP',
  both: 'SSH + RDP',
  ssh_rdp: 'SSH + RDP',
};

export const SERVER_AUTH_MODE_LABELS = {
  certificate: 'Certificate (managed)',
  credential: 'Stored credential',
};

export const HEALTH_STATUS_LABELS = {
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  unknown: 'Unknown',
  maintenance: 'Maintenance',
};

export const PROVISION_STATUS_LABELS = {
  pending: 'Pending',
  provisioning: 'Provisioning',
  provisioned: 'Provisioned',
  failed: 'Failed',
};

export const POLICY_EFFECT_LABELS = {
  allow: 'Allow',
  deny: 'Deny',
};

export const ACCESS_REQUEST_STATUS_LABELS = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};

export const SESSION_STATUS_LABELS = {
  ACTIVE: 'Active',
  ENDED: 'Ended',
  TERMINATED: 'Terminated',
};

export const CERT_STATUS_LABELS = {
  ACTIVE: 'Active',
  REVOKED: 'Revoked',
  EXPIRED: 'Expired',
};

export const KEY_TYPE_LABELS = {
  ed25519: 'Ed25519',
  rsa: 'RSA',
  ecdsa: 'ECDSA',
};

export const AUTH_TYPE_LABELS = {
  password: 'Password',
  key: 'Private key',
  key_password: 'Key + password',
};

/**
 * labelize(map, value, fallback?) — look up a human label for `value` in
 * `map` (tries the exact value, then lower/upper-cased), falling back to
 * formatLabel's generic "snake_case → Title Case" conversion so an
 * unmapped value still renders sensibly instead of shouting a raw enum.
 */
export function labelize(map, value, fallback) {
  if (value === undefined || value === null || value === '') return fallback ?? '';
  const key = String(value);
  return map[key] ?? map[key.toLowerCase()] ?? map[key.toUpperCase()] ?? formatLabel(value);
}
