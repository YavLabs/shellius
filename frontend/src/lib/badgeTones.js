/**
 * badgeTones.js — single source of truth mapping domain values to a
 * Badge `tone` + display label. Used by components/ui/badge.jsx consumers
 * across the app so every chip (environment, status, policy effect, auth
 * type, role, source, protocol, ...) shares one geometry and one consistent
 * color mapping in both light and dark mode.
 *
 * Tones: neutral | success | warning | danger | info | accent
 *
 * Casing rule: labels are Sentence case everywhere EXCEPT environment
 * codes, which stay short uppercase codes (DEV, STAGING, PROD, DEMO).
 */

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------
export const ENV_TONES = {
  demo: 'neutral',
  dev: 'info',
  staging: 'warning',
  prod: 'danger',
};

export function environmentTone(environment) {
  const key = (environment || '').toLowerCase();
  return {
    tone: ENV_TONES[key] || 'neutral',
    label: key ? key.toUpperCase() : 'UNKNOWN',
  };
}

// ---------------------------------------------------------------------------
// Generic statuses (active/approved/pending/denied/expired/etc.)
// ---------------------------------------------------------------------------
const STATUS_MAP = {
  // success
  active: { tone: 'success', label: 'Active' },
  approved: { tone: 'success', label: 'Approved' },
  success: { tone: 'success', label: 'Success' },
  healthy: { tone: 'success', label: 'Healthy' },
  connected: { tone: 'success', label: 'Connected' },
  enabled: { tone: 'success', label: 'Enabled' },
  online: { tone: 'success', label: 'Online' },
  synced: { tone: 'success', label: 'Synced' },
  verified: { tone: 'success', label: 'Verified' },
  completed: { tone: 'success', label: 'Completed' },
  overridden: { tone: 'success', label: 'Overridden' },

  // warning
  pending: { tone: 'warning', label: 'Pending' },
  running: { tone: 'warning', label: 'Running' },
  in_progress: { tone: 'warning', label: 'In progress' },
  syncing: { tone: 'warning', label: 'Syncing' },
  expiring: { tone: 'warning', label: 'Expiring soon' },
  degraded: { tone: 'warning', label: 'Degraded' },
  awaiting_approval: { tone: 'warning', label: 'Awaiting approval' },

  // danger
  denied: { tone: 'danger', label: 'Denied' },
  rejected: { tone: 'danger', label: 'Rejected' },
  failed: { tone: 'danger', label: 'Failed' },
  revoked: { tone: 'danger', label: 'Revoked' },
  unhealthy: { tone: 'danger', label: 'Unhealthy' },
  error: { tone: 'danger', label: 'Error' },
  offline: { tone: 'danger', label: 'Offline' },
  disabled: { tone: 'danger', label: 'Disabled' },
  terminated: { tone: 'danger', label: 'Terminated' },
  suspended: { tone: 'danger', label: 'Suspended' },

  // neutral
  expired: { tone: 'neutral', label: 'Expired' },
  ended: { tone: 'neutral', label: 'Ended' },
  inactive: { tone: 'neutral', label: 'Inactive' },
  draft: { tone: 'neutral', label: 'Draft' },
  unknown: { tone: 'neutral', label: 'Unknown' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  canceled: { tone: 'neutral', label: 'Cancelled' },

  // info
  environment_default: { tone: 'info', label: 'Environment default' },
};

export function statusTone(status) {
  const key = (status || '').toString().trim().toLowerCase().replace(/\s+/g, '_');
  if (STATUS_MAP[key]) return STATUS_MAP[key];
  // Fallback: title-case the raw value so unmapped statuses still render
  // sensibly instead of shouting in uppercase.
  const label = (status || 'Unknown')
    .toString()
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  return { tone: 'neutral', label: label || 'Unknown' };
}

// ---------------------------------------------------------------------------
// Policy effect
// ---------------------------------------------------------------------------
export function policyEffectTone(effect) {
  const key = (effect || '').toLowerCase();
  if (key === 'allow') return { tone: 'success', label: 'Allow' };
  if (key === 'deny') return { tone: 'danger', label: 'Deny' };
  return { tone: 'neutral', label: effect || 'Unknown' };
}

// ---------------------------------------------------------------------------
// Auth type (Keystore identities)
// ---------------------------------------------------------------------------
const AUTH_TYPE_MAP = {
  password: { tone: 'neutral', label: 'Password' },
  key: { tone: 'info', label: 'Private key' },
  key_password: { tone: 'accent', label: 'Key + password' },
};

export function authTypeTone(authType) {
  const key = (authType || '').toLowerCase();
  return AUTH_TYPE_MAP[key] || { tone: 'neutral', label: authType || 'Unknown' };
}

// ---------------------------------------------------------------------------
// Key source (generated vs imported)
// ---------------------------------------------------------------------------
export function keySourceTone(source) {
  const key = (source || '').toLowerCase();
  if (key === 'generated') return { tone: 'accent', label: 'Generated' };
  if (key === 'imported') return { tone: 'neutral', label: 'Imported' };
  return { tone: 'neutral', label: source || 'Unknown' };
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------
const ROLE_MAP = {
  super_admin: { tone: 'accent', label: 'Super admin' },
  admin: { tone: 'info', label: 'Admin' },
  manager: { tone: 'info', label: 'Manager' },
  member: { tone: 'neutral', label: 'Member' },
};

export function roleTone(role) {
  const key = (role || '').toLowerCase();
  return ROLE_MAP[key] || { tone: 'neutral', label: role || 'Unknown' };
}

// ---------------------------------------------------------------------------
// Protocols / source / format — neutral/info by default
// ---------------------------------------------------------------------------
export function protocolTone(protocol) {
  const key = (protocol || '').toLowerCase();
  if (key === 'ssh') return { tone: 'info', label: 'SSH' };
  if (key === 'rdp') return { tone: 'accent', label: 'RDP' };
  return { tone: 'neutral', label: (protocol || 'Unknown').toUpperCase() };
}

const SOURCE_MAP = {
  aws: { tone: 'warning', label: 'AWS' },
  azure: { tone: 'info', label: 'Azure' },
  gcp: { tone: 'success', label: 'GCP' },
  manual: { tone: 'neutral', label: 'Manual' },
  bootstrap: { tone: 'neutral', label: 'Bootstrap' },
};

export function sourceTone(source) {
  const key = (source || '').toLowerCase();
  return SOURCE_MAP[key] || { tone: 'neutral', label: source || 'Unknown' };
}

// ---------------------------------------------------------------------------
// Audit log action categories
// ---------------------------------------------------------------------------
const AUDIT_CATEGORY_TONE = {
  auth: 'info',
  user: 'accent',
  group: 'accent',
  server: 'info',
  customer: 'neutral',
  policy: 'warning',
  access_request: 'success',
  cert: 'danger',
  ca: 'danger',
  session: 'neutral',
  org: 'neutral',
  connector: 'neutral',
};

export function auditCategoryTone(category) {
  return AUDIT_CATEGORY_TONE[category] || 'neutral';
}

export function certificateStatusTone(status) {
  const key = (status || '').toLowerCase();
  if (key === 'active') return { tone: 'success', label: 'Active' };
  if (key === 'revoked') return { tone: 'danger', label: 'Revoked' };
  if (key === 'expired') return { tone: 'neutral', label: 'Expired' };
  return { tone: 'neutral', label: status || 'Unknown' };
}

// ---------------------------------------------------------------------------
// Posture — finding severity
// ---------------------------------------------------------------------------
// No new colour vocabulary: severity is expressed with the same five tones,
// using `variant` (solid vs outline, an existing Badge prop) to separate the
// two severities that would otherwise share a tone. Ordered worst -> best:
//   CRITICAL  danger  solid    — the DOCKER_FIREWALL_BYPASS-class findings
//   HIGH      danger  outline  — reachable / no usable firewall
//   MEDIUM    warning solid    — exposed only by a firewall rule
//   LOW       warning outline  — stale rule / unattributed / LAN-only
//   INFO      info    outline  — expected-public, informational
const SEVERITY_MAP = {
  critical: { tone: 'danger', variant: 'solid', label: 'Critical' },
  high: { tone: 'danger', variant: 'outline', label: 'High' },
  medium: { tone: 'warning', variant: 'solid', label: 'Medium' },
  low: { tone: 'warning', variant: 'outline', label: 'Low' },
  info: { tone: 'info', variant: 'outline', label: 'Info' },
};

export function severityTone(severity) {
  const key = (severity || '').toLowerCase();
  return SEVERITY_MAP[key] || { tone: 'neutral', variant: 'solid', label: severity || 'Unknown' };
}

/** Severities worst -> best, for filter dropdowns and sort order. */
export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

// ---------------------------------------------------------------------------
// Posture — finding status (open / muted / resolved)
// ---------------------------------------------------------------------------
const FINDING_STATUS_MAP = {
  open: { tone: 'warning', label: 'Open' },
  muted: { tone: 'neutral', label: 'Muted' },
  resolved: { tone: 'success', label: 'Resolved' },
};

export function findingStatusTone(status) {
  const key = (status || '').toLowerCase();
  return FINDING_STATUS_MAP[key] || { tone: 'neutral', label: status || 'Unknown' };
}

// ---------------------------------------------------------------------------
// Posture — reachability (host listeners)
// ---------------------------------------------------------------------------
const REACHABILITY_MAP = {
  internet: { tone: 'danger', label: 'Internet' },
  lan: { tone: 'warning', label: 'LAN' },
  firewalled: { tone: 'success', label: 'Firewalled' },
  loopback: { tone: 'neutral', label: 'Loopback' },
  // A port a container EXPOSEs without publishing: genuinely listening, but
  // inside its own network namespace, so the host cannot reach it and
  // neither can anything else. Its own value rather than null, which the
  // table would render as "Unknown" — the one reading that is wrong.
  container: { tone: 'neutral', label: 'Container-internal' },
};

export function reachabilityTone(reachability) {
  const key = (reachability || '').toLowerCase();
  return REACHABILITY_MAP[key] || { tone: 'neutral', label: reachability || 'Unknown' };
}
