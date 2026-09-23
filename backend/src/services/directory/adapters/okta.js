/**
 * okta — the Okta Users API.
 *
 * Credential: an API token (SSWS) belonging to a read-only admin.
 *
 * Okta's identifier is easier than Entra's but not free: on an ORG
 * authorization server the `sub` claim is the user id (`00u…`), which is what
 * `/api/v1/users` returns, but on a CUSTOM authorization server `sub` defaults
 * to the user's login. `externalIdFor` therefore only records an Okta subject
 * when it has the user-id shape, and anything else stays unknown rather than
 * being guessed at.
 *
 * We list all users including deactivated ones and report their status, so
 * "deactivated in Okta" is caught as well as "deleted from Okta".
 */

import { fetchJson, assertPageBudget } from '../http.js';
import { DirectoryConfigError, DirectoryFetchError } from '../errors.js';

export const type = 'okta';
export const label = 'Okta';
export const secretFields = ['apiToken'];
export const reportsDisabled = true;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
/** Okta statuses that mean this person no longer has access. */
const INACTIVE = new Set(['DEPROVISIONED', 'SUSPENDED']);

export function validateConfig(config = {}) {
  let domain = String(config.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!domain) throw new DirectoryConfigError('An Okta domain is required');
  if (!DOMAIN_RE.test(domain)) throw new DirectoryConfigError('That is not a valid Okta domain, e.g. acme.okta.com');
  if (!config.apiToken) throw new DirectoryConfigError('An API token is required');
  return { domain, apiToken: String(config.apiToken) };
}

/** Okta pages with RFC 5988 Link headers, not a token in the body. */
function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

async function page(url, cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `SSWS ${cfg.apiToken}`, Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await res.text();
    if (!res.ok) {
      throw new DirectoryFetchError(`Okta returned ${res.status}${text ? ` — ${text.slice(0, 300)}` : ''}`, { status: res.status });
    }
    return { rows: JSON.parse(text || '[]'), next: nextLink(res.headers.get('link')) };
  } catch (err) {
    if (err.name === 'AbortError') throw new DirectoryFetchError('Okta did not respond within 20s');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function listUsers(rawConfig) {
  const cfg = validateConfig(rawConfig);
  const entries = [];
  let url = `https://${cfg.domain}/api/v1/users?limit=200`;
  let pages = 0;
  while (url) {
    assertPageBudget(pages, 'Okta');
    const { rows, next } = await page(url, cfg);
    for (const u of rows) {
      if (!u.id) continue;
      entries.push({
        externalId: String(u.id),
        email: String(u.profile?.email || u.profile?.login || '').toLowerCase() || null,
        enabled: !INACTIVE.has(String(u.status || '').toUpperCase()),
      });
    }
    url = next;
    pages += 1;
  }
  return entries;
}

export async function test(rawConfig) {
  const cfg = validateConfig(rawConfig);
  const json = await fetchJson(`https://${cfg.domain}/api/v1/users?limit=1`, {
    headers: { Authorization: `SSWS ${cfg.apiToken}`, Accept: 'application/json' },
    label: 'Okta',
  });
  return { ok: true, detail: `Okta responded with ${Array.isArray(json) ? json.length : 0} sample user(s)` };
}

export default { type, label, secretFields, reportsDisabled, validateConfig, listUsers, test };
