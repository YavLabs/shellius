/**
 * samlReplayStore.js — the two Redis-backed anti-replay controls for SAML,
 * and the one thing that makes them trustworthy: every command is BOUNDED and
 * every failure is CLOSED.
 *
 * ## Why bounding matters here specifically
 *
 * `config/redis.js` sets `maxRetriesPerRequest: null`. That is the right
 * setting for BullMQ, and a trap for everything else: when Redis is
 * unreachable, ioredis does not reject the command, it QUEUES it and retries
 * forever. A bare `await redis.get(...)` in a request handler therefore does
 * not fail — it hangs, for as long as the outage lasts, holding the request
 * open. So every call here races a timer.
 *
 * ## Why failing closed matters here specifically
 *
 * A SAML assertion is a bearer credential. It is signed, so an attacker
 * cannot forge one, but anyone who obtains a copy (a proxy log, a browser
 * history entry, a shared machine's back button, a malicious IdP-side actor)
 * can POST it again. Single-use is the ONLY thing standing between "that
 * assertion was used" and "that assertion can be used indefinitely until it
 * expires".
 *
 * So if the replay store cannot answer, we refuse the sign-in. An SSO outage
 * during a Redis outage is an inconvenience; accepting unbounded replays
 * during a Redis outage is a silent authentication bypass, and it would be
 * invisible — every affected login would look completely normal.
 *
 * (Contrast routes/slackInteractions.js, which deliberately fails OPEN on the
 * same kind of Redis claim. It can: its claim is a de-duplicator for Slack's
 * own retries, and the action behind it is separately idempotent. This one is
 * an authentication control with nothing behind it.)
 *
 * ## The two controls
 *
 *   1. Request ids (`saml:req:<providerId>:<requestId>`) — written when we
 *      send an AuthnRequest, read back as `InResponseTo`. This is SAML's
 *      equivalent of the OAuth `state` parameter: it binds the response to a
 *      sign-in THIS server started. Exposed as a node-saml `CacheProvider`.
 *
 *   2. Assertion ids (`saml:aid:<providerId>:<sha256(assertionId)>`) — an
 *      atomic SET NX claim taken the moment an assertion validates. This is
 *      the authoritative single-use control, and the only one that exists at
 *      all for IdP-initiated sign-ins, where there is no InResponseTo by
 *      definition.
 *
 * Both key spaces are namespaced by provider id. Provider ids are unique
 * across the whole install and each belongs to exactly one org, so two orgs
 * can never collide in this store — an assertion consumed in org A leaves no
 * trace that org B could observe or trip over.
 *
 * Assertion ids are hashed before use as a key. They are not secrets, but
 * they are IdP-internal identifiers that can encode session or user
 * information, and there is no reason for them to sit in plaintext in a
 * shared Redis that operators tail.
 */

import crypto from 'crypto';
import redis from '../../config/redis.js';
import logger from '../../utils/logger.js';

/** How long a Redis command may take before we treat Redis as unavailable. */
export const REDIS_TIMEOUT_MS = Number(process.env.SAML_REDIS_TIMEOUT_MS) || 2000;

/** How long an outstanding AuthnRequest id stays acceptable. */
export const REQUEST_ID_TTL_SEC = 10 * 60;

/** Floor / ceiling for the assertion-id claim TTL. */
export const ASSERTION_TTL_MIN_SEC = 5 * 60;
export const ASSERTION_TTL_MAX_SEC = 24 * 60 * 60;

export class SamlReplayStoreUnavailable extends Error {
  constructor(operation) {
    super('SAML replay protection is unavailable');
    this.name = 'SamlReplayStoreUnavailable';
    this.operation = operation;
  }
}

/**
 * Run one Redis command with a hard deadline.
 *
 * `redis.<cmd>()` returns a promise that, with `maxRetriesPerRequest: null`,
 * may never settle. Racing it against a timer is what converts "hangs
 * forever" into "throws in 2 seconds", which the callers turn into a refusal.
 * The losing promise is left to settle on its own; ioredis will resolve or
 * drop it when the connection recovers and nothing is listening by then.
 */
async function bounded(operation, fn, timeoutMs = REDIS_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SamlReplayStoreUnavailable(operation)), timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof SamlReplayStoreUnavailable) {
      logger.error('samlReplayStore: Redis unavailable — refusing SAML sign-in', { operation });
      throw err;
    }
    logger.error('samlReplayStore: Redis command failed — refusing SAML sign-in', {
      operation,
      error: err.message,
    });
    throw new SamlReplayStoreUnavailable(operation);
  } finally {
    clearTimeout(timer);
  }
}

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

const requestKey = (providerId, id) => `saml:req:${providerId}:${id}`;
const assertionKey = (providerId, assertionId) => `saml:aid:${providerId}:${sha256(assertionId)}`;

