/**
 * updateCheck.test.js — the first thing in Shellius that talks to the
 * internet by itself.
 *
 * Three properties matter more than the feature does:
 *
 *   - it sends nothing about the installation (a self-hosted security tool
 *     that phones home is a different product);
 *   - it can be turned off, because air-gapped installs are a real part of
 *     this audience;
 *   - it never throws and never hangs, because a banner must not be able to
 *     take a page down.
 *
 * The comparator gets the most tests because a wrong answer there is a
 * permanent false "update available" nag, which is how people learn to
 * ignore an update banner.
 */

import { compareVersions, isNewer, getStatus, isEnabled, RELEASES_API } from '../updateCheckService.js';

// Every call below passes `force: true`, so the cache is never read and the
// suite needs no Redis of its own. That is also the point of the bounded
// cache helpers in the service: with `maxRetriesPerRequest: null` a Redis
// command QUEUES rather than failing when the server is unreachable, so an
// unbounded cache touch would hang the check instead of just missing it.

/** A fetch that answers with one canned release. */
const okFetch = (body, init = {}) => async () => ({
  ok: true,
  status: 200,
  ...init,
  json: async () => body,
});

describe('compareVersions', () => {
  test.each([
    ['2.1.0', '2.0.0', 1],
    ['2.0.0', '2.1.0', -1],
    ['2.0.0', '2.0.0', 0],
    ['2.0.1', '2.0.0', 1],
    ['3.0.0', '2.99.99', 1],
    ['2.10.0', '2.9.0', 1], // not a string comparison
    ['10.0.0', '9.0.0', 1],
  ])('%s vs %s', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });

  test('a leading v is ignored on either side', () => {
    expect(compareVersions('v2.1.0', '2.1.0')).toBe(0);
    expect(Math.sign(compareVersions('v2.1.0', 'v2.0.0'))).toBe(1);
  });

  // Semver: a pre-release precedes its release.
  test('a pre-release is older than the release it precedes', () => {
    expect(Math.sign(compareVersions('2.1.0-rc.1', '2.1.0'))).toBe(-1);
    expect(Math.sign(compareVersions('2.1.0', '2.1.0-rc.1'))).toBe(1);
    expect(Math.sign(compareVersions('2.1.0-rc.1', '2.1.0-rc.2'))).toBe(-1);
  });

  test.each([
    ['nonsense', '2.0.0'],
    ['2.0.0', 'nonsense'],
    [null, '2.0.0'],
    [undefined, '2.0.0'],
    ['', '2.0.0'],
    ['2.0', '2.0.0'],
    [{}, '2.0.0'],
  ])('an unparseable version (%p vs %p) is NaN, not a guess', (a, b) => {
    expect(Number.isNaN(compareVersions(a, b))).toBe(true);
  });
});

describe('isNewer', () => {
  test('true only for a strictly greater version', () => {
    expect(isNewer('2.1.0', '2.0.0')).toBe(true);
    expect(isNewer('2.0.0', '2.0.0')).toBe(false);
    expect(isNewer('1.9.0', '2.0.0')).toBe(false);
  });

  // The important direction: anything unparseable must NOT nag.
  test('an unparseable version never claims an update is available', () => {
    expect(isNewer('nightly', '2.0.0')).toBe(false);
    expect(isNewer(null, '2.0.0')).toBe(false);
    expect(isNewer('2.1.0', 'my-fork-build')).toBe(false);
  });
});

describe('getStatus', () => {
  beforeEach(() => {
    delete process.env.UPDATE_CHECK_ENABLED;
  });

  afterAll(() => {
    delete process.env.UPDATE_CHECK_ENABLED;
  });

  test('reports an available update', async () => {
    const status = await getStatus({
      force: true,
      fetchImpl: okFetch({
        tag_name: 'v99.0.0',
        html_url: 'https://github.com/YavLabs/shellius/releases/tag/v99.0.0',
        published_at: '2026-09-01T00:00:00Z',
        name: 'Shellius v99.0.0',
      }),
    });
    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe('99.0.0');
    expect(status.releaseUrl).toContain('v99.0.0');
    expect(status.currentVersion).toBeTruthy();
  });

  test('reports no update when the latest is the running version', async () => {
    const current = (await getStatus({ force: true, fetchImpl: okFetch({ tag_name: 'v0.0.1' }) })).currentVersion;
    const status = await getStatus({ force: true, fetchImpl: okFetch({ tag_name: `v${current}` }) });
    expect(status.updateAvailable).toBe(false);
  });

  test('an older published release does not claim an update', async () => {
    const status = await getStatus({ force: true, fetchImpl: okFetch({ tag_name: 'v0.0.1' }) });
    expect(status.updateAvailable).toBe(false);
  });

  // An air-gapped install is a supported configuration, not a fault.
  test('can be turned off, and then makes no request at all', async () => {
    process.env.UPDATE_CHECK_ENABLED = 'false';
    let called = false;
    const status = await getStatus({
      force: true,
      fetchImpl: async () => {
        called = true;
        throw new Error('should not be called');
      },
    });
    expect(called).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.updateAvailable).toBe(false);
    expect(status.disabledReason).toMatch(/turned off/);
  });

  test('a network failure is a field, not an exception', async () => {
    const status = await getStatus({
      force: true,
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      },
    });
    expect(status.error).toMatch(/Could not check for updates/);
    expect(status.updateAvailable).toBe(false);
    expect(status.currentVersion).toBeTruthy();
  });

  test('a rate-limited response says so rather than looking like no update', async () => {
    const status = await getStatus({
      force: true,
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    expect(status.error).toMatch(/Rate limited/);
  });

  test('a 5xx is reported', async () => {
    const status = await getStatus({
      force: true,
      fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
    });
    expect(status.error).toMatch(/502/);
  });

  test('a malformed body does not claim an update', async () => {
    const status = await getStatus({ force: true, fetchImpl: okFetch({ nothing: 'useful' }) });
    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBeNull();
  });

  // The request must carry nothing identifying. This is the phone-home test.
  test('sends no identifying information', async () => {
    let seenUrl;
    let seenInit;
    await getStatus({
      force: true,
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenInit = init;
        return { ok: true, status: 200, json: async () => ({ tag_name: 'v2.0.0' }) };
      },
    });

    expect(seenUrl).toBe(RELEASES_API);
    // A GET with no body at all.
    expect(seenInit.body).toBeUndefined();
    expect(seenInit.method ?? 'GET').toBe('GET');
    // The User-Agent names the software, never a version or an install id.
    expect(seenInit.headers['User-Agent']).toBe('Shellius');
    const headerBlob = JSON.stringify(seenInit.headers);
    expect(headerBlob).not.toMatch(/orgId|installId|licen[cs]e|telemetry/i);
    // And no query string carrying anything.
    expect(String(seenUrl)).not.toContain('?');
  });

  test('a slow endpoint is abandoned rather than held open', async () => {
    const status = await getStatus({
      force: true,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    expect(status.error).toBeTruthy();
    expect(status.updateAvailable).toBe(false);
  }, 20_000);

  test('isEnabled defaults to on', () => {
    delete process.env.UPDATE_CHECK_ENABLED;
    expect(isEnabled()).toBe(true);
    process.env.UPDATE_CHECK_ENABLED = 'false';
    expect(isEnabled()).toBe(false);
    process.env.UPDATE_CHECK_ENABLED = 'true';
    expect(isEnabled()).toBe(true);
  });
});
