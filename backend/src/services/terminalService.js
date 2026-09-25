/**
 * terminalService.js
 *
 * WebSocket-to-SSH proxy for the Shellius web terminal. Every SSH connection
 * (certificate, credential, Quick Connect) goes through ONE engine — ssh2,
 * via sshConnect.connectSsh() — see sshConnect.js for how OpenSSH
 * user-certificate auth is made to work correctly on ssh2.
 *
 * Upgrade paths (all take `?t=<wsTicket>&cols&rows` — a single-use, 30s
 * ticket minted by an authenticated `POST /api/terminal/ws-ticket`; see
 * routes/terminal.js and wsTicketService.js. The access JWT is NEVER in a
 * WebSocket URL — B-6/B-7 hardening):
 *   GET /api/terminal/ssh?t=<ticket>  (ticket params: { requestId, principal? })
 *     - certificate-mode servers: generateSshCredentials() issues an
 *       ephemeral Ed25519 key + CA-signed cert per connection; we connect
 *       via ssh2 with { privateKey, certificate }.
 *     - credential-mode (Keystore) servers: connects via ssh2 using the
 *       server's stored identity (sshConnect.resolveServerAuth), which may
 *       itself carry a certificate (imported key with SshKey.certificate).
 *   GET /api/terminal/ssh?t=<ticket>  (ticket params: { ticket: quickConnectTicket })
 *     - Quick Connect: consumes a single-use Quick Connect ticket (a second,
 *       independent single-use secret — quickConnectService.js) and connects
 *       via ssh2 with the ad-hoc auth material it carries.
 *   GET /api/terminal/ssh?t=<ticket>  (ticket params: { attach: sessionId })
 *     - attach to a live hub session.
 *
 * Security:
 *   - ws-ticket verified (single-use, 30s, bound to userId+orgId+purpose)
 *     before upgrade is accepted; caller is then re-checked live (status,
 *     sessionsValidFrom) exactly like middleware/auth.js.
 *   - Origin header checked against the configured public origin(s) before
 *     the upgrade is accepted (see attachWebSocketServer).
 *   - Certificate path: access request must be APPROVED and not expired;
 *     generateSshCredentials is called per-connection (ephemeral Ed25519 +
 *     CA cert); the private key string reference is dropped after use (best
 *     effort — see sshConnect.js header for the limits of "zeroing" JS
 *     strings).
 *   - All three paths: host key is verified against the server's pinned
 *     fingerprint (TOFU — see sshConnect.checkAndPinHostKey); a mismatch
 *     refuses the connection.
 *   - Session is created ACTIVE on connect, ended on any close/error, for
 *     every path (including Quick Connect, where serverId may be null).
 *
 * Recording:
 *   - Each SSH session is recorded in asciinema v2 format (.cast file)
 *   - Files are stored at RECORDINGS_DIR (default: ./data/recordings)
 *   - recordingPath is persisted on the Session row after the session ends
 *   - RECORDINGS_DIR env var: path to recording storage directory
 */

import { createEncryptStream } from '../utils/recordingCrypto.js';
import { WebSocketServer } from 'ws';
import { URL } from 'url';
import { PassThrough } from 'stream';

import prisma from '../config/db.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import ApiError from '../utils/ApiError.js';
import * as accessRequestService from './accessRequestService.js';
import * as sessionService from './sessionService.js';
import * as rdpService from './rdpService.js';
import * as rdpRecordingService from './rdpRecordingService.js';
import * as storageService from './storageService.js';
import * as sshConnect from './sshConnect.js';
import * as quickConnectService from './quickConnectService.js';
import * as wsTicketService from './wsTicketService.js';
import * as hub from './terminalHub.js';
import GuacamoleLite from 'guacamole-lite';
import { permissionsForUser } from './roleService.js';
import { resolveScope, isUnscoped } from '../lib/scope.js';

/**
 * Scope check for the WebSocket paths. `assertServerInScope` throws an
 * ApiError, which is the right shape for an HTTP route but not for a socket
 * upgrade — here the caller closes the socket instead, so this returns a
 * boolean.
 */
function inScopeServer(scope, server) {
  if (isUnscoped(scope)) return true;
  return !!server && scope.customerIds.includes(server.customerId);
}

const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = parseInt(process.env.GUACD_PORT, 10) || 4822;

// ---------------------------------------------------------------------------
// Origin allowlist — defense in depth alongside the ws-ticket (B-6/B-7). A
// WebSocket upgrade from a browser always carries an Origin header; we
// reject any *mismatched* one before the upgrade completes. Missing Origin
// (non-browser clients: TUI, e2e/test scripts, health checks) is allowed —
// the ws-ticket is the actual authentication control here, this only stops
// a malicious page in the browser from opening a cross-origin WS with a
// leaked ticket.
// ---------------------------------------------------------------------------

