/**
 * terminalService.js
 *
 * WebSocket-to-SSH proxy for the Shellius web terminal.
 *
 * Upgrade path: GET /api/terminal/ssh?token=<JWT>&requestId=<id>[&rows=24&cols=80]
 *
 * Security:
 *   - JWT verified before upgrade is accepted
 *   - Access request must be APPROVED and not expired
 *   - generateSshCredentials is called per-connection (ephemeral Ed25519 + CA cert)
 *   - Private key string is zeroed (Buffer.fill(0)) after ssh2 Client.connect() call
 *   - Session is created ACTIVE on connect, ended on any close/error
 *
 * TODO(phase-8C): Tee SSH stream output to asciinema .cast recording file
 *   - On stream.on('data', chunk) { teeChunk(recordingWriter, chunk) }
 *   - On session end, finalize and persist recordingPath to Session row
 */

import { WebSocketServer } from 'ws';
import { Client as SshClient } from 'ssh2';
import { parse as parseQuery } from 'querystring';
import { URL } from 'url';

import { verifyAccessToken } from '../utils/jwt.js';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import * as accessRequestService from './accessRequestService.js';
import * as sessionService from './sessionService.js';

// ---------------------------------------------------------------------------
// In-memory map of active connections
// key: sessionId → { ws, sshClient, stream }
// ---------------------------------------------------------------------------
const activeSessions = new Map();

// ---------------------------------------------------------------------------
// attachWebSocketServer
// ---------------------------------------------------------------------------

/**
 * Attach a WebSocket server to an existing http.Server.
 * Handles upgrades only for the path /api/terminal/ssh.
 *
 * @param {import('http').Server} httpServer
 */
export function attachWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    // Only handle our terminal path
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== '/api/terminal/ssh') {
      // Let other upgrade handlers (if any) deal with it
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    handleConnection(ws, req).catch((err) => {
      logger.error('terminalService: unhandled error in handleConnection', {
        error: err.message,
      });
      safeClose(ws, 1011, 'Internal server error');
    });
  });

  logger.info('terminalService: WebSocket SSH proxy attached on /api/terminal/ssh');
}

// ---------------------------------------------------------------------------
// handleConnection — full lifecycle for one WebSocket upgrade
// ---------------------------------------------------------------------------

