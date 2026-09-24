/**
 * instanceUpdate.test.js — requesting that this installation be upgraded.
 *
 * The property that matters most is the one about what this CANNOT express.
 * The application has no ability to upgrade itself — a container cannot
 * reliably replace itself, and the workarounds (the Docker socket, a shell on
 * the host) would hand the web app root on the machine holding the SSH CA.
 * All it can do is record an intent for a helper an operator installed
 * deliberately.
 *
 * Given that, the most useful thing a compromised application could ask for
 * through this channel is a DOWNGRADE to a published release with a known
 * vulnerability. That refusal is tested here and, independently, lives in the
 * helper script as well — a control that exists in only one of two places is
 * one bug away from not existing.
 */

import prisma from '../../config/db.js';
import * as instanceUpdateService from '../instanceUpdateService.js';
import { dbReachable } from './testDbHelper.js';

describe('version parsing', () => {
  test.each([['2.1.0'], ['v2.1.0'], ['10.20.30'], ['2.1.0-rc.1']])('accepts %s', (v) => {
    expect(instanceUpdateService.normalizeVersion(v)).toBe(v.replace(/^v/, ''));
  });

  test.each([
    ['latest'],
    ['2.1'],
    ['2'],
    [''],
    ['../../etc/passwd'],
    ['2.1.0; rm -rf /'],
    ['$(whoami)'],
    ['2.1.0 && curl evil.test'],
    [null],
    [undefined],
  ])('refuses %p', (v) => {
    expect(() => instanceUpdateService.normalizeVersion(v)).toThrow(/plain semver/);
  });

  // The version reaches a shell on the host, so nothing that is not a bare
  // version number may survive this function.
  test('a shell metacharacter never survives', () => {
    for (const bad of ['2.1.0;id', '2.1.0|id', '2.1.0`id`', '2.1.0\nid', '2.1.0 id']) {
      expect(() => instanceUpdateService.normalizeVersion(bad)).toThrow();
    }
  });
});

describe('requesting an upgrade (live DB)', () => {
  let running;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    running = (await instanceUpdateService.status()).currentVersion;
  });

  afterEach(async () => {
    if (!(await dbReachable())) return;
    await prisma.instanceUpdateRequest.deleteMany({});
    await prisma.instanceUpdateHelper.deleteMany({});
  });

  const bump = (v, by = 1) => {
    const [maj, min, patch] = v.split('.').map((n) => parseInt(n, 10));
    return `${maj}.${min}.${patch + by}`;
  };

  test('records a request for a newer version', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const row = await instanceUpdateService.request(bump(running), 'user-1');
    expect(row.status).toBe('requested');
    expect(row.targetVersion).toBe(bump(running));
    expect(row.fromVersion).toBe(running);
  });

  // The control that matters if the application itself is compromised.
  test('refuses a downgrade', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await expect(instanceUpdateService.request('0.0.1')).rejects.toThrow(/older than the running version/);
  });

  test('refuses the version already running', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await expect(instanceUpdateService.request(running)).rejects.toThrow(/already running/);
  });

  test('refuses a second request while one is in flight', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await instanceUpdateService.request(bump(running));
    await expect(instanceUpdateService.request(bump(running, 2))).rejects.toThrow(/already/);
  });

  test('a finished request does not block the next one', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const first = await instanceUpdateService.request(bump(running));
    await instanceUpdateService.reportStatus(first.id, 'succeeded', 'done');
    const second = await instanceUpdateService.request(bump(running, 2));
    expect(second.status).toBe('requested');
  });

  // Two helpers, or one helper whose previous run has not finished, must not
  // both start an upgrade on the same host.
  test('only one helper can claim a request', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const row = await instanceUpdateService.request(bump(running));
    const a = await instanceUpdateService.claim(row.id);
    const b = await instanceUpdateService.claim(row.id);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  test('a terminal status is not reopened by a late report', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const row = await instanceUpdateService.request(bump(running));
    await instanceUpdateService.claim(row.id);
    await instanceUpdateService.reportStatus(row.id, 'succeeded', 'upgraded');
    // A helper retrying after a network blip.
    const after = await instanceUpdateService.reportStatus(row.id, 'running', 'still going');
    expect(after.status).toBe('succeeded');
    expect(after.detail).toBe('upgraded');
  });

  test('an unknown status is refused', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const row = await instanceUpdateService.request(bump(running));
    await expect(instanceUpdateService.reportStatus(row.id, 'wat')).rejects.toThrow(/Unknown status/);
  });

  test('a request can be cancelled before it is claimed', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const row = await instanceUpdateService.request(bump(running));
    const cancelled = await instanceUpdateService.cancel(row.id);
    expect(cancelled.status).toBe('cancelled');
  });

  // "Cancel" once the host is mid-upgrade would be a lie about what the host
  // is doing.
  test('a claimed request cannot be cancelled', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const row = await instanceUpdateService.request(bump(running));
    await instanceUpdateService.claim(row.id);
    await expect(instanceUpdateService.cancel(row.id)).rejects.toThrow(/already been picked up/);
  });
});

