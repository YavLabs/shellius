/**
 * webhook — batched JSON POST to any HTTP collector.
 *
 * The widest-reach sink: Splunk HEC, Datadog, Panther, Tines, or a script
 * someone wrote. Uses global fetch (Node 20), so it adds no dependency.
 *
 * Signing follows the convention Stripe popularised, because it is the one
 * receivers already have code for: a timestamp and an HMAC over
 * `<timestamp>.<body>`. The timestamp is inside the signed material so an
 * old, valid body can't be replayed later, and receivers can reject
 * anything too old.
 */

import crypto from 'crypto';
import { guardSsrf } from '../../../utils/ssrf.js';
import { RetryableSinkError, PermanentSinkError, SinkConfigError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * An on-prem SIEM on a private network is a legitimate destination, but it
 * has to be a deliberate choice — otherwise a webhook sink is a way to make
 * Shellius probe its own network, including cloud metadata endpoints.
 */
const ALLOW_PRIVATE = process.env.AUDIT_WEBHOOK_ALLOW_PRIVATE === 'true';

export const type = 'webhook';
export const label = 'Webhook (HTTP POST)';
export const streaming = true;
export const secretFields = ['signingSecret'];
export const maxBatch = 500;

export function validateConfig(config = {}) {
  const url = String(config.url || '').trim();
  if (!url) throw new SinkConfigError('A URL is required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new SinkConfigError('That is not a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SinkConfigError('The URL must be http or https');
  }
  if (parsed.protocol === 'http:' && !ALLOW_PRIVATE) {
    throw new SinkConfigError('Use https — audit entries must not travel in the clear');
  }

  const headers = config.headers && typeof config.headers === 'object' ? config.headers : {};
  for (const [k, v] of Object.entries(headers)) {
    // A header value with a newline in it can inject further headers.
    if (/[\r\n]/.test(String(k)) || /[\r\n]/.test(String(v))) {
      throw new SinkConfigError('Header names and values cannot contain line breaks');
    }
  }

  const timeoutMs = Number(config.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new SinkConfigError('Timeout must be between 1 and 120 seconds');
  }

  return {
    url,
    signingSecret: config.signingSecret ? String(config.signingSecret) : null,
    headers,
    timeoutMs,
  };
}

export function notReadyReason(config = {}) {
  if (!config.url) return 'No URL set';
  return null;
}

/** `t=<unix>,v1=<hex>` over `<t>.<body>`. */
export function signBody(secret, body, timestampSeconds) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

async function post(config, payload, { fetchImpl = fetch } = {}) {
  await guardSsrf(config.url, { allowPrivate: ALLOW_PRIVATE });

  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Shellius-Audit/1',
    // The receiver's idempotency key: delivery is at-least-once, so the same
    // batch id can legitimately arrive twice.
    'X-Shellius-Delivery': payload.batchId,
    ...config.headers,
  };
  if (config.signingSecret) {
    headers['X-Shellius-Signature'] = signBody(config.signingSecret, body, Math.floor(Date.now() / 1000));
  }

  let res;
  try {
    res = await fetchImpl(config.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(config.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error, DNS failure, timeout — all worth another go.
    throw new RetryableSinkError(`Could not reach the endpoint: ${err.message}`, { cause: err });
  }

  if (res.ok) return { status: res.status };

  const retryAfter = Number(res.headers?.get?.('retry-after'));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;

  if (res.status === 408 || res.status === 429 || res.status >= 500) {
    throw new RetryableSinkError(`The endpoint returned ${res.status}`, { retryAfterMs });
  }
  // Any other 4xx is a configuration problem — retrying can't fix a 404 or
  // a rejected credential, and quietly retrying would hide it.
  throw new PermanentSinkError(`The endpoint returned ${res.status}`);
}

export async function deliver(config, envelopes, ctx = {}) {
  const payload = {
    v: 1,
    sinkId: ctx.sinkId ?? null,
    orgId: ctx.orgId ?? null,
    batchId: ctx.batchId ?? null,
    count: envelopes.length,
    records: envelopes,
  };
  const { status } = await post(config, payload, ctx);
  return { detail: `HTTP ${status}` };
}

export async function test(config, ctx = {}) {
  const payload = {
    v: 1,
    test: true,
    sinkId: ctx.sinkId ?? null,
    orgId: ctx.orgId ?? null,
    batchId: `test-${Date.now()}`,
    count: 0,
    records: [],
  };
  const { status } = await post(config, payload, ctx);
  return { ok: true, detail: `Endpoint accepted the test delivery (HTTP ${status})` };
}

export default { type, label, streaming, secretFields, maxBatch, validateConfig, notReadyReason, deliver, test, signBody };
