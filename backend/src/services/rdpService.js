/**
 * rdpService.js
 *
 * Everything the RDP path needs BEFORE a socket exists: credential storage,
 * credential resolution, and the connection token the browser carries.
 *
 * The socket itself is not here. `terminalService.buildGuacamoleServer()`
 * hands the WebSocket to guacamole-lite, which speaks the Guacamole protocol
 * to guacd. This module used to hand-roll that handshake as well
 * (`createGuacdConnection`, `encodeInstruction`, `parseInstructions`) and to
 * mint a separate JWT for a gateway (`issueGatewayToken`,
 * `verifyGatewayToken`, `revokeConnection`). All six were superseded by
 * guacamole-lite and had **no callers** — while their surrounding comments
 * were still the canonical description of how RDP worked, which is how the
 * route handlers, the .rdp file and the frontend all came to describe the
 * connection token as "a short-lived JWT". Removed in 2.1.
 *
 * What the token actually is: `buildRdpToken` returns an AES-256-CBC blob in
 * guacamole-lite's own format, whose plaintext contains the connection
 * settings — INCLUDING the host's RDP password. It is opaque to the browser
 * (only the backend holds the key, derived from the JWT secret) but it is
 * still a credential in transit, so it is treated as one: five-minute
 * expiry, checked in `processConnectionSettings` at connect time, never
 * written to disk and never logged.
 *
 * Security:
 *   - RDP passwords are decrypted in memory only while building a token
 *   - NEVER log decrypted passwords, tokens, or credential material
 */

import crypto from 'crypto';
import { UNSCOPED, isUnscoped } from '../lib/scope.js';

import { encrypt, decrypt } from '../utils/crypto.js';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import config from '../config/index.js';

// ---------------------------------------------------------------------------
// Environment config
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// guacamole-lite token encryption
//
// The browser tunnels RDP through guacamole-lite (see terminalService). The
// connection settings (including the decrypted RDP password) are handed to the
// browser as an AES-256-CBC encrypted, opaque token — only this backend holds
// the key, so the password is never exposed to the frontend. The format must
// match guacamole-lite's Crypt.decrypt: base64(JSON({ iv, value })) where value
// is base64 ciphertext. The key is a 32-byte string derived from the JWT secret
// and is shared with guacamole-lite via clientOptions.crypt.key.
// ---------------------------------------------------------------------------

export const GUAC_CRYPT_CYPHER = 'AES-256-CBC';
export const GUAC_CRYPT_KEY = crypto
  .createHash('sha256')
  .update(String(config.jwt.secret))
  .digest('hex')
  .slice(0, 32); // 32 ASCII chars = 32 bytes for AES-256

const GUAC_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Encrypt an arbitrary object into a guacamole-lite connection token.
 * @param {object} obj
 * @returns {string} base64(JSON({ iv, value }))
 */
export function encryptGuacToken(obj) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(GUAC_CRYPT_CYPHER.toLowerCase(), Buffer.from(GUAC_CRYPT_KEY), iv);
  let value = cipher.update(JSON.stringify(obj), 'utf8', 'base64');
  value += cipher.final('base64');
  const data = { iv: iv.toString('base64'), value };
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

/**
 * Build the encrypted guacamole-lite token for an RDP server. Carries the guacd
 * RDP settings plus top-level metadata (orgId/serverId/userId/accessRequestId)
 * used for session tracking, and an expiration enforced at connect time.
 *
 * @param {object} params
 * @param {object} params.accessRequest  - AccessRequest row (orgId, requesterId, id)
 * @param {object} params.server         - Server row (incl. rdp* fields)
 * @returns {string} encrypted token
 */
export function buildRdpToken({ accessRequest, server }) {
  const { username, password } = resolveRdpCredentials(server);
  const settings = {
    hostname: server.ipAddress || server.hostname,
    port: String(server.rdpPort ?? server.port ?? 3389),
    username,
    password,
    security: 'any',
    'ignore-cert': 'true',
    'enable-wallpaper': 'false',
    'resize-method': 'display-update',
  };
  const token = {
    connection: { type: 'rdp', settings },
    // top-level metadata (preserved on connectionSettings, not sent to guacd)
    expiration: Date.now() + GUAC_TOKEN_TTL_MS,
    orgId: accessRequest.orgId,
    serverId: server.id,
    userId: accessRequest.requesterId,
    accessRequestId: accessRequest.id,
  };
  return encryptGuacToken(token);
}

