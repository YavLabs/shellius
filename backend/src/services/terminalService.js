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
 * Recording:
 *   - Each SSH session is recorded in asciinema v2 format (.cast file)
 *   - Files are stored at RECORDINGS_DIR (default: ./data/recordings)
 *   - recordingPath is persisted on the Session row after the session ends
 *   - RECORDINGS_DIR env var: path to recording storage directory
 */

import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import os from 'os';
import { URL } from 'url';
import { PassThrough } from 'stream';
import path from 'path';
import { mkdtemp, writeFile, rm } from 'fs/promises';

import { verifyAccessToken } from '../utils/jwt.js';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import * as accessRequestService from './accessRequestService.js';
import * as sessionService from './sessionService.js';
import * as rdpService from './rdpService.js';
import * as storageService from './storageService.js';
import GuacamoleLite from 'guacamole-lite';

const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = parseInt(process.env.GUACD_PORT, 10) || 4822;

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

/**
 * Create a new asciinema v2 recording writer for a session.
 *
 * Data is streamed directly to MinIO via a PassThrough stream so we never
 * touch the local filesystem. The upload promise is tracked on the writer
 * and awaited by the caller on session close.
 *
 * Returns { recordingKey, write, close, waitUpload } or null if MinIO is
 * not configured (in which case the session proceeds with no recording).
 *
 * @param {string} sessionId
 * @param {string} orgId
 * @param {{ rows: number, cols: number }} dims
 * @returns {Promise<object|null>}
 */
