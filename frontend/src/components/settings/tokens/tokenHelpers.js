/**
 * tokenHelpers.js — pure status/formatting logic shared by the personal
 * access tokens card (Profile) and the service accounts tab
 * (Administration), kept free of React so it's trivial to unit test.
 *
 * Token = { revokedAt, expiresAt, ... } — see services/apiTokenService.js
 * for the full shape. Never pass the plaintext `token` value in here; this
 * module only ever sees the metadata a list/get call returns.
 */

export function isTokenExpired(token) {
  if (!token?.expiresAt) return false;
  const t = new Date(token.expiresAt).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

export function isTokenRevoked(token) {
  return !!token?.revokedAt;
}

/**
 * 'revoked' | 'expired' | 'active' — a revoked token is reported as revoked
 * even if it would also have expired by now (revocation is the action that
 * mattered to whoever did it).
 */
export function tokenStatus(token) {
  if (isTokenRevoked(token)) return 'revoked';
  if (isTokenExpired(token)) return 'expired';
  return 'active';
}

/** Whether a token can still be used to authenticate. */
export function isTokenUsable(token) {
  return tokenStatus(token) === 'active';
}

const STATUS_BADGE = {
  active: { tone: 'success', label: 'Active' },
  expired: { tone: 'neutral', label: 'Expired' },
  revoked: { tone: 'danger', label: 'Revoked' },
};

/** { tone, label } for the Badge component, keyed off tokenStatus(). */
export function tokenStatusBadge(token) {
  return STATUS_BADGE[tokenStatus(token)];
}

/**
 * Human text for a token's expiry:
 *   no expiresAt          → "Never expires"
 *   in the future          → "Expires today" / "Expires in 5 days"
 *   in the past             → "Expired today" / "Expired 3 days ago"
 */
export function formatTokenExpiry(expiresAt) {
  if (!expiresAt) return 'Never expires';
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return 'Never expires';
  const diffMs = d.getTime() - Date.now();
  const days = Math.round(Math.abs(diffMs) / 86400000);
  if (diffMs <= 0) return days === 0 ? 'Expired today' : `Expired ${days} day${days === 1 ? '' : 's'} ago`;
  return days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

// Options offered by the "expires in" pickers on both create-token forms.
// `value: ''` means "never expires" (expiresInDays omitted from the request).
export const TOKEN_EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '1 year' },
  { value: '', label: 'Never expires' },
];
