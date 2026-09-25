/**
 * samlReplayStore — the anti-replay controls, and the two properties that
 * make them worth having: they are BOUNDED and they fail CLOSED.
 *
 * The bounding is not a nicety. `config/redis.js` sets
 * `maxRetriesPerRequest: null`, which means a command issued while Redis is
 * unreachable does not reject — it queues and retries forever. A bare await
 * in a login handler would hang for the length of the outage. The tests below
 * use a client whose commands never settle, which is exactly that behaviour.
 *
 * No live Redis: the client is injected.
 */

import { claimAssertionId, createCacheProvider, assertionTtlSeconds, SamlReplayStoreUnavailable, ASSERTION_TTL_MIN_SEC, ASSERTION_TTL_MAX_SEC } from '../saml/samlReplayStore.js';

/** A minimal in-memory stand-in for the ioredis surface we use. */
function fakeRedis() {
  const store = new Map();
  return {
    calls: [],
    async set(key, value, ...args) {
      this.calls.push(['set', key, ...args]);
      const nx = args.includes('NX');
      if (nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async get(key) {
      this.calls.push(['get', key]);
      return store.has(key) ? store.get(key) : null;
    },
    async del(key) {
      this.calls.push(['del', key]);
      return store.delete(key) ? 1 : 0;
    },
    _store: store,
  };
}

/** What ioredis actually does with `maxRetriesPerRequest: null` and a dead
 *  server: the promise never settles. */
function hangingRedis() {
  const never = () => new Promise(() => {});
  return { set: never, get: never, del: never };
}

/** A server that is up but angry (OOM, READONLY replica, auth failure). */
function failingRedis() {
  const boom = async () => {
    throw new Error('READONLY You can\'t write against a read only replica.');
  };
  return { set: boom, get: boom, del: boom };
}

const TIMEOUT = 100;

describe('claimAssertionId', () => {
  test('the first claim wins and the second is refused', async () => {
    const client = fakeRedis();
    expect(await claimAssertionId('p1', 'a1', 300, { client })).toBe(true);
    expect(await claimAssertionId('p1', 'a1', 300, { client })).toBe(false);
  });

  test('claims are namespaced per provider, so two orgs never collide', async () => {
    const client = fakeRedis();
    expect(await claimAssertionId('p1', 'same-id', 300, { client })).toBe(true);
    expect(await claimAssertionId('p2', 'same-id', 300, { client })).toBe(true);
  });

  test('uses an atomic SET NX with a TTL, not a read-then-write', async () => {
    // A get-then-set would let two concurrent POSTs of the same assertion
    // both observe "not seen" and both succeed.
    const client = fakeRedis();
    await claimAssertionId('p1', 'a1', 300, { client });
    expect(client.calls[0]).toEqual(['set', expect.any(String), 'EX', 300, 'NX']);
  });

  test('hashes the assertion id rather than putting it in the key verbatim', async () => {
    const client = fakeRedis();
    await claimAssertionId('p1', 'alice-session-id-12345', 300, { client });
    const key = client.calls[0][1];
    expect(key).not.toContain('alice-session-id-12345');
    expect(key).toMatch(/^saml:aid:p1:[0-9a-f]{64}$/);
  });

  test('refuses an assertion with no id at all', async () => {
    const client = fakeRedis();
    expect(await claimAssertionId('p1', null, 300, { client })).toBe(false);
  });

  test('THROWS rather than hanging when Redis never answers', async () => {
    const started = Date.now();
    await expect(claimAssertionId('p1', 'a1', 300, { client: hangingRedis(), timeoutMs: TIMEOUT })).rejects.toBeInstanceOf(
      SamlReplayStoreUnavailable
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('THROWS — never returns true — when Redis errors', async () => {
    // Returning true here would be the worst possible bug: it reads as "you
    // are the first to use this assertion", i.e. unlimited replay.
    await expect(claimAssertionId('p1', 'a1', 300, { client: failingRedis(), timeoutMs: TIMEOUT })).rejects.toBeInstanceOf(
      SamlReplayStoreUnavailable
    );
  });
});

describe('the node-saml cache provider', () => {
  test('stores and retrieves an outstanding AuthnRequest id', async () => {
    const client = fakeRedis();
    const cache = createCacheProvider('p1', { client });
    await cache.saveAsync('_req1', '2026-01-01T00:00:00Z');
    expect(await cache.getAsync('_req1')).toBe('2026-01-01T00:00:00Z');
    await cache.removeAsync('_req1');
    expect(await cache.getAsync('_req1')).toBeNull();
  });

  test('request ids are namespaced per provider too', async () => {
    const client = fakeRedis();
    await createCacheProvider('p1', { client }).saveAsync('_req1', 'x');
    expect(await createCacheProvider('p2', { client }).getAsync('_req1')).toBeNull();
  });

  test('getAsync throws when Redis is unavailable, so validation cannot proceed', async () => {
    const cache = createCacheProvider('p1', { client: hangingRedis(), timeoutMs: TIMEOUT });
    await expect(cache.getAsync('_req1')).rejects.toBeInstanceOf(SamlReplayStoreUnavailable);
  });

  test('saveAsync throws, so a login is never STARTED unbound', async () => {
    const cache = createCacheProvider('p1', { client: hangingRedis(), timeoutMs: TIMEOUT });
    await expect(cache.saveAsync('_req1', 'x')).rejects.toBeInstanceOf(SamlReplayStoreUnavailable);
  });

  test('removeAsync stays quiet on failure — it is an optimisation, not a control', async () => {
    // Failing to delete an already-validated request id leaves it usable
    // until its TTL, which the assertion-id claim covers. Throwing here would
    // turn a successful login into an error after the fact.
    const cache = createCacheProvider('p1', { client: hangingRedis(), timeoutMs: TIMEOUT });
    await expect(cache.removeAsync('_req1')).resolves.toBeNull();
  });
});

describe('assertionTtlSeconds', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  test('covers the assertion validity window plus the clock skew', () => {
    const ttl = assertionTtlSeconds({ notOnOrAfter: '2026-01-01T00:05:00Z', clockSkewSec: 60, now });
    expect(ttl).toBe(360);
  });

  test('never shorter than the floor, so a missing or past NotOnOrAfter cannot produce a claim that expires instantly', () => {
    expect(assertionTtlSeconds({ notOnOrAfter: null, now })).toBe(ASSERTION_TTL_MIN_SEC);
    expect(assertionTtlSeconds({ notOnOrAfter: 'not a date', now })).toBe(ASSERTION_TTL_MIN_SEC);
    expect(assertionTtlSeconds({ notOnOrAfter: '2025-01-01T00:00:00Z', now })).toBe(ASSERTION_TTL_MIN_SEC);
  });

  test('never longer than the ceiling, so an absurd assertion cannot fill Redis', () => {
    expect(assertionTtlSeconds({ notOnOrAfter: '2030-01-01T00:00:00Z', now })).toBe(ASSERTION_TTL_MAX_SEC);
  });
});
