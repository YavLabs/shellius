/**
 * agentToken.js — per-host agent credential helpers.
 *
 * Replaces the single, org-wide AGENT_SHARED_SECRET with a fresh random
 * token minted every time a bootstrap script is generated for a specific
 * server. Only the SHA-256 hash is ever persisted (Server.agentTokenHash);
 * the plaintext token is embedded once in the generated install script and
 * never stored server-side. Re-running bootstrap mints a new token and
 * overwrites the old hash, which invalidates the previous token — this is
 * how "rotation" works for this credential.
 *
 * NEVER log the plaintext token.
 */

import crypto from 'crypto';

export const AGENT_TOKEN_PREFIX = 'shag_';

/**
 * Mint a new per-host agent token.
 * @returns {{ token: string, hash: string }} token = plaintext (embed in
 *   script, return to caller, never persist); hash = sha256 hex digest to
 *   store in Server.agentTokenHash.
 */
export function generateAgentToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  const token = `${AGENT_TOKEN_PREFIX}${raw}`;
  return { token, hash: hashAgentToken(token) };
}

/**
 * SHA-256 hex digest of a plaintext agent token, for storage/lookup.
 * Not a secret-comparison primitive itself — the lookup is a DB equality
 * query against the hash, so the plaintext token is never compared
 * byte-by-byte in application code (no bespoke timing side channel).
 * @param {string} token
 * @returns {string}
 */
export function hashAgentToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export default { generateAgentToken, hashAgentToken, AGENT_TOKEN_PREFIX };
