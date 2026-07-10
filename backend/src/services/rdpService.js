/**
 * rdpService.js
 *
 * Guacamole RDP integration service.
 *
 * Responsibilities:
 *   - Encrypt / decrypt RDP credentials stored on the Server model
 *   - Perform the Guacamole handshake over a raw TCP socket to guacd and
 *     return the connected net.Socket ready for bidirectional proxying
 *   - Issue short-lived gateway JWT tokens for the WebSocket RDP proxy
 *   - Load and validate access requests before opening a Guacamole connection
 *
 * Architecture note:
 *   The Guacamole protocol is a text-based format where each "instruction"
 *   is a comma-separated list of length-prefixed fields ending with a
 *   semicolon.  Example: `4.size,4.1280,3.800,2.96;`
 *   This module hand-rolls the handshake because no widely-maintained
 *   npm guacd client exists.
 *
 * Security:
 *   - RDP passwords are decrypted in memory only during the guacd handshake
 *   - Gateway tokens expire in 5 minutes and carry only (accessRequestId,
 *     userId, sub) — no credentials
 *   - NEVER log decrypted passwords, tokens, or credential material
 */

import net from 'net';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import { encrypt, decrypt } from '../utils/crypto.js';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import config from '../config/index.js';

// ---------------------------------------------------------------------------
// Environment config
// ---------------------------------------------------------------------------

const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = parseInt(process.env.GUACD_PORT, 10) || 4822;
const GATEWAY_TOKEN_TTL = '5m';
const PUBLIC_GATEWAY_HOST = process.env.PUBLIC_GATEWAY_HOST || 'localhost';

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
  const password = decryptRdpPassword(server) ?? '';
  const settings = {
    hostname: server.ipAddress || server.hostname,
    port: String(server.rdpPort ?? server.port ?? 3389),
    username: server.rdpUsername ?? '',
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
// Guacamole protocol helpers
// ---------------------------------------------------------------------------

/**
 * Encode a single Guacamole instruction.
 *
 * Each field is represented as `<length>.<value>` and fields are joined with
 * commas. The instruction is terminated with a semicolon.
 *
 * @param {...(string|number)} parts
 * @returns {string}
 *
 * @example
 *   encodeInstruction('select', 'rdp')  →  '6.select,3.rdp;'
 */
export function encodeInstruction(...parts) {
  const fields = parts.map((p) => {
    const s = String(p);
    return `${s.length}.${s}`;
  });
  return fields.join(',') + ';';
}

/**
 * Parse all complete Guacamole instructions from a string buffer.
 *
 * Returns { instructions, remainder } where instructions is an array of
 * string[] (one entry per parsed field within the instruction) and remainder
 * is the unparsed tail of the buffer.
 *
 * @param {string} buffer
 * @returns {{ instructions: string[][], remainder: string }}
 */
export function parseInstructions(buffer) {
  const instructions = [];
  let pos = 0;

  while (pos < buffer.length) {
    const semicolon = buffer.indexOf(';', pos);
    if (semicolon === -1) break; // incomplete instruction

    const raw = buffer.slice(pos, semicolon);
    pos = semicolon + 1;

    const fields = [];
    let fieldPos = 0;

    while (fieldPos < raw.length) {
      const dot = raw.indexOf('.', fieldPos);
      if (dot === -1) break;
      const len = parseInt(raw.slice(fieldPos, dot), 10);
      if (isNaN(len)) break;
      const value = raw.slice(dot + 1, dot + 1 + len);
      fields.push(value);
      fieldPos = dot + 1 + len;
      // Skip optional comma separator
      if (fieldPos < raw.length && raw[fieldPos] === ',') fieldPos++;
    }

    if (fields.length > 0) {
      instructions.push(fields);
    }
  }

  return { instructions, remainder: buffer.slice(pos) };
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

// ---------------------------------------------------------------------------
// Guacamole handshake — createGuacdConnection
// ---------------------------------------------------------------------------

/**
 * Open a TCP connection to guacd and complete the Guacamole RDP handshake.
 *
 * Protocol sequence:
 *   C→S  select rdp
 *   S→C  args  <param-name-list>
 *   C→S  size  <width> <height> <dpi>
 *   C→S  audio <supported-mime-types…>
 *   C→S  video <supported-mime-types…>
 *   C→S  image <supported-mime-types…>
 *   C→S  connect <values aligned to args order>
 *   (socket is now in streaming / tunnel mode)
 *
 * @param {object} opts
 * @param {object} opts.server          - Prisma Server row (includes rdp* fields)
 * @param {number} [opts.width=1280]
 * @param {number} [opts.height=800]
 * @param {number} [opts.dpi=96]
 * @returns {Promise<net.Socket>}       - Resolved after successful handshake
 */
export function createGuacdConnection({ server, width = 1280, height = 800, dpi = 96 }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let rxBuf = '';
    let handshakeDone = false;

    const fail = (msg, err) => {
      if (!handshakeDone) {
        socket.destroy();
        reject(err || new Error(msg));
      }
    };

    socket.setEncoding('utf8');
    socket.setTimeout(10000);

    socket.on('timeout', () => fail('guacd handshake timed out'));
    socket.on('error', (err) => fail('guacd socket error', err));

    // Accumulate data and process complete instructions
    socket.on('data', (chunk) => {
      if (handshakeDone) return; // post-handshake data handled by proxy layer
      rxBuf += chunk;

      const { instructions, remainder } = parseInstructions(rxBuf);
      rxBuf = remainder;

      for (const fields of instructions) {
        if (fields[0] === 'args') {
          // fields[1..n] are the parameter names guacd expects in order
          const paramNames = fields.slice(1);

          // Decrypt RDP password transiently — only in this closure
          let rdpPassword = null;
          try {
            rdpPassword = decryptRdpPassword(server);
          } catch (decryptErr) {
            logger.error('rdpService: failed to decrypt RDP password', {
              serverId: server.id,
              error: decryptErr.message,
            });
            fail('credential decryption failed', decryptErr);
            return;
          }

          // Map known parameter names to values.
          // guacd connects to the target directly, so it must receive a
          // routable IP — not the server's display hostname (e.g. "glovius"),
          // which guacd cannot DNS-resolve. Mirror the SSH path, which prefers
          // ipAddress. For dynamicIp servers the connect-time override is
          // already persisted into ipAddress before this handshake runs.
          const knownParams = {
            hostname: server.ipAddress || server.hostname,
            port: String(server.rdpPort ?? server.port ?? 3389),
            username: server.rdpUsername ?? '',
            password: rdpPassword ?? '',
            security: 'any',
            'ignore-cert': 'true',
            domain: '',
            width: String(width),
            height: String(height),
            dpi: String(dpi),
            'color-depth': '24',
            'enable-wallpaper': 'false',
            'enable-font-smoothing': 'true',
            'enable-full-window-drag': 'false',
            'enable-desktop-composition': 'false',
            'enable-menu-animations': 'false',
            'enable-audio': 'true',
            'disable-auth': 'false',
          };

          const connectValues = paramNames.map((name) => knownParams[name] ?? '');

          // Zero the password from local scope immediately after use
          rdpPassword = null;

          // Send size, audio, video, image, then connect
          socket.write(encodeInstruction('size', width, height, dpi));
          socket.write(encodeInstruction('audio', 'audio/L16'));
          socket.write(encodeInstruction('video'));
          socket.write(encodeInstruction('image', 'image/png', 'image/jpeg'));
          socket.write(encodeInstruction('connect', ...connectValues));

          // Remove the timeout — handshake is complete; proxy layer takes over
          socket.setTimeout(0);
          socket.removeAllListeners('timeout');
          socket.removeAllListeners('error');
          socket.removeAllListeners('data');

          handshakeDone = true;

          logger.info('rdpService.createGuacdConnection: handshake complete', {
            serverId: server.id,
            hostname: server.hostname,
            connectHost: server.ipAddress || server.hostname,
            guacdHost: GUACD_HOST,
            guacdPort: GUACD_PORT,
          });

          resolve(socket);
          return;
        }

        // Unexpected instruction before args
        logger.warn('rdpService.createGuacdConnection: unexpected instruction during handshake', {
          opcode: fields[0],
        });
      }
    });

    socket.connect(GUACD_PORT, GUACD_HOST, () => {
      socket.write(encodeInstruction('select', 'rdp'));
    });
  });
}

