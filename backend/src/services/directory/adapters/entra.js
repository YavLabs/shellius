/**
 * entra — Microsoft Entra ID (formerly Azure AD) via Microsoft Graph.
 *
 * Credential: an app registration with the APPLICATION permission
 * `User.Read.All` (admin-consented). Delegated permission is not enough —
 * there is no signed-in user during a background reconcile.
 *
 * The identifier trap, restated because it is the whole reason this feature
 * has an `externalId` column: the `sub` claim Entra puts in an ID token is
 * PAIRWISE — derived per application — so it appears nowhere in Graph. The
 * value that matches `/users/{id}` is the `oid` claim. An adapter that
 * compared Graph ids against stored `sub` values would match nothing at all,
 * and a deprovisioning job reads "matched nothing" as "everyone has left".
 */

import { fetchJson, assertPageBudget } from '../http.js';
import { DirectoryConfigError } from '../errors.js';

export const type = 'entra';
export const label = 'Microsoft Entra ID';
export const secretFields = ['clientSecret'];
/** Entra tells us whether an account is disabled, not only whether it exists. */
export const reportsDisabled = true;

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TENANT_RE = /^[a-fA-F0-9-]{36}$|^[a-zA-Z0-9.-]+$/;

export function validateConfig(config = {}) {
  const tenantId = String(config.tenantId || '').trim();
  const clientId = String(config.clientId || '').trim();
  if (!tenantId) throw new DirectoryConfigError('A tenant ID is required');
  if (!TENANT_RE.test(tenantId)) throw new DirectoryConfigError('That is not a valid Entra tenant ID');
  if (!clientId) throw new DirectoryConfigError('A client ID is required');
  if (!config.clientSecret) throw new DirectoryConfigError('A client secret is required');
  return { tenantId, clientId, clientSecret: String(config.clientSecret) };
}

async function accessToken(cfg) {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const json = await fetchJson(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    label: 'Entra token endpoint',
  });
  if (!json.access_token) throw new DirectoryConfigError('Entra did not return an access token');
  return json.access_token;
}

/**
 * @returns {Promise<Array<{externalId: string, email: string|null, enabled: boolean}>>}
 */
export async function listUsers(rawConfig) {
  const cfg = validateConfig(rawConfig);
  const token = await accessToken(cfg);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  const entries = [];
  let url = `${GRAPH}/users?$select=id,userPrincipalName,mail,accountEnabled&$top=999`;
  let pages = 0;
  while (url) {
    assertPageBudget(pages, 'Microsoft Graph');
    const json = await fetchJson(url, { headers, label: 'Microsoft Graph' });
    for (const u of json.value || []) {
      if (!u.id) continue;
      entries.push({
        externalId: String(u.id),
        email: (u.mail || u.userPrincipalName || '').toLowerCase() || null,
        // Graph omits accountEnabled rather than sending false in some
        // tenants; absent means "not told", which we read as enabled.
        enabled: u.accountEnabled !== false,
      });
    }
    url = json['@odata.nextLink'] || null;
    pages += 1;
  }
  return entries;
}

/** Prove the credential works before anything is allowed to act on its answers. */
export async function test(rawConfig) {
  const cfg = validateConfig(rawConfig);
  const token = await accessToken(cfg);
  const json = await fetchJson(`${GRAPH}/users?$select=id&$top=1`, {
    headers: { Authorization: `Bearer ${token}` },
    label: 'Microsoft Graph',
  });
  return { ok: true, detail: `Graph responded; ${(json.value || []).length ? 'users are readable' : 'no users returned'}` };
}

export default { type, label, secretFields, reportsDisabled, validateConfig, listUsers, test };