async function handleConnection(ws, req) {
  // ── 1. Parse query parameters ──────────────────────────────────────────
  let query;
  try {
    query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  } catch {
    safeClose(ws, 1008, 'Malformed request URL');
    return;
  }

  const { token, requestId } = query;
  const rows = Math.max(1, parseInt(query.rows, 10) || 24);
  const cols = Math.max(1, parseInt(query.cols, 10) || 80);

  if (!token) {
    safeClose(ws, 1008, 'Missing token');
    return;
  }
  if (!requestId) {
    safeClose(ws, 1008, 'Missing requestId');
    return;
  }

  // ── 2. Verify JWT ─────────────────────────────────────────────────────
  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch {
    safeClose(ws, 1008, 'Invalid or expired token');
    return;
  }

  const { userId, orgId, role } = decoded;

  // ── 3. Load user from DB ──────────────────────────────────────────────
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) {
    safeClose(ws, 1008, 'User not found');
    return;
  }

  // ── 4. Validate access request ────────────────────────────────────────
  let accessRequest;
  try {
    accessRequest = await accessRequestService.getById({
      requestId,
      callerId: userId,
      callerRole: role,
    });
  } catch (err) {
    safeClose(ws, 1008, err.message || 'Access request not found');
    return;
  }

  if (accessRequest.status !== 'APPROVED') {
    safeClose(ws, 1008, `Access request is not approved (status: ${accessRequest.status})`);
    return;
  }
  if (!accessRequest.expiresAt || accessRequest.expiresAt <= new Date()) {
    safeClose(ws, 1008, 'Access request has expired');
    return;
  }

  // ── 5. Generate ephemeral SSH credentials ────────────────────────────
  let credentials;
  try {
    credentials = await accessRequestService.generateSshCredentials({
      requestId,
      callerId: userId,
    });
  } catch (err) {
    logger.error('terminalService: credential generation failed', {
      requestId,
      userId,
      error: err.message,
    });
    safeClose(ws, 1011, 'Failed to generate SSH credentials');
    return;
  }

  const { hostname, port, username, expiresAt } = credentials;
  // Keep a mutable buffer so we can zero it after ssh2 connects
  let privateKeyBuf = Buffer.from(credentials.privateKey, 'utf8');
  const certificate = credentials.certificate;
  // Null the string reference — buffer holds the only copy from here
  credentials.privateKey = null;

  // ── 6. Create Session row ────────────────────────────────────────────
  const clientIp =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null;
  const userAgent = req.headers['user-agent'] || null;

  let session;
  try {
    session = await sessionService.create({
      orgId,
      userId,
      serverId: accessRequest.serverId,
      certificateId: accessRequest.certificateId ?? null,
      accessRequestId: requestId,
      sessionType: 'SSH',
      clientIp,
      userAgent,
      metadata: { rows, cols, hostname, port, username },
    });
  } catch (err) {
    logger.error('terminalService: failed to create session row', { error: err.message });
    privateKeyBuf.fill(0);
    safeClose(ws, 1011, 'Failed to create session');
    return;
  }

  const sessionId = session.id;
  logger.info('terminalService: SSH session starting', {
    sessionId,
    userId,
    orgId,
    hostname,
    port,
  });

  // ── 7. Establish SSH connection ───────────────────────────────────────
  const sshClient = new SshClient();

  // Track cleanup state to avoid double-ending the session
  let ended = false;

  const cleanup = async (statusOverride) => {
    if (ended) return;
    ended = true;

    activeSessions.delete(sessionId);

    try {
      await sessionService.end(sessionId, { status: statusOverride ?? 'ENDED' });
    } catch (err) {
      logger.warn('terminalService: session end write failed', {
        sessionId,
        error: err.message,
      });
    }
  };

  sshClient.on('error', (err) => {
    logger.error('terminalService: SSH client error', { sessionId, error: err.message });
    safeClose(ws, 1011, 'SSH connection error');
    cleanup('TERMINATED');
  });

  sshClient.on('close', () => {
    safeClose(ws, 1000, 'SSH connection closed');
    cleanup('ENDED');
  });

  sshClient.on('ready', () => {
    // Zero out the private key buffer now that ssh2 has consumed it
    privateKeyBuf.fill(0);
    privateKeyBuf = null;

    sshClient.shell(
      { term: 'xterm-256color', rows, cols },
      (err, stream) => {
        if (err) {
          logger.error('terminalService: shell open failed', { sessionId, error: err.message });
          safeClose(ws, 1011, 'Failed to open shell');
          sshClient.end();
          cleanup('TERMINATED');
          return;
        }

        // Register in active map now that we have all three handles
        activeSessions.set(sessionId, { ws, sshClient, stream });

        // ── SSH → WebSocket ──
        stream.on('data', (chunk) => {
          // TODO(phase-8C): tee chunk to recording writer here
          if (ws.readyState === ws.constructor.OPEN) {
            ws.send(chunk);
          }
        });

        stream.stderr.on('data', (chunk) => {
          if (ws.readyState === ws.constructor.OPEN) {
            ws.send(chunk);
          }
        });

        stream.on('close', () => {
          safeClose(ws, 1000, 'Shell closed');
          sshClient.end();
          cleanup('ENDED');
        });

        // ── WebSocket → SSH ──
        ws.on('message', (msg) => {
          // Accept JSON control messages (resize) or raw binary/text stdin
          if (typeof msg === 'string') {
            // Try to parse as JSON resize event
            let parsed;
            try {
              parsed = JSON.parse(msg);
            } catch {
              // Plain text input — write directly
              stream.write(msg);
              return;
            }

            if (parsed.type === 'resize') {
              const newRows = Math.max(1, parseInt(parsed.rows, 10) || rows);
              const newCols = Math.max(1, parseInt(parsed.cols, 10) || cols);
              stream.setWindow(newRows, newCols, 0, 0);
            } else {
              // Unknown JSON message — pass through as text if it has a payload
              if (parsed.data !== undefined) {
                stream.write(String(parsed.data));
              }
            }
          } else {
            // Binary Buffer — raw stdin bytes
            stream.write(msg);
          }
        });

        ws.on('close', () => {
          sshClient.end();
          cleanup('ENDED');
        });

        ws.on('error', (err) => {
          logger.warn('terminalService: WebSocket error', { sessionId, error: err.message });
          sshClient.end();
          cleanup('TERMINATED');
        });
      }
    );
  });

  // Connect; use the buffer contents while connecting
  sshClient.connect({
    host: hostname,
    port,
    username,
    privateKey: privateKeyBuf,
    certificate,
    readyTimeout: 10000,
  });
}

// ---------------------------------------------------------------------------
// terminateSession — admin force-close
// ---------------------------------------------------------------------------

/**
 * Force-close an active WebSocket/SSH session by sessionId.
 * Delegates DB update to sessionService.terminate.
 *
 * @param {string} sessionId
 * @param {string} byUserId
 * @returns {Promise<object>} Updated session row
 */
export async function terminateSession(sessionId, byUserId) {
  // Update DB first — will throw if not ACTIVE
  const updated = await sessionService.terminate(sessionId, byUserId);

  // Force-close in-memory handles
  const entry = activeSessions.get(sessionId);
  if (entry) {
    activeSessions.delete(sessionId);
    try {
      entry.stream?.end();
    } catch { /* ignore */ }
    try {
      entry.sshClient?.end();
    } catch { /* ignore */ }
    safeClose(entry.ws, 1001, 'Session terminated by administrator');
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeClose(ws, code, reason) {
  try {
    if (ws.readyState === ws.constructor.OPEN || ws.readyState === ws.constructor.CONNECTING) {
      ws.close(code, reason);
    }
  } catch {
    // Ignore errors on already-closed sockets
  }
}

export default { attachWebSocketServer, terminateSession };
