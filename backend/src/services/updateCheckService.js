/**
 * updateCheckService.js — "is there a newer Shellius than the one running?"
 *
 * Phase one of the OTA work, and deliberately the harmless half: this tells
 * an administrator that an update exists. It does not download anything, does
 * not touch containers, and has no path to changing what is running. The
 * upgrade is still `./update-shellius.sh <tag>`, run by a human on the host.
 *
 * Three properties this has to hold, because it is the first thing in the
 * product that talks to the internet on its own:
 *
 *   1. **It sends nothing.** A plain unauthenticated GET for the repository's
 *      latest release. No org id, no install id, no version, no telemetry of
 *      any kind — a self-hosted security tool must not phone home, and the
 *      only way to be sure of that is for the request to carry nothing.
 *   2. **It can be turned off**, for the air-gapped installs that are a real
 *      part of this product's audience. `UPDATE_CHECK_ENABLED=false`.
 *   3. **It never blocks or fails anything.** Every error is a field in the
 *      result, never an exception into a request path; a failed check reports
 *      the last known answer rather than nothing.
 */

import { createRequire } from 'module';
import redis from '../config/redis.js';
import logger from '../utils/logger.js';

const require = createRequire(import.meta.url);
const { version: CURRENT_VERSION } = require('../../package.json');

/** Where releases are published. Overridable for a fork or a mirror. */
export const RELEASES_API =
  process.env.UPDATE_CHECK_URL || 'https://api.github.com/repos/YavLabs/shellius/releases/latest';

const CACHE_KEY = 'shellius:update-check';
/** GitHub allows 60 unauthenticated requests an hour; this asks 4 times a day. */
const CACHE_TTL_SECONDS = Number(process.env.UPDATE_CHECK_TTL_SECONDS || 6 * 60 * 60);
/** A slow or blocked network must not hold a request open. */
const TIMEOUT_MS = Number(process.env.UPDATE_CHECK_TIMEOUT_MS || 5000);

export function isEnabled() {
  return String(process.env.UPDATE_CHECK_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Compare two semver strings.
 *
 * Deliberately small rather than a dependency, and deliberately conservative:
 * anything it cannot parse compares as "not newer", so a fork's version
 * scheme, a `-dev` build or a garbled tag produces "you are up to date"
 * rather than a permanent nag.
 *
 * Pre-releases sort BELOW their release (2.1.0-rc.1 < 2.1.0), per semver, so
 * someone running an rc is correctly told the final is newer.
 *
 * @returns {number} negative if a < b, 0 if equal, positive if a > b; NaN if
 *   either side is unparseable.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? '').trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return NaN;

  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  // Equal numerically: a pre-release is older than the release it precedes.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}

/** True when `latest` is a version worth telling somebody about. */
export function isNewer(latest, current = CURRENT_VERSION) {
  const cmp = compareVersions(latest, current);
  return Number.isNaN(cmp) ? false : cmp > 0;
}

/**
 * Bound a Redis call.
 *
 * The client is configured with `maxRetriesPerRequest: null` and an infinite
 * retry strategy, which means a command issued while Redis is unreachable
 * does not reject — it QUEUES, forever. A try/catch cannot save a caller from
 * that, so every cache touch here races a timer. The timer is unref'd so it
 * cannot by itself hold a short-lived process (or a test run) open.
 *
 * Redis being down must cost this feature its cache, never its answer.
 */
const REDIS_TIMEOUT_MS = 500;

function bounded(promise, fallback = null) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(fallback), REDIS_TIMEOUT_MS);
      t.unref?.();
    }),
  ]).catch(() => fallback);
}

async function readCache() {
  const raw = await bounded(redis.get(CACHE_KEY));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // A cache entry we cannot read is the same as no cache entry.
    return null;
  }
}

async function writeCache(value) {
  await bounded(redis.set(CACHE_KEY, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS));
}

/**
 * Ask the release API. Returns the useful fields, or throws — the caller
 * decides what a failure means.
 */
async function fetchLatest(fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(RELEASES_API, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        // Identifies the software, not the installation. No version, no id.
        'User-Agent': 'Shellius',
      },
    });
    if (res.status === 403 || res.status === 429) {
      throw new Error('Rate limited by the release API');
    }
    if (!res.ok) throw new Error(`Release API returned ${res.status}`);
    const body = await res.json();
    return {
      latestVersion: String(body?.tag_name || '').replace(/^v/, '') || null,
      releaseUrl: body?.html_url || null,
      publishedAt: body?.published_at || null,
      releaseName: body?.name || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The current update status.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]  ignore the cache (the "check now" button)
 * @param {Function} [opts.fetchImpl]  injected for tests
 */
export async function getStatus({ force = false, fetchImpl = fetch } = {}) {
  // An injected fetch means a caller is simulating the release API — a test,
  // or a future "what would this look like" preview. Its answer must never
  // reach the shared cache: the test suite writing a fabricated release into
  // Redis would leave the running instance reporting that fabrication as the
  // latest version, which is exactly what happened the first time this was
  // run against a live dev instance.
  const simulated = fetchImpl !== fetch;
  const base = {
    currentVersion: CURRENT_VERSION,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    publishedAt: null,
    checkedAt: null,
    enabled: isEnabled(),
    error: null,
  };

  if (!isEnabled()) {
    return { ...base, error: null, disabledReason: 'Update checks are turned off on this install' };
  }

  const cached = force || simulated ? null : await readCache();
  if (cached) {
    return { ...base, ...cached, updateAvailable: isNewer(cached.latestVersion) };
  }

  try {
    const fresh = await fetchLatest(fetchImpl);
    const value = { ...fresh, checkedAt: new Date().toISOString(), error: null };
    if (!simulated) await writeCache(value);
    return { ...base, ...value, updateAvailable: isNewer(value.latestVersion) };
  } catch (err) {
    // An install with no outbound internet is a supported configuration, not
    // a fault, so this is a debug line rather than an error — but the reason
    // is still reported to the screen that asked.
    logger.debug('updateCheck: could not reach the release API', { error: err.message });
    const stale = simulated ? null : await readCache();
    if (stale) {
      return {
        ...base,
        ...stale,
        updateAvailable: isNewer(stale.latestVersion),
        error: `Could not check for updates (${err.message}); showing the last known result`,
      };
    }
    return { ...base, error: `Could not check for updates: ${err.message}` };
  }
}

export default { RELEASES_API, CURRENT_VERSION, isEnabled, compareVersions, isNewer, getStatus };
