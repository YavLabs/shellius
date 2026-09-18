#!/usr/bin/env node
/**
 * e2e-terminal-hub.mjs
 *
 * End-to-end smoke test for the Terminals workspace (terminalHub) against a
 * RUNNING dev backend (default http://127.0.0.1:3001) and the local test
 * sshd container (shellius-sshtest, 127.0.0.1:52222, testuser/testpass123 —
 * requires SSH_TARGET_ALLOW_LOOPBACK=true on the backend).
 *
 * Exercises, over the real HTTP + WebSocket surface:
 *   1. Quick Connect -> run a command -> drop the socket (detach)
 *   2. GET /api/terminal/sessions shows it detached
 *   3. Reattach -> replay contains the earlier output -> run another command
 *   4. Duplicate -> the new session works independently
 *   5. Rename
 *   6. Close -> 'ended' frame + gone from the list
 *   7. A second user (different org) cannot attach (4403), a bogus id can't
 *      be attached to either (4404)
 *
 * Usage: npm run test:e2e:terminal
 * Env:   BASE_URL (default http://127.0.0.1:3001)
 *        ADMIN_EMAIL / ADMIN_PASSWORD (default admin@shellius.local / read
 *          from $ADMIN_PASSWORD_FILE if set)
 *        OTHER_EMAIL / OTHER_PASSWORD (default a @demo.shellius.local user)
 */

import WebSocket from 'ws';
import fs from 'fs';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3001';
const WS_BASE = BASE_URL.replace(/^http/, 'ws');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@shellius.local';
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  (process.env.ADMIN_PASSWORD_FILE ? fs.readFileSync(process.env.ADMIN_PASSWORD_FILE, 'utf8').trim() : null);

const OTHER_EMAIL = process.env.OTHER_EMAIL || 'marcus.rivera@demo.shellius.local';
const OTHER_PASSWORD = process.env.OTHER_PASSWORD || 'DemoPass-2026!';

const SSH_HOST = process.env.E2E_SSH_HOST || '127.0.0.1';
const SSH_PORT = parseInt(process.env.E2E_SSH_PORT, 10) || 52222;
const SSH_USER = process.env.E2E_SSH_USER || 'testuser';
const SSH_PASSWORD = process.env.E2E_SSH_PASSWORD || 'testpass123';

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(name) {
  passCount += 1;
  console.log(`  ✓ ${name}`);
}

function fail(name, err) {
  failCount += 1;
  const msg = err?.message || String(err);
  failures.push({ name, msg });
  console.error(`  ✗ ${name}`);
  console.error(`    ${msg}`);
}

async function step(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function login(email, password) {
  const { status, json } = await api('POST', '/api/auth/login', { body: { email, password } });
  if (status !== 200 || !json?.success) {
    throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  }
  return json.data; // { accessToken, refreshToken, user }
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

function connectTerminalWs(query) {
  const url = `${WS_BASE}/api/terminal/ssh?${query}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'nodebuffer';
  return ws;
}

/**
 * WS URLs carry only a single-use, 30s ws-ticket (`t=`) — never the access
 * JWT (B-6/B-7 hardening). Mint one via the authenticated REST endpoint,
 * bound to the calling user + the intended connect params, then open the
 * socket with just `t=<ticket>&cols&rows`.
 */
async function connectTerminalWsWithTicket(token, params, { cols = 80, rows = 24 } = {}) {
  const { status, json } = await api('POST', '/api/terminal/ws-ticket', {
    token,
    body: { purpose: 'ssh', params },
  });
  if (status !== 201 || !json?.success) {
    throw new Error(`ws-ticket mint failed: ${status} ${JSON.stringify(json)}`);
  }
  const wsTicket = json.data.ticket;
  return connectTerminalWs(`t=${encodeURIComponent(wsTicket)}&cols=${cols}&rows=${rows}`);
}

/** Wait for the first control frame matching `type`, or a close event. Times out. */
function waitForFrame(ws, type, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for '${type}' frame`));
    }, timeoutMs);

    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (parsed.type === type) {
        cleanup();
        resolve(parsed);
      } else if (parsed.type === 'error') {
        cleanup();
        reject(new Error(`server error frame: ${parsed.message}`));
      }
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`socket closed (${code}) before '${type}': ${reason}`));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

