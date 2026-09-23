/**
 * github — organization membership.
 *
 * This adapter answers a narrower question than the others: not "does this
 * person still exist?" but "are they still in the org?". That is the right
 * question for GitHub sign-in, because `SsoConfig.allowedOrgs` already makes
 * org membership the condition for signing in at all.
 *
 * Two consequences worth knowing:
 *
 *   - GitHub does not expose members' email addresses to this endpoint, so
 *     these entries carry no email and matching is by id alone. That is fine:
 *     the GitHub `sub` IS the numeric user id, so every existing identity was
 *     backfilled with a usable `externalId`.
 *   - Membership is binary. There is no "disabled" state to report, so this
 *     adapter never produces a `disabled` finding, only a `missing` one.
 */

import { fetchJson, assertPageBudget } from '../http.js';
import { DirectoryConfigError } from '../errors.js';

export const type = 'github';
export const label = 'GitHub organization';
export const secretFields = ['token'];
export const reportsDisabled = false;

const API = 'https://api.github.com';
const ORG_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export function validateConfig(config = {}) {
  const org = String(config.org || '').trim();
  if (!org) throw new DirectoryConfigError('A GitHub organization is required');
  if (!ORG_RE.test(org)) throw new DirectoryConfigError('That is not a valid GitHub organization name');
  if (!config.token) throw new DirectoryConfigError('A token with the read:org scope is required');
  return { org, token: String(config.token) };
}

const headersFor = (cfg) => ({
  Authorization: `Bearer ${cfg.token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'shellius-directory-sync',
});

export async function listUsers(rawConfig) {
  const cfg = validateConfig(rawConfig);
  const headers = headersFor(cfg);
  const entries = [];
  let pageNo = 1;
  for (;;) {
    assertPageBudget(pageNo - 1, 'GitHub');
    const rows = await fetchJson(`${API}/orgs/${encodeURIComponent(cfg.org)}/members?per_page=100&page=${pageNo}`, {
      headers,
      label: 'GitHub',
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const u of rows) {
      if (!u.id) continue;
      entries.push({ externalId: String(u.id), email: null, enabled: true });
    }
    if (rows.length < 100) break;
    pageNo += 1;
  }
  return entries;
}

export async function test(rawConfig) {
  const cfg = validateConfig(rawConfig);
  const rows = await fetchJson(`${API}/orgs/${encodeURIComponent(cfg.org)}/members?per_page=1`, {
    headers: headersFor(cfg),
    label: 'GitHub',
  });
  return { ok: true, detail: `Membership of ${cfg.org} is readable (${Array.isArray(rows) ? rows.length : 0} sample member)` };
}

export default { type, label, secretFields, reportsDisabled, validateConfig, listUsers, test };