// ---------------------------------------------------------------------------
// Credential encryption / decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext RDP password using AES-256-GCM (via utils/crypto.js).
 *
 * The returned object maps directly to the Server model's rdpPassword* fields.
 * utils/crypto.js packs iv + authTag + ciphertext into a single base64 blob,
 * so we store the blob in rdpPasswordEncrypted and leave iv/tag empty strings
 * as shims for schema compatibility.
 *
 * @param {string} plain
 * @returns {{ rdpPasswordEncrypted: string, rdpPasswordIv: string, rdpPasswordTag: string }}
 */
export function encryptRdpPassword(plain) {
  const blob = encrypt(plain); // base64: [iv(12)] [tag(16)] [ciphertext]
  return {
    rdpPasswordEncrypted: blob,
    rdpPasswordIv: '',   // packed into blob; kept for schema compat
    rdpPasswordTag: '',  // packed into blob; kept for schema compat
  };
}

/**
 * Decrypt the RDP password stored on a Server record.
 *
 * @param {{ rdpPasswordEncrypted: string|null }} server
 * @returns {string|null}
 */
export function decryptRdpPassword(server) {
  if (!server.rdpPasswordEncrypted) return null;
  return decrypt(server.rdpPasswordEncrypted);
}

/**
 * Resolve the RDP username/password to use for a connection. Credential-mode
 * (Keystore) servers with a password-bearing identity use that identity's
 * username/password instead of Server.rdpUsername/rdpPasswordEncrypted.
 *
 * @param {object} server - must include `credential` when authMode is 'credential'
 * @returns {{ username: string, password: string }}
 */
export function resolveRdpCredentials(server) {
  if (server.authMode === 'credential' && server.credential) {
    const password = server.credential.passwordEncrypted ? decrypt(server.credential.passwordEncrypted) : '';
    return { username: server.credential.username || '', password };
  }
  return { username: server.rdpUsername ?? '', password: decryptRdpPassword(server) ?? '' };
}

// ---------------------------------------------------------------------------
// createConnectionForRequest
// ---------------------------------------------------------------------------

/**
 * Validate an approved RDP access request and produce a gateway token.
 *
 * Does NOT open a guacd socket here — that happens inside the WebSocket
 * upgrade handler when the client actually connects.
 *
 * @param {string} accessRequestId
 * @param {object} [scope] - caller's customer scope. Checked HERE, at
 *   redemption, not only when the request was approved: scope can be narrowed
 *   after an approval, and the SSH path already re-checks at redemption
 *   (terminalService). Without this the RDP half of the same guarantee is
 *   missing (docs/rbac/customer-scope-spec.md §4.2 #24).
 * @returns {Promise<{ server: object, gatewayToken: string }>}
 */
export async function createConnectionForRequest(accessRequestId, scope = UNSCOPED) {
  const accessRequest = await prisma.accessRequest.findUnique({
    where: { id: accessRequestId },
    include: {
      server: { include: { credential: true } },
      requester: { select: { id: true, name: true, email: true } },
    },
  });

  if (!accessRequest) throw new ApiError(404, 'Access request not found');
  // Out-of-scope target is indistinguishable from a missing request.
  if (!isUnscoped(scope) && !scope.customerIds.includes(accessRequest.server?.customerId)) {
    throw new ApiError(404, 'Access request not found');
  }
  if (accessRequest.status !== 'APPROVED') {
    throw new ApiError(409, `Access request is not approved (status: ${accessRequest.status})`);
  }

  const now = new Date();
  if (!accessRequest.expiresAt || accessRequest.expiresAt <= now) {
    throw new ApiError(410, 'Access request has expired');
  }

  if (accessRequest.protocol !== 'RDP') {
    throw new ApiError(400, 'Access request protocol is not RDP');
  }

  const server = accessRequest.server;
  if (!server) throw new ApiError(404, 'Server not found on access request');
  const hasCredentialPassword = server.authMode === 'credential' && !!server.credential?.passwordEncrypted;
  if (!server.rdpPasswordEncrypted && !hasCredentialPassword) {
    throw new ApiError(400, 'No RDP password configured for this server');
  }

  // Encrypted guacamole-lite connection token (carries the RDP settings; the
  // password stays opaque to the browser).
  const gatewayToken = buildRdpToken({ accessRequest, server });

  logger.info('rdpService.createConnectionForRequest: RDP connection token issued', {
    accessRequestId,
    userId: accessRequest.requesterId,
    serverId: server.id,
  });

  return { server, gatewayToken };
}

export default {
  GUAC_CRYPT_CYPHER,
  GUAC_CRYPT_KEY,
  GUAC_TOKEN_TTL_MS,
  encryptGuacToken,
  buildRdpToken,
  encryptRdpPassword,
  decryptRdpPassword,
  resolveRdpCredentials,
  createConnectionForRequest,
};
