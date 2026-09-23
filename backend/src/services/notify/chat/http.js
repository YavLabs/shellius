/**
 * Shared HTTP for the chat adapters.
 *
 * Deliberately separate from the audit sink's helper, because the two have
 * opposite defaults. An audit sink posts to whatever collector a customer
 * names, so it needs an SSRF guard and treats HTTP status as the whole truth.
 * A chat adapter posts to one of four known services, so the right control is
 * a host allowlist — and the status code is NOT the whole truth, because Slack
 * and Google Chat both answer failures with HTTP 200 and an error in the body.
 */

import { RetryableChatError, PermanentChatError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 15_000;

function retryAfterMs(res) {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 5 * 60 * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function send(url, { method = 'POST', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new RetryableChatError(`${label} did not respond within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new RetryableChatError(`${label} could not be reached: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** POST and parse JSON. The caller inspects the body for platform errors. */
export async function fetchJson(url, opts = {}) {
  const res = await send(url, opts);
  const text = await res.text();

  if (res.status === 429) {
    throw new RetryableChatError(`${opts.label} is rate limiting us`, { retryAfterMs: retryAfterMs(res) });
  }
  if (res.status >= 500) throw new RetryableChatError(`${opts.label} returned ${res.status}`);
  if (res.status === 401 || res.status === 403) {
    throw new PermanentChatError(`${opts.label} rejected the credential (${res.status})`, { disable: true });
  }
  if (!res.ok && res.status !== 200) {
    throw new PermanentChatError(`${opts.label} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new PermanentChatError(`${opts.label} returned a response that was not JSON`);
  }
}

/**
 * POST where the response is not JSON (an incoming webhook answers "ok").
 * Returns the status so the adapter can classify it itself.
 */
export async function postForm(url, body, { contentType = 'application/json', label } = {}) {
  const res = await send(url, { headers: { 'Content-Type': contentType }, body, label });
  return { status: res.status, body: await res.text(), retryAfterMs: retryAfterMs(res) };
}

export default { fetchJson, postForm };