/**
 * A node-saml `CacheProvider` over Redis, scoped to one provider row.
 *
 * node-saml calls `saveAsync` when it generates an AuthnRequest and
 * `getAsync` / `removeAsync` while validating the response. The in-memory
 * default it would otherwise use is wrong for us twice over: it is lost on
 * every restart, and it is per-process, so with more than one backend replica
 * a response that lands on a different instance than the request is rejected
 * (or, worse with `validateInResponseTo: 'never'`, silently unchecked).
 *
 * `getAsync` and `saveAsync` throw when Redis cannot answer, which node-saml
 * propagates out of `validatePostResponseAsync` — the sign-in is refused.
 * `removeAsync` does NOT throw: it runs inside node-saml's own error handling
 * and is only an early-expiry optimisation. Single-use is enforced by
 * `claimAssertionId()` below, which is atomic and does throw.
 */
export function createCacheProvider(providerId, { client = redis, timeoutMs = REDIS_TIMEOUT_MS } = {}) {
  return {
    async saveAsync(key, value) {
      await bounded(
        'saveRequestId',
        () => client.set(requestKey(providerId, key), value, 'EX', REQUEST_ID_TTL_SEC),
        timeoutMs
      );
      return { value, createdAt: new Date().getTime() };
    },
    async getAsync(key) {
      if (!key) return null;
      return bounded('getRequestId', () => client.get(requestKey(providerId, key)), timeoutMs);
    },
    async removeAsync(key) {
      if (!key) return null;
      try {
        await bounded('removeRequestId', () => client.del(requestKey(providerId, key)), timeoutMs);
      } catch {
        // Best effort. The id expires on its own, and it is not the control
        // that makes an assertion single-use.
        return null;
      }
      return key;
    },
  };
}

/**
 * Work out how long an assertion-id claim must outlive the assertion itself.
 *
 * The claim has to cover every window in which the assertion would still be
 * accepted, or a replay that arrives after the claim expires but before the
 * assertion does would succeed. That window is bounded by the LATEST of the
 * assertion's own expiry times, plus the clock skew we tolerate.
 *
 * Clamped below by ASSERTION_TTL_MIN_SEC so a malformed or absent
 * NotOnOrAfter cannot produce a claim that expires immediately, and above by
 * ASSERTION_TTL_MAX_SEC so an IdP that issues a year-long assertion cannot
 * fill Redis. An assertion that outlives the ceiling is refused by
 * `MAX_ASSERTION_LIFETIME_SEC` in samlService before it ever gets here.
 */
export function assertionTtlSeconds({ notOnOrAfter, clockSkewSec = 60, now = Date.now() }) {
  let ttl = ASSERTION_TTL_MIN_SEC;
  const parsed = notOnOrAfter ? Date.parse(notOnOrAfter) : NaN;
  if (Number.isFinite(parsed)) {
    ttl = Math.ceil((parsed - now) / 1000) + clockSkewSec;
  }
  if (!Number.isFinite(ttl) || ttl < ASSERTION_TTL_MIN_SEC) ttl = ASSERTION_TTL_MIN_SEC;
  if (ttl > ASSERTION_TTL_MAX_SEC) ttl = ASSERTION_TTL_MAX_SEC;
  return ttl;
}

/**
 * Take the single-use claim on an assertion. Atomic (`SET NX`), so two
 * simultaneous POSTs of the same assertion cannot both win.
 *
 * @returns {Promise<boolean>} true when this call took the claim (first use).
 * @throws {SamlReplayStoreUnavailable} when Redis cannot answer — the caller
 *   MUST refuse the sign-in rather than proceed unprotected.
 */
export async function claimAssertionId(
  providerId,
  assertionId,
  ttlSec,
  // `client` and `timeoutMs` exist so the failure behaviour of this function
  // — the part that actually matters — can be tested without a live Redis and
  // without module mocking, which is unreliable under this repo's jest ESM
  // setup. Production never passes them.
  { client = redis, timeoutMs = REDIS_TIMEOUT_MS } = {}
) {
  if (!assertionId) return false; // no id to track — caller refuses
  const result = await bounded(
    'claimAssertionId',
    () => client.set(assertionKey(providerId, assertionId), '1', 'EX', ttlSec, 'NX'),
    timeoutMs
  );
  return result === 'OK';
}

/** Test seam / operational tool: has this assertion already been consumed? */
export async function assertionIdSeen(providerId, assertionId, { client = redis, timeoutMs = REDIS_TIMEOUT_MS } = {}) {
  const v = await bounded('assertionIdSeen', () => client.get(assertionKey(providerId, assertionId)), timeoutMs);
  return v !== null;
}

export default {
  createCacheProvider,
  claimAssertionId,
  assertionIdSeen,
  assertionTtlSeconds,
  SamlReplayStoreUnavailable,
  REDIS_TIMEOUT_MS,
  REQUEST_ID_TTL_SEC,
};
