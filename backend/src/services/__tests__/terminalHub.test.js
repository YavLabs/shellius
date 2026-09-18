/**
 * terminalHub — unit tests.
 *
 * Strategy: no Jest ESM module mocking (jest.unstable_mockModule with
 * file:// URLs is broken in this Jest + Node ESM combination — see
 * caService.test.js / quickConnectProdGuard.test.js). Instead:
 *   - ssh2 `client`/`stream` are hand-rolled EventEmitter fakes (as
 *     instructed) — no real SSH connection anywhere in this file.
 *   - The WebSocket is a hand-rolled EventEmitter fake matching the `ws`
 *     surface the hub touches (`readyState`, `constructor.OPEN`, `send`,
 *     `close`).
 *   - terminalHub's own DB writes (sessionService.end / auditService.log)
 *     hit the real (test) database via the dbReachable() skip pattern —
 *     each test's hub session is backed by a real Session row so those
 *     calls succeed exactly as they would in production; tests are skipped
 *     (not failed) when no DB is configured.
 *   - jest fake timers drive the detach-TTL test — no real waiting.
 */

import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

import * as sessionService from '../sessionService.js';
import * as hub from '../terminalHub.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

// The AR-expiry watcher polls the DB on a real interval — stop it so it
// can't interleave with fake timers / leave the test process open.
hub.stopExpiryWatcher();

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = FakeWs.OPEN;
    this.sent = [];
    this.closeCalls = [];
  }

  send(data) {
    if (this.readyState !== FakeWs.OPEN) return;
    this.sent.push(data);
  }

  close(code, reason) {
    this.readyState = FakeWs.CLOSED;
    this.closeCalls.push({ code, reason });
    this.emit('close');
  }
}
FakeWs.OPEN = 1;
FakeWs.CLOSED = 3;

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.destroyed = false;
    this.written = [];
    this.windows = [];
  }

  write(data) {
    this.written.push(data);
    return true;
  }

  setWindow(rows, cols) {
    this.windows.push({ rows, cols });
  }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

class FakeClient extends EventEmitter {
  end() {
    this.ended = true;
  }
}