// ---------------------------------------------------------------------------
// Gateway token
// ---------------------------------------------------------------------------

/**
 * Issue a short-lived JWT gateway token for an approved RDP access request.
 *
 * The token is used by the WebSocket proxy to authenticate the client
 * without re-exposing any credentials.  It carries only:
 *   { sub: 'rdp-gateway', accessRequestId, userId }
 *
 * @param {object} params
 * @param {string} params.accessRequestId
 * @param {string} params.userId
 * @returns {string}
 */
function issueGatewayToken({ accessRequestId, userId }) {
  return jwt.sign(
    { sub: 'rdp-gateway', accessRequestId, userId },
    config.jwt.secret,
    { expiresIn: GATEWAY_TOKEN_TTL }
  );
}

/**
 * Verify an RDP gateway token issued by issueGatewayToken.
 *
 * @param {string} token
 * @returns {{ sub: string, accessRequestId: string, userId: string, iat: number, exp: number }}
 * @throws {Error} if invalid or expired
 */
export function verifyGatewayToken(token) {
  const claims = jwt.verify(token, config.jwt.secret);
  if (claims.sub !== 'rdp-gateway') {
    throw new Error('Token is not an RDP gateway token');
  }
  return claims;
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
 * @returns {Promise<{ server: object, gatewayToken: string }>}
 */
export async function createConnectionForRequest(accessRequestId) {
  const accessRequest = await prisma.accessRequest.findUnique({
    where: { id: accessRequestId },
    include: {
      server: true,
      requester: { select: { id: true, name: true, email: true } },
    },
  });

  if (!accessRequest) throw new ApiError(404, 'Access request not found');
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
  if (!server.rdpPasswordEncrypted) {
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

// ---------------------------------------------------------------------------
// revokeConnection
// ---------------------------------------------------------------------------

/**
 * Forcefully destroy a guacd socket, ending the RDP tunnel.
 *
 * @param {net.Socket} socket
 */
export function revokeConnection(socket) {
  try {
    socket.destroy();
  } catch (err) {
    logger.warn('rdpService.revokeConnection: error destroying socket', { error: err.message });
  }
}

export default {
  encryptRdpPassword,
  decryptRdpPassword,
  encodeInstruction,
  parseInstructions,
  createGuacdConnection,
  verifyGatewayToken,
  createConnectionForRequest,
  revokeConnection,
};