// Production: only the configured public origin(s). The Vite dev origins are
// allowed only outside production.
const DEV_WS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
const ALLOWED_WS_ORIGINS = new Set(
  [
    ...String(config.corsOrigin || '').split(',').map((o) => originOf(o.trim())),
    originOf(config.publicBaseUrl),
    originOf(config.frontendUrl),
    ...(config.nodeEnv === 'production' ? [] : DEV_WS_ORIGINS),
  ].filter(Boolean)
);

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return ALLOWED_WS_ORIGINS.has(origin);
}

function rejectUpgrade(socket, status, message) {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* ignore */
  }
  socket.destroy();
}

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

    // Encrypted at rest (utils/recordingCrypto): recordings contain
    // everything printed in the terminal.
    const encrypted = passThrough.pipe(createEncryptStream());
    const uploadPromise = storageService
      .putObjectStream(recordingKey, encrypted, {
        contentType: 'application/octet-stream',
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

    if (pathname !== '/api/terminal/ssh' && pathname !== '/api/terminal/rdp') {
      socket.destroy();
      return;
    }

    if (!isAllowedOrigin(req)) {
      logger.warn('terminalService: rejected WS upgrade — Origin not allowed', {
        pathname,
        origin: req.headers.origin,
      });
      rejectUpgrade(socket, 403, 'Forbidden');
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
    // Heartbeat liveness — see HEARTBEAT_MS below. Browsers reply to a
    // protocol-level ping automatically (even for a backgrounded tab), so a
    // live peer flips this back to true via the 'pong' handler.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    handleConnection(ws, req).catch((err) => {
      logger.error('terminalService: unhandled error in handleConnection (SSH)', {
        error: err.message,
      });
      safeClose(ws, 1011, 'Internal server error');
    });
  });

  // ── Heartbeat ────────────────────────────────────────────────────────────
  // An interactive SSH/RDP session can sit idle for minutes with zero bytes
  // flowing. NAT gateways, load balancers and the browser itself silently drop
  // an idle WebSocket after a few minutes — this is what caused sessions to die
  // "after ~5 min" and "when I switch tabs" (a backgrounded tab produces no
  // traffic). We keep the path warm by pinging every client periodically.
  // Protocol-level pings are handled by the browser's network stack, NOT JS
  // timers, so they are NOT throttled when the tab is in the background.
  const HEARTBEAT_MS = 25000;
  const heartbeat = setInterval(() => {
    // SSH sockets: ping, and reap peers that missed the previous ping.
    wssSsh.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch { /* ignore */ }
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    });
    // RDP (guacamole-lite) sockets: ping only to keep the tunnel warm —
    // guacamole-lite owns their connect/close lifecycle, so we don't reap them.
    try {
      guacRdp.webSocketServer?.clients?.forEach((ws) => {
        if (ws.readyState === ws.OPEN) {
          try { ws.ping(); } catch { /* ignore */ }
        }
      });
    } catch { /* ignore */ }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  wssSsh.on('close', () => clearInterval(heartbeat));

  logger.info('terminalService: WebSocket SSH proxy attached on /api/terminal/ssh');
  logger.info('terminalService: guacamole-lite RDP tunnel attached on /api/terminal/rdp');
}

// ---------------------------------------------------------------------------
// guacamole-lite RDP tunnel
// ---------------------------------------------------------------------------

// Map guacamole-lite connectionId -> Shellius Session row id, for audit rows.
const rdpSessionByConn = new Map();
// Reverse: Session row id -> guacamole-lite ClientConnection, so an RDP session
// can be force-closed by sessionId (e.g. admin terminate / entity deletion).
const rdpConnBySession = new Map();

/**
 * Turn on recording for one RDP connection, if recording can work at all.
 *
 * `settings.connection` is guacamole-lite's already-compiled flat parameter
 * map (ClientConnection merges it before this callback runs), so the recording
 * parameters go straight onto it. The generated id is left at the top level of
 * the token, which is metadata guacd never sees and the `open` handler reads
 * to tie the file to its Session row.
 *
 * Bounded, because this callback sits in front of every RDP connection and the
 * checks it makes touch the database and the filesystem. A slow answer must
 * cost a recording, not the session.
 */