describe('the helper credential (live DB)', () => {
  // This exists because the first version documented the helper as
  // authenticating with a service-account API token holding
  // `settings.updates`. That could never have worked: the permission is
  // non-delegable, and middleware/apiTokenAuth strips every non-delegable
  // permission from every API token, service accounts included. The helper
  // would have received 403 on every call, for ever, and nothing in the
  // service-layer tests would have noticed because they never drive a token
  // through the route stack.
  afterEach(async () => {
    if (!(await dbReachable())) return;
    await prisma.instanceUpdateHelper.deleteMany({});
  });

  test('is not an API token, and is never stored in the clear', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const token = await instanceUpdateService.issueHelperToken();
    expect(token.startsWith(instanceUpdateService.HELPER_TOKEN_PREFIX)).toBe(true);
    const row = await prisma.instanceUpdateHelper.findFirst();
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenHash).toBe(instanceUpdateService.hashHelperToken(token));
  });

  test('resolves only the exact credential', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const token = await instanceUpdateService.issueHelperToken();
    expect(await instanceUpdateService.resolveHelperToken(token)).not.toBeNull();
    expect(await instanceUpdateService.resolveHelperToken(`${token}x`)).toBeNull();
    expect(await instanceUpdateService.resolveHelperToken('')).toBeNull();
    expect(await instanceUpdateService.resolveHelperToken(null)).toBeNull();
    expect(await instanceUpdateService.resolveHelperToken('shup_nonsense')).toBeNull();
  });

  test('issuing again invalidates the previous credential', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const first = await instanceUpdateService.issueHelperToken();
    const second = await instanceUpdateService.issueHelperToken();
    expect(second).not.toBe(first);
    expect(await instanceUpdateService.resolveHelperToken(first)).toBeNull();
    expect(await instanceUpdateService.resolveHelperToken(second)).not.toBeNull();
  });

  test('revoking stops the helper working', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const token = await instanceUpdateService.issueHelperToken();
    await instanceUpdateService.revokeHelperToken();
    expect(await instanceUpdateService.resolveHelperToken(token)).toBeNull();
  });

  test('the UI can tell "never set up" from "set up but quiet"', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    expect((await instanceUpdateService.helperState()).credentialIssued).toBe(false);
    await instanceUpdateService.issueHelperToken();
    expect((await instanceUpdateService.helperState()).credentialIssued).toBe(true);
  });
});

describe('helper presence (live DB)', () => {
  afterEach(async () => {
    if (!(await dbReachable())) return;
    await prisma.instanceUpdateHelper.deleteMany({});
  });

  // The default, and a perfectly good end state: no helper, so the UI shows
  // the command to run by hand.
  test('no helper is the default', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const state = await instanceUpdateService.helperState();
    expect(state.present).toBe(false);
  });

  test('a polling helper is present', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await instanceUpdateService.touchHelper({ helperVersion: '1.0.0', hostname: 'host-a' });
    const state = await instanceUpdateService.helperState();
    expect(state.present).toBe(true);
    expect(state.helperVersion).toBe('1.0.0');
  });

  // A helper that was installed and went quiet is a different thing from one
  // that was never installed, and the difference matters when a request is
  // sitting unclaimed.
  test('a helper that has gone quiet is reported stale, not absent', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await instanceUpdateService.touchHelper({ helperVersion: '1.0.0' });
    await prisma.instanceUpdateHelper.updateMany({
      data: { lastSeenAt: new Date(Date.now() - instanceUpdateService.HELPER_STALE_MS - 1000) },
    });
    const state = await instanceUpdateService.helperState();
    expect(state.present).toBe(false);
    expect(state.stale).toBe(true);
    expect(state.lastSeenAt).not.toBeNull();
  });

  test('polling is an upsert, not an append', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    for (let i = 0; i < 5; i += 1) await instanceUpdateService.touchHelper({ helperVersion: '1.0.0' });
    expect(await prisma.instanceUpdateHelper.count()).toBe(1);
  });
});
