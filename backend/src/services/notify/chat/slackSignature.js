/**
 * Verifying that a request really came from Slack.
 *
 * The interactions endpoint cannot be behind `authenticate` — Slack has no
 * Shellius session — so this signature is the *only* thing standing between a
 * stranger and an approve button. It is written to fail closed at every step.
 *
 * Slack signs `v0:{timestamp}:{rawBody}` with the app's signing secret and
 * sends the result as `X-Slack-Signature`, with the timestamp in
 * `X-Slack-Request-Timestamp`.
 *
 * Three details that are the difference between working and only appearing to:
 *
 * 1. **The raw body.** The signature covers the exact bytes Slack sent. A body
 *    that has been parsed and re-serialised will not match, so the route
 *    mounts its own parser that keeps `req.rawBody`. If that is missing this
 *    refuses rather than skipping the check — a future middleware reorder must
 *    break the endpoint loudly, not silently disable its only defence.
 * 2. **The timestamp window.** Without it a captured request could be replayed
 *    indefinitely. Five minutes is Slack's own recommendation.
 * 3. **A timing-safe comparison**, so the signature cannot be discovered a
 *    byte at a time.
 */

import crypto from 'crypto';

/** Slack's recommendation, and long enough to tolerate clock drift. */
export const MAX_SKEW_SECONDS = 60 * 5;
const VERSION = 'v0';

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifySlackSignature({ signingSecret, signature, timestamp, rawBody, now = Date.now() }) {
  if (!signingSecret) return { ok: false, reason: 'no signing secret configured' };
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };

  // Not "assume it is fine": a missing raw body means the parser was reordered
  // and the check cannot be performed at all.
  if (rawBody === undefined || rawBody === null) return { ok: false, reason: 'raw body unavailable' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(Math.floor(now / 1000) - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'timestamp outside the replay window' };
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = `${VERSION}=${crypto
    .createHmac('sha256', signingSecret)
    .update(`${VERSION}:${ts}:${body}`)
    .digest('hex')}`;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // nothing useful — but it must not throw into the request.
  if (a.length !== b.length) return { ok: false, reason: 'signature mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };

  return { ok: true };
}

export default { verifySlackSignature, MAX_SKEW_SECONDS };