export async function attachRecording(settings, { service = rdpRecordingService, timeoutMs = 3000 } = {}) {
  if (!settings || !settings.connection) return;

  let enabled = false;
  await Promise.race([
    service
      .isEnabled()
      .then((v) => {
        enabled = v;
      })
      // isEnabled() is written not to throw, but this promise is no longer
      // awaited once the timer below wins the race — so a rejection it ever
      // acquired would surface as an unhandled rejection rather than a
      // missing recording.
      .catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
  ]);
  if (!enabled) return;

  const recordingId = service.newRecordingId();
  Object.assign(settings.connection, service.recordingParamsFor(recordingId));
  settings.recordingId = recordingId;
}

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
      // Runs after the token is decrypted, before guacd is contacted — which
      // is the only moment a recording can be turned on, because recording is
      // a connection parameter and guacd will not accept one mid-session.
      processConnectionSettings: (settings, callback) => {
        if (settings && settings.expiration && Date.now() > settings.expiration) {
          return callback(new Error('RDP connection token expired'));
        }
        // Best-effort, and deliberately so: an installation with no object
        // storage, or whose guacd volume is not shared, still gets RDP. It
        // just gets no replay. Refusing the session instead would make a
        // missing bucket look like a broken gateway.
        attachRecording(settings)
          .catch((err) =>
            logger.warn('terminalService: RDP recording not attached', { error: err.message })
          )
          .finally(() => callback(null, settings));
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
        metadata: {
          via: 'guacamole-lite',
          guacId: clientConnection.guacamoleConnectionId,
          // How the sweeper finds this session's recording on disk. guacd
          // named the file before this row existed, so the row has to carry
          // the name rather than the other way round.
          recordingId: s.recordingId ?? null,
        },
      });
      rdpSessionByConn.set(clientConnection.connectionId, session.id);
      rdpConnBySession.set(session.id, clientConnection);
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
    rdpConnBySession.delete(sessionId);
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
// runSsh2Session — shared ssh2-based PTY session for all three connection
// modes (certificate, credential, Quick Connect).
// ---------------------------------------------------------------------------

function sendControl(ws, obj) {
  try {
    if (ws.readyState === ws.constructor.OPEN) ws.send(JSON.stringify(obj));
  } catch { /* ignore */ }
}

/**
 * Add mode-specific guidance to an ssh2 auth failure so users know what to
 * fix, without changing the underlying error for anything else.
 */
function humanizeConnectError(err, authMethod, host) {
  const msg = err?.message || 'SSH connection failed';
  if (err?.code === 'SSH_CONNECT_FAILED' && /authentication failed/i.test(msg)) {
    if (authMethod === 'certificate') {
      return `${msg} Verify the target host has been bootstrapped with the Shellius CA and sshd was reloaded, and that the requested principal matches an existing local user.`;
    }
    if (authMethod === 'credential') {
      return `${msg} Verify the identity's username, key, and/or password for ${host}.`;
    }
    return `${msg} Verify the username, key, and/or password for ${host}.`;
  }
  return msg;
}

/**
 * My hosts (docs/personal-vault.md): connection stats + TOFU host-key pin on
 * the owner's PersonalHost row. Best-effort — never breaks a live session.
 */
