/**
 * apiToken.js — API token helpers.
 *
 * Same shape as agentToken.js, for the same reasons: a prefix so a leaked
 * string is recognisable (and scannable by secret scanners), 256 bits of
 * CSPRNG entropy, and only the SHA-256 hash persisted.
 *
 * SHA-256 rather than bcrypt is deliberate. The input is 32 random bytes,
 * not a human-chosen password, so there is no dictionary to slow down — and
 * the lookup has to be a single indexed equality query on a path that runs
 * for every API call. The plaintext is never compared byte-by-byte in
 * application code, so there is no bespoke timing side channel either.
 *
 * NEVER log the plaintext token.
 */

import crypto from 'crypto';

export const PERSONAL_TOKEN_PREFIX = 'shp_';
export const SERVICE_TOKEN_PREFIX = 'shs_';
export const API_TOKEN_PREFIXES = [PERSONAL_TOKEN_PREFIX, SERVICE_TOKEN_PREFIX];

/** Characters of plaintext kept for display: the prefix plus 8. */
const DISPLAY_CHARS = 8;

/**
 * Mint a token.
 *
 * @param {'personal'|'service'} kind
 * @returns {{ token: string, hash: string, prefix: string }}
 *   token  — plaintext, returned to the caller exactly once, never stored;
 *   hash   — sha256 hex for ApiToken.tokenHash;
 *   prefix — the leading characters, for telling tokens apart in the UI.
 */
export function generateApiToken(kind) {
  const lead = kind === 'service' ? SERVICE_TOKEN_PREFIX : PERSONAL_TOKEN_PREFIX;
  const token = `${lead}${crypto.randomBytes(32).toString('base64url')}`;
  return {
    token,
    hash: hashApiToken(token),
    prefix: token.slice(0, lead.length + DISPLAY_CHARS),
  };
}

/** SHA-256 hex digest of a plaintext token, for storage and lookup. */
export function hashApiToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Whether a bearer string is one of ours. Used to decide which
 * authentication path a request takes, before any database work.
 */
export function looksLikeApiToken(value) {
  const s = String(value || '');
  return API_TOKEN_PREFIXES.some((p) => s.startsWith(p));
}

/** The kind a plaintext token belongs to, or null if it isn't one of ours. */
export function kindOfToken(value) {
  const s = String(value || '');
  if (s.startsWith(SERVICE_TOKEN_PREFIX)) return 'service';
  if (s.startsWith(PERSONAL_TOKEN_PREFIX)) return 'personal';
  return null;
}

export default {
  PERSONAL_TOKEN_PREFIX,
  SERVICE_TOKEN_PREFIX,
  API_TOKEN_PREFIXES,
  generateApiToken,
  hashApiToken,
  looksLikeApiToken,
  kindOfToken,
};
