/**
 * Shared HTTP plumbing for the email provider adapters.
 *
 * Every adapter talks to a FIXED, provider-owned URL (no user-supplied URLs —
 * the only user-controlled network target in email delivery is the SMTP
 * host). Requests never follow redirects and always carry a timeout.
 */

export const HTTP_TIMEOUT_MS = 15000;

/**
 * An error returned (or caused) by an email provider. `message` is safe to
 * show an admin and to log: it carries the provider's own error text, never
 * request credentials.
 */
export class ProviderError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
  }
}

/** Trim a provider message so a verbose HTML error page can't flood logs/UI. */
export function truncate(value, max = 500) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * fetch() with a timeout, no redirects, and the body read + JSON-parsed.
 *
 * @param {string} url      - provider endpoint (constant per provider)
 * @param {object} opts
 * @param {string} [opts.method='POST']
 * @param {object} [opts.headers]
 * @param {string|URLSearchParams} [opts.body]
 * @param {number} [opts.timeoutMs]
 * @param {string} opts.label - provider label for error messages
 * @returns {Promise<{ status: number, ok: boolean, json: any, text: string }>}
 */
export async function httpRequest(url, { method = 'POST', headers = {}, body, timeoutMs = HTTP_TIMEOUT_MS, label }) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new ProviderError(`${label}: request timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'TIMEOUT' });
    }
    throw new ProviderError(`${label}: network error — ${truncate(err?.cause?.message || err?.message || 'request failed', 200)}`, {
      code: 'NETWORK',
    });
  }

  const text = await res.text().catch(() => '');
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, ok: res.ok, json, text };
}

/**
 * Throw a ProviderError for a non-2xx response, using `extract(json, text)`
 * to pull the provider's own error message out of the body.
 */
export function failFromResponse(label, res, extract) {
  let detail = null;
  try {
    detail = extract ? extract(res.json, res.text) : null;
  } catch {
    detail = null;
  }
  if (!detail) detail = res.text ? truncate(res.text, 300) : 'no response body';
  throw new ProviderError(`${label} error (HTTP ${res.status}): ${truncate(detail)}`, { status: res.status });
}

/** { name, address } → RFC 5322 display form, e.g. `"Shellius" <noreply@x.io>`. */
export function formatAddress({ name, address }) {
  if (!name) return address;
  const escaped = String(name).replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\r\n]/g, ' ');
  return `"${escaped}" <${address}>`;
}

/** Normalise `to` (string | string[]) to a de-duplicated array. */
export function recipients(to) {
  const list = Array.isArray(to) ? to : String(to || '').split(',');
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Access-token cache (OAuth providers). Keyed by a hash of the credentials so
// editing a provider's credentials never reuses the old token. In-memory,
// per process — tokens are short-lived and cheap to re-mint.
// ---------------------------------------------------------------------------

const tokenCache = new Map();

export function getCachedToken(key) {
  const hit = tokenCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    tokenCache.delete(key);
    return null;
  }
  return hit.token;
}

export function setCachedToken(key, token, expiresInSeconds) {
  // Refresh a minute early so a token never expires mid-request.
  const ttlMs = Math.max(0, (Number(expiresInSeconds) || 3600) - 60) * 1000;
  tokenCache.set(key, { token, expiresAt: Date.now() + ttlMs });
}

export function clearTokenCache() {
  tokenCache.clear();
}