function touchPersonalHost(sessionMeta, { status, error, hostKeyInfo } = {}) {
  const { personalHostId, userId, orgId } = sessionMeta;
  if (!personalHostId) return;
  const where = { id: personalHostId, orgId, ownerId: userId };
  const data = {
    lastConnectedAt: new Date(),
    lastStatus: status,
    lastError: status === 'failed' ? (error ? String(error).slice(0, 500) : null) : null,
    ...(status === 'connected' ? { connectCount: { increment: 1 } } : {}),
  };
  prisma.personalHost.updateMany({ where, data }).catch(() => {});
  if (hostKeyInfo) {
    prisma.personalHost
      .updateMany({
        where: { ...where, hostKeyFingerprint: null },
        data: { hostKeyFingerprint: hostKeyInfo.fingerprint, hostKeyAlgorithm: hostKeyInfo.algorithm, hostKeyPinnedAt: new Date() },
      })
      .catch(() => {});
  }
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {import('http').IncomingMessage} req
 * @param {object} params
 * @param {object} params.connect        - sshConnect.connectSsh() opts (host/port/username/password|privateKey/passphrase/expectedFingerprint)
 * @param {object|null} params.pinServer - Server row to TOFU-pin/verify the host key against, or null (unsaved Quick Connect target)
 * @param {object} params.sessionMeta    - { orgId, userId, serverId, accessRequestId, authMethod, targetHost, targetPort, targetUser }
 * @param {number} params.rows
 * @param {number} params.cols
 * @param {string} [params.credentialIdToBump] - Credential.id to stamp lastUsedAt on successful connect
 */
async function runSsh2Session(ws, req, { connect, pinServer, sessionMeta, rows, cols, credentialIdToBump }) {
  const { orgId, userId } = sessionMeta;

  let client;
  let hostKeyInfo = null;
  try {
    const result = await sshConnect.connectSsh({
      ...connect,
      onHostKey: (hk) => { hostKeyInfo = hk; },
    });
    client = result.client;
  } catch (err) {
    const humanMsg = humanizeConnectError(err, sessionMeta.authMethod, sessionMeta.targetHost);
    sendError(ws, humanMsg);
    safeClose(ws, 1011, 'SSH connection failed');
    if (sessionMeta.personalHostId) {
      touchPersonalHost(sessionMeta, { status: 'failed', error: humanMsg });
    } else if (sessionMeta.authMethod === 'quick_connect') {
      quickConnectService
        .recordHistory({
          orgId: sessionMeta.orgId,
          userId: sessionMeta.userId,
          host: sessionMeta.targetHost,
          port: sessionMeta.targetPort,
          username: sessionMeta.targetUser,
          authType: sessionMeta.quickConnectAuthType,
          credentialId: sessionMeta.quickConnectCredentialId,
          serverId: sessionMeta.quickConnectHistoryServerId,
          sessionId: null,
          status: 'failed',
          error: humanMsg,
        })
        .catch(() => {});
    }
    return;
  }

  // Host key verification / TOFU pinning.
  let hostKeyStatus = connect.expectedFingerprint ? 'matched' : 'new';
  if (pinServer && hostKeyInfo) {
    try {
      hostKeyStatus = await sshConnect.checkAndPinHostKey(pinServer, hostKeyInfo);
    } catch (err) {
      try { client.end(); } catch { /* ignore */ }
      sendError(ws, err.message, { code: err.code });
      safeClose(ws, 1008, 'Host key mismatch');
      return;
    }
  }
  if (hostKeyInfo) {
    sendControl(ws, { type: 'hostkey', fingerprint: hostKeyInfo.fingerprint, algorithm: hostKeyInfo.algorithm, status: hostKeyStatus });
  }

  const clientIp =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;

  let session;
  try {
    session = await sessionService.create({
      orgId,
      userId,
      serverId: sessionMeta.serverId || null,
      certificateId: sessionMeta.certificateId || null,
      accessRequestId: sessionMeta.accessRequestId || null,
      sessionType: 'SSH',
      authMethod: sessionMeta.authMethod,
      targetHost: sessionMeta.targetHost,
      targetPort: sessionMeta.targetPort,
      targetUser: sessionMeta.targetUser,
      clientIp,
      userAgent,
      metadata: {
        rows,
        cols,
        host: sessionMeta.targetHost,
        port: sessionMeta.targetPort,
        username: sessionMeta.targetUser,
        // What "reconnect" needs after the live session is gone (server
        // restart, expiry…). No secrets: an auth *type* and a Keystore
        // identity id, never a password or key. See terminalRecoveryService.
        ...(sessionMeta.principal ? { principal: sessionMeta.principal } : {}),
        ...(sessionMeta.authMethod === 'quick_connect'
          ? {
              quickConnect: {
                authType: sessionMeta.quickConnectAuthType || null,
                credentialId: sessionMeta.quickConnectCredentialId || null,
                ...(sessionMeta.personalHostId ? { personalHostId: sessionMeta.personalHostId } : {}),
              },
            }
          : {}),
      },
    });
  } catch (err) {
    logger.error('terminalService: failed to create session row (ssh2)', { error: err.message });
    try { client.end(); } catch { /* ignore */ }
    safeClose(ws, 1011, 'Failed to create session');
    return;
  }

  const sessionId = session.id;

  if (credentialIdToBump) {
    prisma.credential.update({ where: { id: credentialIdToBump }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }

  const label = sessionMeta.label || `${sessionMeta.targetUser}@${sessionMeta.targetHost}`;

  // The 'connected' control frame (and Quick Connect history 'connected'
  // record) is deliberately sent AFTER the shell is open and the hub has
  // wired this socket for input (below) — a client that starts sending
  // keystrokes the instant it sees 'connected' must not race the server
  // still setting up its message listener.
  logger.info('terminalService: ssh2 session starting', {
    sessionId, orgId, userId, authMethod: sessionMeta.authMethod, host: sessionMeta.targetHost,
  });

  // Guards the pre-shell client 'close'/'error' fallback below: once the
  // shell() callback fires (success or failure), the hub (or the manual
  // failure-path cleanup) owns ending the session — this listener becomes a
  // no-op so we never double-write the Session row.
  let shellStarted = false;

  client.on('error', (err) => {
    if (shellStarted) return;
    logger.error('terminalService: ssh2 client error (pre-shell)', { sessionId, error: err.message });
    sendError(ws, `SSH error: ${err.message}`);
    safeClose(ws, 1011, 'SSH error');
  });
  client.on('close', () => {
    if (shellStarted) return;
    sessionService
      .end(sessionId, { status: 'TERMINATED', metadataPatch: { endReason: 'error' } })
      .catch((endErr) =>
        logger.warn('terminalService: failed to end session after pre-shell close', { sessionId, error: endErr.message })
      );
  });

  client.shell({ term: 'xterm-256color', rows, cols }, async (err, stream) => {
    shellStarted = true;

    if (err) {
      logger.error('terminalService: ssh2 shell() failed', { sessionId, error: err.message });
      sendError(ws, `Failed to open shell: ${err.message}`);
      safeClose(ws, 1011, 'Failed to open shell');
      try {
        await sessionService.end(sessionId, { status: 'TERMINATED', metadataPatch: { endReason: 'error' } });
      } catch (endErr) {
        logger.warn('terminalService: failed to end session after shell() failure', { sessionId, error: endErr.message });
      }
      try { client.end(); } catch { /* ignore */ }
      return;
    }

    const recordingWriter = await openRecordingWriter(sessionId, orgId, { rows, cols });

    hub.create({
      id: sessionId,
      orgId,
      userId,
      client,
      stream,
      rows,
      cols,
      recordingWriter,
      meta: {
        targetHost: sessionMeta.targetHost,
        targetPort: sessionMeta.targetPort,
        targetUser: sessionMeta.targetUser,
        authMethod: sessionMeta.authMethod,
        serverId: sessionMeta.serverId || null,
        accessRequestId: sessionMeta.accessRequestId || null,
        server: pinServer
          ? { id: pinServer.id, displayName: pinServer.displayName, hostname: pinServer.hostname, environment: pinServer.environment }
          : null,
        label,
      },
      connectSpec: buildConnectSpec(sessionMeta),
      accessRequestExpiresAt: sessionMeta.accessRequestExpiresAt || null,
    });

    hub.addSocket(sessionId, ws);
    wireAttachedSocket(ws, sessionId);

    // Safe to tell the client it's connected — and to accept input — only
    // now that the socket is actually wired into the hub.
    sendControl(ws, {
      type: 'connected',
      sessionId,
      authMethod: sessionMeta.authMethod,
      host: sessionMeta.targetHost,
      port: sessionMeta.targetPort,
      username: sessionMeta.targetUser,
      label,
    });

    if (sessionMeta.personalHostId) {
      touchPersonalHost(sessionMeta, { status: 'connected', hostKeyInfo });
    } else if (sessionMeta.authMethod === 'quick_connect') {
      quickConnectService
        .recordHistory({
          orgId,
          userId,
          host: sessionMeta.targetHost,
          port: sessionMeta.targetPort,
          username: sessionMeta.targetUser,
          authType: sessionMeta.quickConnectAuthType,
          credentialId: sessionMeta.quickConnectCredentialId,
          serverId: sessionMeta.quickConnectHistoryServerId,
          sessionId,
          status: 'connected',
        })
        .catch(() => {});
    }
  });
}

/**
 * Build the hub's `connectSpec` (used by "Duplicate") from a runSsh2Session
 * sessionMeta. Quick Connect carries raw auth material — the hub encrypts it
 * at rest in memory; everything else is just IDs.
 */
function buildConnectSpec(sessionMeta) {
  if (sessionMeta.authMethod === 'quick_connect') {
    return {
      type: 'quick_connect',
      host: sessionMeta.targetHost,
      port: sessionMeta.targetPort,
      username: sessionMeta.targetUser,
      auth: sessionMeta.quickConnectRawAuth,
      expectedHostKey: sessionMeta.quickConnectExpectedHostKey || null,
      via: sessionMeta.personalHostId ? 'personal_host' : 'quick_connect',
      personalHostId: sessionMeta.personalHostId || null,
    };
  }
  if (sessionMeta.accessRequestId) {
    return {
      type: 'access_request',
      requestId: sessionMeta.accessRequestId,
      principal: sessionMeta.targetUser,
    };
  }
  return null;
}

/**
 * Wire a WebSocket that is attached to a hub session (either the initiating
 * socket of a new session, or a reattach) — input/resize/close frames flow
 * through the hub; socket drop = detach (session keeps running).
 */
function wireAttachedSocket(ws, sessionId) {
  // ws v8 delivers TEXT frames as a Buffer too (with isBinary=false), never as
  // a string — so control messages must be detected from the decoded text.
  // Only an exact control object ({"type":"resize"|"close"...}) is treated as
  // control; everything else is terminal input, byte for byte.
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      hub.write(sessionId, data);
      return;
    }
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (text.startsWith('{"type":')) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (parsed && parsed.type === 'resize') {
        hub.resize(sessionId, parsed.rows, parsed.cols);
        return;
      }
      if (parsed && parsed.type === 'close') {
        hub.end(sessionId, 'closed').catch((err) =>
          logger.warn('terminalService: end(closed) failed', { sessionId, error: err.message })
        );
        return;
      }
      if (parsed && parsed.type === 'data' && parsed.data !== undefined) {
        hub.write(sessionId, String(parsed.data));
        return;
      }
    }
    hub.write(sessionId, text);
  });

  ws.on('close', () => { hub.detach(sessionId, ws); });
  ws.on('error', (wsErr) => {
    logger.warn('terminalService: WebSocket error', { sessionId, error: wsErr.message });
    hub.detach(sessionId, ws);
  });
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

  const { t: wsTicket } = query;
  const rows = Math.max(1, parseInt(query.rows, 10) || 24);
  const cols = Math.max(1, parseInt(query.cols, 10) || 80);

  if (!wsTicket) {
    safeClose(ws, 1008, 'Missing connection ticket');
    return;
  }

  // ── 2. Consume the single-use, 30s ws-ticket — see routes/terminal.js
  // POST /ws-ticket and services/wsTicketService.js. This is the ONLY thing
  // that authenticates this upgrade; the long-lived access JWT never
  // appears in a WebSocket URL (B-6/B-7 hardening).
  let ticketPayload;
  try {
    ticketPayload = await wsTicketService.consume(wsTicket, 'ssh');
  } catch {
    safeClose(ws, 4401, 'Invalid or expired connection ticket');
    return;
  }

  const { userId, orgId, params } = ticketPayload;
  const { requestId, ticket, attach: attachSessionId, principal: principalOverride } = params || {};

  if (!requestId && !ticket && !attachSessionId) {
    safeClose(ws, 1008, 'Missing requestId, ticket, or attach');
    return;
  }

  // ── 3. Load user from DB — same liveness checks as middleware/auth.js:
  // a revoked/suspended/deactivated/deleted user, or a ticket minted before
  // the last "sign out everywhere" (sessionsValidFrom), must not be able to
  // open (or keep) a shell. See docs — B-3 hardening.
  const user = await prisma.user.findFirst({
    where: { id: userId, orgId },
    include: { assignedRole: { select: { id: true, key: true, isSystem: true, baseRole: true, permissions: true } } },
  });
  if (!user || user.status !== 'active') {
    safeClose(ws, 4401, 'Session has been revoked');
    return;
  }
  if (
    user.sessionsValidFrom &&
    typeof ticketPayload.issuedAt === 'number' &&
    ticketPayload.issuedAt < user.sessionsValidFrom.getTime()
  ) {
    safeClose(ws, 4401, 'Session has been revoked');
    return;
  }

  // DB-authoritative, matches middleware/auth.js
  const role = user.role;
  const permissions = new Set(permissionsForUser(user));
  // Customer scope, resolved the same way middleware/auth.js does for HTTP —
  // a WebSocket upgrade never passes through Express middleware, so redeeming
  // a ticket has to re-derive it here. Scope may have been narrowed after the
  // ticket was minted; this is the redemption-side check (spec §4.2 #24).
  const scope = await resolveScope(user);

  // ── Reattach path — WS re-joins a live hub session ─────────────────────
  if (attachSessionId) {
    let publicShape;
    try {
      publicShape = hub.attach(attachSessionId, ws, { userId, orgId }, { rows, cols });
    } catch (err) {
      if (err instanceof hub.HubError) {
        safeClose(ws, err.wsCode, err.message);
      } else {
        logger.error('terminalService: attach failed', { sessionId: attachSessionId, error: err.message });
        safeClose(ws, 1011, 'Failed to attach to session');
      }
      return;
    }
    wireAttachedSocket(ws, attachSessionId);
    logger.info('terminalService: socket attached to hub session', {
      sessionId: attachSessionId, orgId, userId, attachedCount: publicShape.attachedCount,
    });
    return;
  }

  // ── Quick Connect path (ticket) — ssh2, ad-hoc auth, no saved server ───
  if (ticket) {
    let connect;
    try {
      connect = await quickConnectService.consumeTicket(ticket, { userId, orgId });
    } catch (err) {
      safeClose(ws, 1008, err.message || 'Invalid Quick Connect ticket');
      return;
    }

    // If this host matches a saved server, link the session to it and pin/
    // verify against its host key. assertNotProdHost already refused prod
    // hosts at ticket-creation time, so any match here is guaranteed non-prod.
    // `connect.host` is the resolved IP (what we actually connect to);
    // `connect.displayHost` is the original hostname/IP the user typed —
    // match against both so a saved server keyed by hostname still links.
    const displayHost = connect.displayHost || connect.host;
    const matchedServer = await prisma.server.findFirst({
      where: {
        orgId,
        OR: [
          { ipAddress: connect.host },
          { ipAddress: displayHost },
          { hostname: { equals: displayHost, mode: 'insensitive' } },
        ],
      },
    });

    // Quick Connect history's `serverId` is a slightly stricter match than
    // the pinning lookup above (host+port, non-prod) — it's a soft link for
    // display only, not the actual Session.serverId.
    const historyServerId =
      matchedServer && matchedServer.port === connect.port && matchedServer.environment !== 'prod'
        ? matchedServer.id
        : null;

    await runSsh2Session(ws, req, {
      connect,
      pinServer: matchedServer || null,
      sessionMeta: {
        orgId,
        userId,
        serverId: matchedServer?.id || null,
        accessRequestId: null,
        authMethod: 'quick_connect',
        targetHost: displayHost,
        targetPort: connect.port,
        targetUser: connect.username,
        quickConnectAuthType: connect.authType,
        quickConnectCredentialId: connect.credentialId || null,
        quickConnectHistoryServerId: historyServerId,
        // Kept only long enough for runSsh2Session to hand it to the hub
        // (encrypted at rest there) — for the "Duplicate" flow. Never logged.
        quickConnectRawAuth: connect.rawAuth,
        quickConnectExpectedHostKey: connect.expectedHostKey || null,
        personalHostId: connect.personalHostId || null,
      },
      rows,
      cols,
    });
    return;
  }

  // ── 4. Validate access request ────────────────────────────────────────
  let accessRequest;
  try {
    accessRequest = await accessRequestService.getById({
      requestId,
      orgId,
      callerId: userId,
      callerPermissions: permissions,
    });
  } catch (err) {
    safeClose(ws, 1008, err.message || 'Access request not found');
    return;
  }

  // Sessions are per user: only the person who requested (and was granted)
  // access may open a terminal with it. Admins/reviewers can *view* any
  // request in their org, but must not be able to use someone else's
  // approval (credential-mode servers would otherwise connect with the
  // server's Keystore identity as the admin/reviewer).
  if (accessRequest.requesterId !== userId) {
    safeClose(ws, 1008, 'Only the requester can open a session with this access request');
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

  // ── 4b. Credential-mode (Keystore) server — ssh2 with the server's identity ─
  const fullServer = await prisma.server.findFirst({
    where: { id: accessRequest.serverId, orgId },
    include: { credential: { include: { sshKey: true } } },
  });
  // A server outside the caller's customer scope is indistinguishable from one
  // that does not exist — same message, same close code, even though a valid
  // access request names it.
  if (!fullServer || !inScopeServer(scope, fullServer)) {
    safeClose(ws, 1008, 'Server not found');
    return;
  }

  if (fullServer.authMode === 'credential') {
    let connectOpts;
    try {
      connectOpts = await sshConnect.resolveServerAuth(fullServer);
    } catch (err) {
      safeClose(ws, 1011, err.message || 'Failed to resolve server identity');
      return;
    }
    await runSsh2Session(ws, req, {
      connect: connectOpts,
      pinServer: fullServer,
      sessionMeta: {
        orgId,
        userId,
        serverId: fullServer.id,
        accessRequestId: requestId,
        authMethod: 'credential',
        targetHost: connectOpts.host,
        targetPort: connectOpts.port,
        targetUser: connectOpts.username,
        accessRequestExpiresAt: accessRequest.expiresAt,
      },
      rows,
      cols,
      credentialIdToBump: fullServer.credentialId,
    });
    return;
  }

  // ── 5. Generate ephemeral SSH credentials (certificate-mode servers) ──
  let credentials;
  try {
    credentials = await accessRequestService.generateSshCredentials({
      requestId,
      callerId: userId,
      callerRole: role,
      callerPermissions: permissions,
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

  // Use the IP address for the actual TCP connect — the container running the
  // backend may not resolve arbitrary hostnames.
  const connectHost = credentials.address || credentials.hostname;
  const privateKeyText = credentials.privateKey;
  const certificateText = credentials.certificate;
  // Drop the reference on the credentials object — best-effort; see
  // sshConnect.js header for why a JS string can't truly be zeroed.
  credentials.privateKey = null;

  await runSsh2Session(ws, req, {
    connect: {
      host: connectHost,
      port: credentials.port,
      username: credentials.username,
      privateKey: privateKeyText,
      certificate: certificateText,
    },
    pinServer: fullServer,
    sessionMeta: {
      orgId,
      userId,
      serverId: accessRequest.serverId,
      certificateId: accessRequest.certificateId ?? null,
      accessRequestId: requestId,
      authMethod: 'certificate',
      principal: principalOverride || null,
      targetHost: connectHost,
      targetPort: credentials.port,
      targetUser: credentials.username,
      accessRequestExpiresAt: accessRequest.expiresAt,
    },
    rows,
    cols,
  });
}

// ---------------------------------------------------------------------------
// reconcileOrphanedSessions — startup sweep
// ---------------------------------------------------------------------------

/**
 * Live SSH sessions exist only in this process's terminalHub. A crash, OOM
 * kill or `node --watch` restart skips graceful shutdown (which ends them
 * with reason 'shutdown'), leaving Session rows ACTIVE for sessions that
 * can no longer exist. Close those rows at boot with endReason
 * 'server_restart', so audit/Sessions pages stop showing them as live and
 * the workspace can explain what happened and offer recovery.
 *
 * Only SSH rows: RDP (guacamole) sessions are not tracked by the hub.
 * Assumes a single backend process (same documented limitation as the hub).
 *
 * @param {object} [opts]
 * @param {string} [opts.orgId] - limit to one org (tests); startup passes nothing
 * @returns {Promise<number>} number of sessions closed
 */
export async function reconcileOrphanedSessions({ orgId } = {}) {
  const orphaned = await prisma.session.findMany({
    where: { status: 'ACTIVE', sessionType: 'SSH', ...(orgId ? { orgId } : {}) },
    select: { id: true },
  });
  let closed = 0;
  for (const { id } of orphaned) {
    if (hub.has(id)) continue;
    try {
      await sessionService.end(id, { status: 'ENDED', metadataPatch: { endReason: 'server_restart' } });
      closed += 1;
    } catch (err) {
      logger.warn('terminalService: failed to close orphaned session', { sessionId: id, error: err.message });
    }
  }
  if (closed) logger.info(`terminalService: closed ${closed} SSH session(s) left open by a previous run`);
  return closed;
}

// ---------------------------------------------------------------------------
// terminateSession — admin force-close
// ---------------------------------------------------------------------------

/**
 * Force-close an active session by sessionId — SSH sessions are ended via
 * the hub (fans 'ended' out to every attached socket, closes ssh2, finalises
 * the recording and the Session row); RDP (and any stray DB-only ACTIVE
 * session with no live hub entry) falls back to the old direct path.
 *
 * Org-scoped: `orgId` is required and checked against both the live hub
 * record and the DB row — cross-tenant callers get a 404, never a 409/403
 * that would confirm the session exists in another org (B-4 hardening).
 *
 * @param {string} orgId
 * @param {string} sessionId
 * @param {string} byUserId
 * @returns {Promise<object>} Updated session row
 */
export async function terminateSession(orgId, sessionId, byUserId) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  if (hub.has(sessionId)) {
    const rec = hub.get(sessionId);
    if (!rec || rec.orgId !== orgId) {
      throw new ApiError(404, 'Session not found');
    }
    const updated = await hub.end(sessionId, 'terminated', { terminatedBy: byUserId });
    if (!updated) throw new ApiError(409, 'Session is not active');
    return updated;
  }

  // Update DB first — will throw if not found in this org, or not ACTIVE
  const updated = await sessionService.terminate(orgId, sessionId, byUserId);

  // Force-close a live RDP (guacamole-lite) connection for this session.
  const rdpConn = rdpConnBySession.get(sessionId);
  if (rdpConn) {
    rdpConnBySession.delete(sessionId);
    try {
      rdpConn.close();
    } catch { /* ignore */ }
  }

  return updated;
}

/**
 * Force-terminate every ACTIVE session matching `where` (e.g. { serverId } or
 * { userId }). Best-effort: a session that already ended just no-ops. Used by
 * the dependency-aware delete flow before hard-deleting an entity.
 *
 * @param {string} orgId
 * @param {object} where     - extra Prisma Session filter (serverId / userId)
 * @param {string} byUserId  - actor performing the termination
 * @returns {Promise<number>} count of sessions terminated
 */
export async function terminateActiveSessionsFor(orgId, where, byUserId) {
  const active = await prisma.session.findMany({
    where: { orgId, status: 'ACTIVE', ...where },
    select: { id: true },
  });
  let terminated = 0;
  for (const { id } of active) {
    try {
      await terminateSession(orgId, id, byUserId);
      terminated += 1;
    } catch (err) {
      logger.warn('terminalService: terminateActiveSessionsFor: failed to terminate', {
        sessionId: id,
        error: err.message,
      });
    }
  }
  return terminated;
}

/**
 * End every live session (SSH hub + RDP) belonging to a user, immediately —
 * used by userService/authService hooks (suspend, deactivate, delete, role
 * change, admin revoke-sessions, password change/reset) so a revoked user
 * can't keep using an already-open terminal. See docs/terminal-workspace.md
 * and B-3 hardening notes. Best-effort: never throws.
 *
 * @param {string} orgId
 * @param {string} userId
 * @param {string} [reason='revoked']
 * @returns {Promise<number>} sessions ended
 */
export async function endAllSessionsForUser(orgId, userId, reason = 'revoked') {
  let ended = 0;
  try {
    ended += await hub.endAllForUser(userId, orgId, reason);
  } catch (err) {
    logger.warn('terminalService: endAllSessionsForUser: hub.endAllForUser failed', { orgId, userId, error: err.message });
  }

  // RDP sessions aren't tracked in the hub — find any still-ACTIVE RDP rows
  // for this user/org and force-close the guacamole-lite connection.
  try {
    const activeRdp = await prisma.session.findMany({
      where: { orgId, userId, status: 'ACTIVE', sessionType: 'RDP' },
      select: { id: true },
    });
    for (const { id } of activeRdp) {
      const conn = rdpConnBySession.get(id);
      if (conn) {
        rdpConnBySession.delete(id);
        rdpSessionByConn.forEach((sid, connId) => {
          if (sid === id) rdpSessionByConn.delete(connId);
        });
        try { conn.close(); } catch { /* ignore */ }
      }
      try {
        await sessionService.end(id, { status: 'TERMINATED', metadataPatch: { endReason: reason } });
        ended += 1;
      } catch (err) {
        logger.warn('terminalService: endAllSessionsForUser: failed to end RDP session', { sessionId: id, error: err.message });
      }
    }
  } catch (err) {
    logger.warn('terminalService: endAllSessionsForUser: RDP lookup failed', { orgId, userId, error: err.message });
  }

  if (ended) {
    logger.info('terminalService: ended all live sessions for user', { orgId, userId, reason, count: ended });
  }
  return ended;
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

function safeClose(ws, code, reason) {
  try {
    if (ws.readyState === ws.constructor.OPEN || ws.readyState === ws.constructor.CONNECTING) {
      ws.close(code, reason);
    }
  } catch {
    // Ignore errors on already-closed sockets
  }
}

export default { attachWebSocketServer, terminateSession, terminateActiveSessionsFor, endAllSessionsForUser, reconcileOrphanedSessions };
