/**
 * webhook — plain JSON to anything else: Discord, Mattermost, Rocket.Chat,
 * PagerDuty, or a script somebody wrote.
 *
 * The one adapter here whose destination is NOT a known service, so it is also
 * the only one that needs the SSRF guard: without it, a destination is a way
 * to make Shellius probe its own network, including cloud metadata endpoints.
 * The other three are pinned to their vendor's hostname instead, which is a
 * stronger control where it applies.
 *
 * The payload is the neutral message, not a platform's card format, and it is
 * signed the way the audit webhook sink signs — an HMAC over `<ts>.<body>`,
 * the convention receivers already have code for.
 */

import crypto from 'crypto';
import { guardSsrf } from '../../../utils/ssrf.js';
import { postForm } from './http.js';
import { ChatConfigError, RetryableChatError, PermanentChatError } from './errors.js';
import { normalizeMessage } from './message.js';

export const platform = 'webhook';
export const label = 'Webhook (JSON)';
export const secretFields = ['signingSecret'];
export const supportsButtons = false;
export const supportsDirectMessages = false;

/** An internal collector is legitimate, but it has to be deliberate. */
const ALLOW_PRIVATE = process.env.CHAT_WEBHOOK_ALLOW_PRIVATE === 'true';

export function validateConfig(config = {}) {
  const url = String(config.url || '').trim();
  if (!url) throw new ChatConfigError('A URL is required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ChatConfigError('That is not a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new ChatConfigError('The URL must be http or https');
  if (parsed.protocol === 'http:' && !ALLOW_PRIVATE) {
    throw new ChatConfigError('Use https — notifications name servers, people and reasons');
  }
  return { url, signingSecret: config.signingSecret ? String(config.signingSecret) : undefined };
}

export function describeConfig(config = {}) {
  try {
    return new URL(config.url).host;
  } catch {
    return 'webhook';
  }
}

/** `t=<unix>,v1=<hex>` over `<t>.<body>` — the Stripe convention. */
export function signBody(secret, body, ts) {
  const mac = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${mac}`;
}

export function buildPayload(message, event) {
  const m = normalizeMessage(message);
  return {
    version: 1,
    event: event ?? null,
    severity: m.severity,
    title: m.title,
    summary: m.summary,
    fields: m.fields,
    url: m.url,
    sentAt: new Date().toISOString(),
  };
}

export async function deliver(config, message, { event = null } = {}) {
  const cfg = validateConfig(config);
  await guardSsrf(cfg.url, { allowPrivate: ALLOW_PRIVATE });

  const body = JSON.stringify(buildPayload(message, event));
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.signingSecret) {
    headers['X-Shellius-Signature'] = signBody(cfg.signingSecret, body, Math.floor(Date.now() / 1000));
  }

  const res = await postForm(cfg.url, body, { contentType: 'application/json', label: 'Webhook' });
  if (res.status === 429 || res.status === 408) {
    throw new RetryableChatError(`Webhook returned ${res.status}`, { retryAfterMs: res.retryAfterMs });
  }
  if (res.status >= 500) throw new RetryableChatError(`Webhook returned ${res.status}`);
  if (res.status >= 400) {
    throw new PermanentChatError(`Webhook rejected the message (${res.status})`, {
      disable: res.status === 401 || res.status === 403 || res.status === 404,
    });
  }
  return { ok: true };
}

export async function test(config) {
  await deliver(
    config,
    { title: 'Shellius test message', summary: 'If you can read this, this destination is working.', severity: 'info' },
    { event: 'test' }
  );
  return { ok: true, detail: 'Posted a test payload' };
}

export default {
  platform,
  label,
  secretFields,
  supportsButtons,
  supportsDirectMessages,
  validateConfig,
  describeConfig,
  signBody,
  buildPayload,
  deliver,
  test,
};