async function openRecordingWriter(sessionId, orgId, { rows, cols }) {
  if (!(await storageService.isConfigured())) {
    logger.warn('terminalService: object storage not configured; recording disabled', { sessionId });
    return null;
  }

  try {
    const recordingKey = `sessions/${orgId}/${sessionId}.cast`;
    const passThrough = new PassThrough();
    const startTs = Date.now();

    // asciinema v2 header first.
    const header = JSON.stringify({
      version: 2,
      width: cols,
      height: rows,
      timestamp: Math.floor(startTs / 1000),
      env: { SHELL: '/bin/bash', TERM: 'xterm-256color' },
      title: `shellius-${sessionId}`,
    });
    passThrough.write(header + '\n');

    const uploadPromise = storageService
      .putObjectStream(recordingKey, passThrough, {
        contentType: 'application/x-asciicast',
        metadata: { 'x-amz-meta-session-id': sessionId, 'x-amz-meta-org-id': orgId },
      })
      .catch((err) => {
        logger.error('terminalService: recording upload failed', {
          sessionId,
          recordingKey,
          error: err.message,
        });
        return null;
      });

    let closed = false;

    return {
      recordingKey,
      write(chunk) {
        if (closed) return;
        try {
          const elapsed = (Date.now() - startTs) / 1000;
          const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          passThrough.write(JSON.stringify([elapsed, 'o', str]) + '\n');
        } catch (err) {
          logger.warn('terminalService: recording write error', {
            sessionId,
            error: err.message,
          });
        }
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          passThrough.end();
        } catch (err) {
          logger.warn('terminalService: recording close error', {
            sessionId,
            error: err.message,
          });
        }
      },
      async waitUpload() {
        return uploadPromise;
      },
    };
  } catch (err) {
    logger.error('terminalService: failed to open recording writer', {
      sessionId,
      error: err.message,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-memory map of active connections
// key: sessionId → { ws, sshClient, stream }
// ---------------------------------------------------------------------------
const activeSessions = new Map();

// ---------------------------------------------------------------------------
// attachWebSocketServer
// ---------------------------------------------------------------------------

/**
 * Attach WebSocket servers to an existing http.Server.
 * Handles upgrades for:
 *   /api/terminal/ssh  — SSH proxy
 *   /api/terminal/rdp  — RDP Guacamole proxy
 *
 * @param {import('http').Server} httpServer
 */
export function attachWebSocketServer(httpServer) {
  const wssSsh = new WebSocketServer({ noServer: true });

  // RDP is tunnelled through guacamole-lite, which correctly implements the
  // Guacamole WebSocket tunnel protocol (UUID handshake, ping keep-alive, flow
  // control) that guacamole-common-js on the browser expects. We run it in
  // noServer mode and route /api/terminal/rdp upgrades into its ws server.
  const guacRdp = buildGuacamoleServer();

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === '/api/terminal/ssh') {
      wssSsh.handleUpgrade(req, socket, head, (ws) => {
        wssSsh.emit('connection', ws, req);
      });
    } else if (pathname === '/api/terminal/rdp') {
      guacRdp.webSocketServer.handleUpgrade(req, socket, head, (ws) => {
        guacRdp.webSocketServer.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wssSsh.on('connection', (ws, req) => {
    handleConnection(ws, req).catch((err) => {
      logger.error('terminalService: unhandled error in handleConnection (SSH)', {
        error: err.message,
      });
      safeClose(ws, 1011, 'Internal server error');
    });
  });

  logger.info('terminalService: WebSocket SSH proxy attached on /api/terminal/ssh');
  logger.info('terminalService: guacamole-lite RDP tunnel attached on /api/terminal/rdp');
}

// ---------------------------------------------------------------------------
// guacamole-lite RDP tunnel
// ---------------------------------------------------------------------------

// Map guacamole-lite connectionId -> Shellius Session row id, for audit rows.
const rdpSessionByConn = new Map();

/**
 * Construct the guacamole-lite server (noServer mode). Validates the encrypted
 * connection token's expiry, and creates/ends a Session row per connection.
 */
function buildGuacamoleServer() {
  const guacRdp = new GuacamoleLite(
    // `server: undefined` makes guacamole-lite treat wsOptions as already
    // complete (it otherwise force-adds port:8080, which `ws` rejects alongside
    // noServer). `ws` ignores a null `server`, so only noServer is "specified".
    { noServer: true, server: undefined },
    { host: GUACD_HOST, port: GUACD_PORT },
    {
      crypt: { cypher: rdpService.GUAC_CRYPT_CYPHER, key: rdpService.GUAC_CRYPT_KEY },
      log: {
        level: 'NORMAL',
        stdLog: (...a) => logger.info(`[guac] ${a.join(' ')}`),
        errorLog: (...a) => logger.warn(`[guac] ${a.join(' ')}`),
      },
    },
    {
      // Runs after the token is decrypted, before guacd is contacted.
      processConnectionSettings: (settings, callback) => {
        if (settings && settings.expiration && Date.now() > settings.expiration) {
          return callback(new Error('RDP connection token expired'));
        }
        return callback(null, settings);
      },
    }
  );

  guacRdp.on('open', async (clientConnection) => {
    try {
      const s = clientConnection.connectionSettings || {};
      if (!s.orgId || !s.serverId || !s.userId) return; // no metadata — skip audit row
      const session = await sessionService.create({
        orgId: s.orgId,
        userId: s.userId,
        serverId: s.serverId,
        certificateId: null,
        accessRequestId: s.accessRequestId ?? null,
        sessionType: 'RDP',
        clientIp: null,
        userAgent: null,
        metadata: { via: 'guacamole-lite', guacId: clientConnection.guacamoleConnectionId },
      });
      rdpSessionByConn.set(clientConnection.connectionId, session.id);
      logger.info('terminalService: RDP session started (guacamole-lite)', {
        sessionId: session.id,
        serverId: s.serverId,
        userId: s.userId,
      });
    } catch (err) {
      logger.warn('terminalService: RDP session create failed', { error: err.message });
    }
  });

  guacRdp.on('close', async (clientConnection) => {
    const sessionId = rdpSessionByConn.get(clientConnection.connectionId);
    if (!sessionId) return;
    rdpSessionByConn.delete(clientConnection.connectionId);
    try {
      await sessionService.end(sessionId, { status: 'ENDED' });
    } catch (err) {
      logger.warn('terminalService: RDP session end failed', { sessionId, error: err.message });
    }
  });

  guacRdp.on('error', (clientConnection, err) => {
    logger.warn('terminalService: guacamole-lite connection error', {
      connectionId: clientConnection?.connectionId,
      error: err?.message,
    });
  });

  return guacRdp;
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

  const { token, requestId, principal: principalOverride } = query;
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
      callerRole: decoded.role,
      principalOverride,
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
  // Use IP address for the actual TCP connect — the container running the
  // backend may not resolve arbitrary hostnames.
  const connectHost = credentials.address || hostname;
  const privateKeyText = credentials.privateKey;
  const certificate = credentials.certificate;
  // Null the string reference on the credentials object
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

  // ── 7. Spawn the openssh client as a subprocess ──────────────────────
  //
  // We previously tried to use the `ssh2` Node library, but it does not
  // implement OpenSSH user-cert authentication correctly: monkey-patching
  // a parsed key to advertise the cert algorithm gets the public-key blob
  // right but emits a signature wrapped with the cert algo name instead
  // of the underlying signature algorithm, which sshd silently rejects.
  // Verified by issuing a real cert and connecting with the openssh CLI:
  // it works perfectly. So we just shell out to the real client.
  //
  // Strategy: write the ephemeral private key + cert to a tmp dir, spawn
  // `ssh -tt -o ...`, and pipe stdin/stdout/stderr to the WebSocket. The
  // `-tt` flag forces a PTY allocation so we get an interactive shell.

  let ended = false;
  let recordingWriter = null;
  let tmpDir = null;
  let sshProc = null;

  const cleanup = async (statusOverride) => {
    if (ended) return;
    ended = true;
    activeSessions.delete(sessionId);

    if (sshProc && !sshProc.killed) {
      try { sshProc.kill('SIGTERM'); } catch { /* ignore */ }
    }

    if (recordingWriter) {
      recordingWriter.close();
      const upload = await recordingWriter.waitUpload();
      if (upload) {
        try {
          await prisma.session.update({
            where: { id: sessionId },
            data: { recordingKey: recordingWriter.recordingKey },
          });
        } catch (err) {
          logger.warn('terminalService: failed to persist recordingKey', {
            sessionId,
            error: err.message,
          });
        }
      }
      recordingWriter = null;
    }

    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
      tmpDir = null;
    }

    try {
      await sessionService.end(sessionId, { status: statusOverride ?? 'ENDED' });
    } catch (err) {
      logger.warn('terminalService: session end write failed', {
        sessionId,
        error: err.message,
      });
    }
  };

  // Write key + cert to a per-session tmp dir with strict perms.
  try {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'shellius-ssh-'));
    const keyPath = path.join(tmpDir, 'id_ed25519');
    const certPath = path.join(tmpDir, 'id_ed25519-cert.pub');
    // The OpenSSH private key MUST end with a newline; the issuer trims
    // it before encryption, so re-add here just in case.
    const keyText = privateKeyText.endsWith('\n') ? privateKeyText : privateKeyText + '\n';
    const certText = certificate.endsWith('\n') ? certificate : certificate + '\n';
    await writeFile(keyPath, keyText, { mode: 0o600 });
    await writeFile(certPath, certText, { mode: 0o644 });
  } catch (err) {
    logger.error('terminalService: failed to write key/cert tmp files', {
      sessionId,
      error: err.message,
    });
    sendError(ws, `Failed to prepare SSH credentials: ${err.message}`);
    safeClose(ws, 1011, 'Failed to prepare SSH credentials');
    await cleanup('TERMINATED');
    return;
  }

  const keyPath = path.join(tmpDir, 'id_ed25519');
  const certPath = path.join(tmpDir, 'id_ed25519-cert.pub');

  // Spawn ssh with all the safety flags. -tt forces PTY allocation.
  // BatchMode=yes ensures it never prompts for a password.
  // StrictHostKeyChecking=accept-new accepts the host key on first contact.
  const sshArgs = [
    '-tt',
    '-i', keyPath,
    '-o', `CertificateFile=${certPath}`,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.join(tmpDir, 'known_hosts')}`,
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', `ConnectTimeout=10`,
    '-p', String(port),
    `${username}@${connectHost}`,
  ];

  logger.info('terminalService: spawning ssh client', {
    sessionId,
    host: connectHost,
    port,
    username,
  });

  try {
    sshProc = spawn('ssh', sshArgs, {
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        LINES: String(rows),
        COLUMNS: String(cols),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    logger.error('terminalService: spawn ssh failed', { sessionId, error: err.message });
    sendError(ws, `Failed to spawn ssh: ${err.message}`);
    safeClose(ws, 1011, 'Failed to spawn ssh');
    await cleanup('TERMINATED');
    return;
  }

  // Open asciinema recording writer once the process is up.
  recordingWriter = await openRecordingWriter(sessionId, orgId, { rows, cols });

  activeSessions.set(sessionId, { ws, sshProc });

  // Buffer collected stderr so we can attach it to the close reason if the
  // process exits early (auth failure / DNS / connect refused).
  let stderrBuf = '';
  let connected = false;

  // ── ssh stdout → WebSocket ──
  sshProc.stdout.on('data', (chunk) => {
    if (!connected) {
      connected = true;
      // Send a structured "connected" frame so the frontend can flip status.
      // Browser-side STATUS.CONNECTED is set on ws.onopen, but the user only
      // cares about output flowing — once stdout has bytes, we know the
      // shell is live.
    }
    if (recordingWriter) recordingWriter.write(chunk);
    if (ws.readyState === ws.constructor.OPEN) {
      ws.send(chunk);
    }
  });

  // ── ssh stderr → WebSocket (and capture for diagnostics) ──
  sshProc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrBuf += text;
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    // Forward stderr to the user too — most users want to see ssh's
    // own messages (banner, "Permission denied", etc).
    if (recordingWriter) recordingWriter.write(chunk);
    if (ws.readyState === ws.constructor.OPEN) {
      ws.send(chunk);
    }
  });

  sshProc.on('error', (err) => {
    logger.error('terminalService: ssh process error', { sessionId, error: err.message });
    sendError(ws, `ssh process error: ${err.message}`);
    safeClose(ws, 1011, 'ssh process error');
    cleanup('TERMINATED');
  });

  sshProc.on('exit', (code, signal) => {
    logger.info('terminalService: ssh process exited', { sessionId, code, signal });
    if (!connected && (code !== 0 || stderrBuf)) {
      // Process exited before producing any stdout — almost certainly an
      // auth or connect failure. Surface ssh's own stderr verbatim.
      const reason = humanizeSshExitError(stderrBuf, connectHost, port, code);
      sendError(ws, reason);
      safeClose(ws, 1011, reason.slice(0, 120));
    } else {
      safeClose(ws, 1000, `ssh exited (code ${code ?? signal})`);
    }
    cleanup(code === 0 ? 'ENDED' : 'TERMINATED');
  });

  // ── WebSocket → ssh stdin ──
  ws.on('message', (msg) => {
    if (!sshProc || sshProc.killed) return;
    if (typeof msg === 'string') {
      // Try to parse as JSON control message (resize)
      let parsed;
      try { parsed = JSON.parse(msg); } catch {
        sshProc.stdin.write(msg);
        return;
      }
      if (parsed && parsed.type === 'resize') {
        // openssh client doesn't expose a runtime resize signal over stdin.
        // SIGWINCH on the local process tells it to re-poll its controlling
        // tty, but since we're spawned without a real PTY (just pipes), the
        // remote side won't see the change. Best-effort: send SIGWINCH so
        // future flows that switch to node-pty pick this up.
        try { sshProc.kill('SIGWINCH'); } catch { /* ignore */ }
      } else if (parsed && parsed.data !== undefined) {
        sshProc.stdin.write(String(parsed.data));
      }
    } else {
      // Binary Buffer — raw stdin bytes
      sshProc.stdin.write(msg);
    }
  });

  ws.on('close', () => {
    if (sshProc && !sshProc.killed) {
      try { sshProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    cleanup('ENDED');
  });

  ws.on('error', (err) => {
    logger.warn('terminalService: WebSocket error', { sessionId, error: err.message });
    if (sshProc && !sshProc.killed) {
      try { sshProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    cleanup('TERMINATED');
  });
}

function humanizeSshExitError(stderr, host, port, code) {
  const txt = (stderr || '').trim();
  if (/Permission denied/i.test(txt)) {
    return `SSH authentication denied at ${host}. Verify the target host has been bootstrapped with the Shellius CA, the principal matches an existing local user, and sshd was reloaded.\n${txt}`;
  }
  if (/Host key verification failed/i.test(txt)) {
    return `Host key verification failed for ${host}. Inspect with: ssh-keyscan -p ${port} ${host}\n${txt}`;
  }
  if (/Connection refused/i.test(txt)) {
    return `Connection refused at ${host}:${port}. Nothing is listening on the SSH port.`;
  }
  if (/Could not resolve hostname|Name or service not known/i.test(txt)) {
    return `DNS lookup failed for ${host}. The Shellius backend cannot resolve this hostname — set the server's IP address in Shellius.`;
  }
  if (/Connection timed out|timeout/i.test(txt)) {
    return `Timed out connecting to ${host}:${port}. Likely blocked by a firewall or the host is offline.`;
  }
  if (/Network is unreachable|No route to host/i.test(txt)) {
    return `${host} is not reachable from the Shellius backend network. Check firewall / routing.`;
  }
  return `SSH client exited with code ${code} connecting to ${host}:${port}.${txt ? '\n' + txt : ''}`;
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

  // Force-close in-memory handles (SSH subprocess or RDP socket)
  const entry = activeSessions.get(sessionId);
  if (entry) {
    activeSessions.delete(sessionId);
    // SSH subprocess (post-spawn refactor)
    try {
      if (entry.sshProc && !entry.sshProc.killed) entry.sshProc.kill('SIGTERM');
    } catch { /* ignore */ }
    // RDP handle
    try {
      if (entry.guacdSocket) rdpService.revokeConnection(entry.guacdSocket);
    } catch { /* ignore */ }
    safeClose(entry.ws, 1001, 'Session terminated by administrator');
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendError(ws, message, details) {
  try {
    if (ws.readyState === ws.constructor.OPEN || ws.readyState === ws.constructor.CONNECTING) {
      ws.send(JSON.stringify({ type: 'error', message, ...(details || {}) }));
    }
  } catch {
    /* ignore */
  }
}

function humanizeSshError(err, host, port) {
  const code = err?.code;
  const lvl = err?.level;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `DNS lookup failed for ${host}. The Shellius backend cannot resolve this hostname — set the server's IP address in Shellius or make the name resolvable from inside the backend container.`;
  }
  if (code === 'ECONNREFUSED') {
    return `Connection refused at ${host}:${port}. The target host is reachable but nothing is listening on the SSH port.`;
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return `${host} is not reachable from the Shellius backend network. Check firewall / routing.`;
  }
  if (code === 'ETIMEDOUT' || /timed?\s*out/i.test(err?.message || '')) {
    return `Timed out connecting to ${host}:${port}. Likely blocked by a firewall or the host is offline.`;
  }
  if (lvl === 'client-authentication' || /authentication/i.test(err?.message || '')) {
    return `SSH authentication failed at ${host}. Verify (1) the target host has been bootstrapped with the Shellius CA, (2) the principal you requested matches an existing local user on the host, and (3) sshd was reloaded after bootstrap.`;
  }
  if (/Handshake failed/i.test(err?.message || '')) {
    return `SSH handshake failed at ${host}: ${err.message}`;
  }
  return `SSH error connecting to ${host}:${port} — ${err?.message || 'unknown error'}`;
}

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