describe('terminalHub', () => {
  let reachable;
  let org;
  let user;
  let otherUser;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] terminalHub: no live DB');
      return;
    }
    org = await createTestOrg();
    user = await createTestUser(org.id, { role: 'member' });
    otherUser = await createTestUser(org.id, { role: 'member' });
  });

  afterAll(async () => {
    if (reachable && org) await cleanupOrg(org.id);
  });

  const maybeTest = (name, fn, timeout) =>
    test(
      name,
      async () => {
        if (!reachable) return;
        await fn();
      },
      timeout
    );

  /** Create a real Session row (ACTIVE) + a hub record backed by fake ssh2 handles. */
  async function makeHubSession(overrides = {}) {
    const row = await sessionService.create({
      orgId: org.id,
      userId: user.id,
      sessionType: 'SSH',
      authMethod: overrides.authMethod || 'quick_connect',
      targetHost: 'example.test',
      targetPort: 22,
      targetUser: 'root',
    });

    const client = new FakeClient();
    const stream = new FakeStream();

    hub.create({
      id: row.id,
      orgId: org.id,
      userId: user.id,
      client,
      stream,
      rows: 24,
      cols: 80,
      recordingWriter: null,
      meta: {
        targetHost: 'example.test',
        targetPort: 22,
        targetUser: 'root',
        authMethod: overrides.authMethod || 'quick_connect',
        label: 'root@example.test',
      },
      connectSpec: overrides.connectSpec ?? {
        type: 'quick_connect',
        host: 'example.test',
        port: 22,
        username: 'root',
        auth: { type: 'password', password: 'super-secret' },
      },
      accessRequestExpiresAt: overrides.accessRequestExpiresAt ?? null,
    });

    return { sessionId: row.id, client, stream };
  }

  // -------------------------------------------------------------------
  // Ring buffer
  // -------------------------------------------------------------------

  maybeTest('ring buffer trims to the configured max and keeps the tail', async () => {
    const { sessionId, stream } = await makeHubSession();
    const max = hub.__testing.RING_BUFFER_MAX_BYTES;

    // Push well past the cap in chunks, with a final unique marker so we can
    // confirm the tail (not the head) survives trimming.
    const chunkSize = 64 * 1024;
    const filler = Buffer.alloc(chunkSize, 'a');
    for (let i = 0; i < 10; i += 1) stream.emit('data', filler);
    const marker = Buffer.from('END-OF-STREAM-MARKER');
    stream.emit('data', marker);

    const ws2 = new FakeWs();
    hub.attach(sessionId, ws2, { userId: user.id, orgId: org.id });

    const attachedFrame = JSON.parse(ws2.sent[0]);
    expect(attachedFrame.type).toBe('attached');
    expect(attachedFrame.replayBytes).toBeLessThanOrEqual(max);

    const replay = ws2.sent[1];
    expect(Buffer.isBuffer(replay)).toBe(true);
    expect(replay.length).toBeLessThanOrEqual(max);
    expect(replay.subarray(replay.length - marker.length).toString()).toBe(marker.toString());

    await hub.end(sessionId, 'closed');
  });

  // -------------------------------------------------------------------
  // attach / detach / fan-out
  // -------------------------------------------------------------------

  maybeTest('fans output out to every attached socket', async () => {
    const { sessionId, stream } = await makeHubSession();
    const ws1 = new FakeWs();
    hub.addSocket(sessionId, ws1);

    const ws2 = new FakeWs();
    hub.attach(sessionId, ws2, { userId: user.id, orgId: org.id });

    stream.emit('data', Buffer.from('hello'));

    expect(ws1.sent.some((c) => Buffer.isBuffer(c) && c.toString() === 'hello')).toBe(true);
    // ws2 gets 'attached' + (empty) replay, then the live chunk.
    expect(ws2.sent.some((c) => Buffer.isBuffer(c) && c.toString() === 'hello')).toBe(true);

    await hub.end(sessionId, 'closed');
  });

  maybeTest('detach keeps the session alive with attachedCount 0; reattach cancels the TTL timer', async () => {
    const { sessionId } = await makeHubSession();
    const ws1 = new FakeWs();
    hub.addSocket(sessionId, ws1);

    hub.detach(sessionId, ws1);

    let list = hub.list(user.id, org.id);
    let entry = list.find((s) => s.id === sessionId);
    expect(entry).toBeTruthy();
    expect(entry.state).toBe('detached');
    expect(entry.attachedCount).toBe(0);
    expect(entry.detachedAt).toBeTruthy();

    const ws2 = new FakeWs();
    hub.attach(sessionId, ws2, { userId: user.id, orgId: org.id });

    list = hub.list(user.id, org.id);
    entry = list.find((s) => s.id === sessionId);
    expect(entry.state).toBe('attached');
    expect(entry.attachedCount).toBe(1);
    expect(entry.detachedAt).toBeNull();

    await hub.end(sessionId, 'closed');
  });

  maybeTest('detach-TTL expiry ends the session after TERMINAL_DETACH_TTL_SECONDS with fake timers', async () => {
    jest.useFakeTimers();
    try {
      const { sessionId } = await makeHubSession();
      const ws1 = new FakeWs();
      hub.addSocket(sessionId, ws1);

      hub.detach(sessionId, ws1);
      expect(hub.has(sessionId)).toBe(true);

      jest.advanceTimersByTime(hub.__testing.DETACH_TTL_SECONDS * 1000 - 1000);
      // Flush any microtasks queued by timers that already fired.
      await Promise.resolve();
      expect(hub.has(sessionId)).toBe(true);

      jest.advanceTimersByTime(1000);
      // end() is async — let it (and its DB round trip) settle under real
      // timers before asserting.
      jest.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(hub.has(sessionId)).toBe(false);
      expect(hub.list(user.id, org.id).some((s) => s.id === sessionId)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  }, 10000);

  // -------------------------------------------------------------------
  // end() — reasons, idempotency, ended frame
  // -------------------------------------------------------------------

  maybeTest('end() broadcasts {type:"ended"} to every attached socket and closes them, exactly once', async () => {
    const { sessionId, client, stream } = await makeHubSession();
    const ws1 = new FakeWs();
    hub.addSocket(sessionId, ws1);
    const ws2 = new FakeWs();
    hub.attach(sessionId, ws2, { userId: user.id, orgId: org.id });

    const updated = await hub.end(sessionId, 'exit');
    expect(updated.status).toBe('ENDED');

    const frame1 = ws1.sent.map((s) => { try { return JSON.parse(s); } catch { return null; } }).find((f) => f?.type === 'ended');
    expect(frame1).toEqual({ type: 'ended', reason: 'exit' });
    expect(ws1.closeCalls.length).toBe(1);
    expect(ws2.closeCalls.length).toBe(1);
    expect(client.ended).toBe(true);
    expect(stream.destroyed).toBe(true);

    // Idempotent — a second end() is a safe no-op.
    const second = await hub.end(sessionId, 'error');
    expect(second).toBeNull();
    expect(hub.has(sessionId)).toBe(false);
  });

  maybeTest('"terminated"/"error" reasons end with TERMINATED status; other reasons end with ENDED', async () => {
    const a = await makeHubSession();
    const updatedA = await hub.end(a.sessionId, 'terminated', { terminatedBy: user.id });
    expect(updatedA.status).toBe('TERMINATED');

    const b = await makeHubSession();
    const updatedB = await hub.end(b.sessionId, 'expired');
    expect(updatedB.status).toBe('ENDED');
  });

  // -------------------------------------------------------------------
  // Ownership checks
  // -------------------------------------------------------------------

  function expectHubError(fn, code, wsCode) {
    let caught = null;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(hub.HubError);
    expect(caught.code).toBe(code);
    if (wsCode) expect(caught.wsCode).toBe(wsCode);
  }

  maybeTest('attach() throws SESSION_NOT_FOUND for an unknown session id', () => {
    expectHubError(
      () => hub.attach('does-not-exist', new FakeWs(), { userId: user.id, orgId: org.id }),
      'SESSION_NOT_FOUND',
      4404
    );
  });

  maybeTest('attach() throws SESSION_FORBIDDEN for another user in the same org', async () => {
    const { sessionId } = await makeHubSession();
    expectHubError(
      () => hub.attach(sessionId, new FakeWs(), { userId: otherUser.id, orgId: org.id }),
      'SESSION_FORBIDDEN',
      4403
    );

    await hub.end(sessionId, 'closed');
  });

  maybeTest('attach() throws SESSION_FORBIDDEN for a different org entirely', async () => {
    const { sessionId } = await makeHubSession();
    expectHubError(
      () => hub.attach(sessionId, new FakeWs(), { userId: user.id, orgId: 'some-other-org' }),
      'SESSION_FORBIDDEN'
    );

    await hub.end(sessionId, 'closed');
  });

  maybeTest('getConnectSpec / getPublic / rename / closeOwned are all ownership-checked', async () => {
    const { sessionId } = await makeHubSession();
    const wrong = { userId: otherUser.id, orgId: org.id };

    expectHubError(() => hub.getConnectSpec(sessionId, wrong), 'SESSION_FORBIDDEN');
    expectHubError(() => hub.getPublic(sessionId, wrong), 'SESSION_FORBIDDEN');
    expectHubError(() => hub.rename(sessionId, wrong, 'nope'), 'SESSION_FORBIDDEN');
    await expect(hub.closeOwned(sessionId, wrong)).rejects.toMatchObject({ code: 'SESSION_FORBIDDEN' });

    const right = { userId: user.id, orgId: org.id };
    const spec = hub.getConnectSpec(sessionId, right);
    expect(spec).toMatchObject({ type: 'quick_connect', host: 'example.test', auth: { type: 'password', password: 'super-secret' } });

    const renamed = hub.rename(sessionId, right, 'my session');
    expect(renamed.label).toBe('my session');

    await hub.closeOwned(sessionId, right);
    expect(hub.has(sessionId)).toBe(false);
  });

  maybeTest('list() only returns the caller\'s own live sessions', async () => {
    const mine = await makeHubSession();
    const theirs = await sessionService.create({
      orgId: org.id,
      userId: otherUser.id,
      sessionType: 'SSH',
      authMethod: 'quick_connect',
      targetHost: 'other.test',
      targetPort: 22,
      targetUser: 'root',
    });
    hub.create({
      id: theirs.id,
      orgId: org.id,
      userId: otherUser.id,
      client: new FakeClient(),
      stream: new FakeStream(),
      rows: 24,
      cols: 80,
      meta: { targetHost: 'other.test', targetPort: 22, targetUser: 'root', authMethod: 'quick_connect', label: 'other' },
      connectSpec: null,
    });

    const mineList = hub.list(user.id, org.id);
    expect(mineList.some((s) => s.id === mine.sessionId)).toBe(true);
    expect(mineList.some((s) => s.id === theirs.id)).toBe(false);

    await hub.end(mine.sessionId, 'closed');
    await hub.end(theirs.id, 'closed');
  });
});