/** Wait until the accumulated raw (binary) output contains `needle`. */
function waitForOutput(ws, needle, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for output containing ${JSON.stringify(needle)}; got: ${acc.toString().slice(-300)}`));
    }, timeoutMs);

    const onMessage = (data, isBinary) => {
      if (!isBinary) return;
      acc = Buffer.concat([acc, data]);
      if (acc.includes(needle)) {
        cleanup();
        resolve(acc);
      }
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`socket closed (${code}) before output arrived: ${reason}`));
    };
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    }
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

function waitForClose(ws, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for socket close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason?.toString?.() });
    });
  });
}

function closeWs(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    try {
      ws.close();
    } catch {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!ADMIN_PASSWORD) {
    throw new Error('ADMIN_PASSWORD (or ADMIN_PASSWORD_FILE) is required');
  }

  console.log(`[e2e-terminal-hub] BASE_URL=${BASE_URL}`);

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  console.log(`[e2e-terminal-hub] logged in as ${admin.user.email} (${admin.user.role}, org ${admin.user.orgId})`);

  const other = await login(OTHER_EMAIL, OTHER_PASSWORD);
  console.log(`[e2e-terminal-hub] logged in as ${other.user.email} (org ${other.user.orgId})`);
  if (other.user.orgId === admin.user.orgId) {
    console.warn('[e2e-terminal-hub] WARNING: second user is in the SAME org as admin — forbidden-attach test is weaker');
  }

  async function mintTicket(token) {
    const { status, json } = await api('POST', '/api/quick-connect/tickets', {
      token,
      body: {
        host: SSH_HOST,
        port: SSH_PORT,
        username: SSH_USER,
        auth: { type: 'password', password: SSH_PASSWORD },
      },
    });
    assert(status === 201 && json?.success, `ticket creation failed: ${status} ${JSON.stringify(json)}`);
    return json.data.ticket;
  }

  let sessionId;
  let ws;

  await step('Quick Connect: WS connects and shell opens', async () => {
    const ticket = await mintTicket(admin.accessToken);
    ws = await connectTerminalWsWithTicket(admin.accessToken, { ticket });
    const connected = await waitForFrame(ws, 'connected');
    assert(connected.sessionId, 'connected frame missing sessionId');
    sessionId = connected.sessionId;
  });

  await step('run `echo marker1` and see the output', async () => {
    const out = waitForOutput(ws, Buffer.from('marker1'));
    ws.send('echo marker1\r\n');
    await out;
  });

  await step('drop the socket (simulated network drop) -> session detaches, not ends', async () => {
    await closeWs(ws);
    // Give the server a moment to process the close event.
    await new Promise((r) => setTimeout(r, 300));
  });

  await step('GET /api/terminal/sessions shows it detached', async () => {
    const { status, json } = await api('GET', '/api/terminal/sessions', { token: admin.accessToken });
    assert(status === 200 && json?.success, `list failed: ${status} ${JSON.stringify(json)}`);
    const entry = json.data.sessions.find((s) => s.id === sessionId);
    assert(entry, 'session missing from list after detach');
    assert(entry.state === 'detached', `expected state 'detached', got '${entry.state}'`);
    assert(entry.attachedCount === 0, `expected attachedCount 0, got ${entry.attachedCount}`);
  });

  let ws2;
  await step('reattach: replay contains marker1', async () => {
    ws2 = await connectTerminalWsWithTicket(admin.accessToken, { attach: sessionId });
    // Listen for both BEFORE anything arrives: the replay follows the
    // 'attached' frame immediately and often lands in the same read.
    const attachedP = waitForFrame(ws2, 'attached');
    const replayP = waitForOutput(ws2, Buffer.from('marker1'), 5000);
    const attached = await attachedP;
    assert(attached.sessionId === sessionId, 'attached frame sessionId mismatch');
    assert(attached.replayBytes > 0, 'replayBytes should be > 0 (marker1 was written before detach)');
    const replay = await replayP;
    assert(replay.length > 0, 'no replay bytes received');
  });

  await step('after reattach: `echo marker2` still works', async () => {
    const out = waitForOutput(ws2, Buffer.from('marker2'));
    ws2.send('echo marker2\r\n');
    await out;
  });

  await step('a second user (different owner) cannot attach — 4403/4404', async () => {
    const wsOther = await connectTerminalWsWithTicket(other.accessToken, { attach: sessionId });
    const { code } = await waitForClose(wsOther);
    assert(code === 4403 || code === 4404, `expected close code 4403/4404, got ${code}`);
  });

  await step('attaching a bogus session id fails with 4404', async () => {
    const wsBogus = await connectTerminalWsWithTicket(admin.accessToken, { attach: 'does-not-exist' });
    const { code } = await waitForClose(wsBogus);
    assert(code === 4404, `expected close code 4404, got ${code}`);
  });

  let dupSessionId;
  let wsDup;
  await step('duplicate: mints a new session to the same target', async () => {
    const { status, json } = await api('POST', `/api/terminal/sessions/${sessionId}/duplicate`, { token: admin.accessToken });
    assert(status === 201 && json?.success, `duplicate failed: ${status} ${JSON.stringify(json)}`);
    const { ticket } = json.data.connect;
    assert(ticket, 'duplicate did not return a ticket for a quick_connect session');

    wsDup = await connectTerminalWsWithTicket(admin.accessToken, { ticket });
    const connected = await waitForFrame(wsDup, 'connected');
    dupSessionId = connected.sessionId;
    assert(dupSessionId && dupSessionId !== sessionId, 'duplicate session should have a different id');
  });

  await step('the duplicated session works independently', async () => {
    const out = waitForOutput(wsDup, Buffer.from('dup-marker'));
    wsDup.send('echo dup-marker\r\n');
    await out;
  });

  await step('close the duplicate via REST', async () => {
    // Listen before closing: the 'ended' frame can arrive before the REST call returns.
    const endedPromise = waitForFrame(wsDup, 'ended', 5000);
    const { status, json } = await api('POST', `/api/terminal/sessions/${dupSessionId}/close`, { token: admin.accessToken });
    assert(status === 200 && json?.success, `close failed: ${status} ${JSON.stringify(json)}`);
    await endedPromise;
  });

  await step('rename the original session', async () => {
    const { status, json } = await api('PATCH', `/api/terminal/sessions/${sessionId}`, {
      token: admin.accessToken,
      body: { label: 'e2e renamed session' },
    });
    assert(status === 200 && json?.success, `rename failed: ${status} ${JSON.stringify(json)}`);
    assert(json.data.session.label === 'e2e renamed session', 'label was not updated');
  });

  await step('close the original session -> ended frame + gone from list', async () => {
    const endedPromise = waitForFrame(ws2, 'ended', 5000);
    const { status, json } = await api('POST', `/api/terminal/sessions/${sessionId}/close`, { token: admin.accessToken });
    assert(status === 200 && json?.success, `close failed: ${status} ${JSON.stringify(json)}`);
    const ended = await endedPromise;
    assert(ended.reason === 'closed', `expected reason 'closed', got '${ended.reason}'`);

    const { json: listJson } = await api('GET', '/api/terminal/sessions', { token: admin.accessToken });
    assert(!listJson.data.sessions.some((s) => s.id === sessionId), 'session still present in list after close');
  });

  // Best-effort cleanup of any sockets still open.
  await Promise.all([closeWs(ws), closeWs(ws2), closeWs(wsDup)]);

  console.log('');
  console.log(`[e2e-terminal-hub] ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.error('[e2e-terminal-hub] FAILURES:');
    for (const f of failures) console.error(`  - ${f.name}: ${f.msg}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[e2e-terminal-hub] fatal error:', err);
  process.exitCode = 1;
});
