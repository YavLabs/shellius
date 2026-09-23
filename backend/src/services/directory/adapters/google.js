/**
 * google — Google Workspace via the Admin SDK Directory API.
 *
 * Credential: a service account with domain-wide delegation, authorised for
 * the `admin.directory.user.readonly` scope, impersonating an admin. The
 * impersonation is not optional — the Directory API answers for a user, not
 * for a service account, so a configuration without `adminEmail` fails with a
 * confusing 400 rather than an obvious one. We check for it up front.
 *
 * The identifier is easy here: the OIDC `sub` a Google sign-in produces IS the
 * directory `users.id`, so existing identities could be backfilled.
 *
 * The JWT is signed with Node's crypto, so this adds no dependency on
 * googleapis — which is a large tree for one list call.
 */

import crypto from 'crypto';
import { fetchJson, assertPageBudget } from '../http.js';
import { DirectoryConfigError } from '../errors.js';

export const type = 'google';
export const label = 'Google Workspace';
export const secretFields = ['privateKey'];
export const reportsDisabled = true;

const SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1/users';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function validateConfig(config = {}) {
  const clientEmail = String(config.clientEmail || '').trim();
  const adminEmail = String(config.adminEmail || '').trim();
  const privateKey = String(config.privateKey || '').replace(/\\n/g, '\n');
  if (!clientEmail.includes('@')) throw new DirectoryConfigError('A service account client email is required');
  if (!adminEmail.includes('@')) {
    throw new DirectoryConfigError('An admin email to impersonate is required — the Directory API answers for a user, not a service account');
  }
  if (!privateKey.includes('BEGIN')) throw new DirectoryConfigError('A service account private key (PEM) is required');
  return {
    clientEmail,
    adminEmail,
    privateKey,
    customer: String(config.customer || 'my_customer').trim() || 'my_customer',
  };
}

async function accessToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: cfg.clientEmail,
    sub: cfg.adminEmail, // domain-wide delegation: act as this admin
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  let signature;
  try {
    signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), cfg.privateKey);
  } catch (err) {
    throw new DirectoryConfigError(`The service account private key could not be used to sign: ${err.message}`);
  }

  const json = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${b64url(signature)}`,
    }).toString(),
    label: 'Google token endpoint',
  });
  if (!json.access_token) {
    throw new DirectoryConfigError('Google did not return an access token — check that domain-wide delegation is authorised for this scope');
  }
  return json.access_token;
}

export async function listUsers(rawConfig) {
  const cfg = validateConfig(rawConfig);
  const token = await accessToken(cfg);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  const entries = [];
  let pageToken = null;
  let pages = 0;
  do {
    assertPageBudget(pages, 'Google Directory');
    const params = new URLSearchParams({
      customer: cfg.customer,
      maxResults: '500',
      projection: 'basic',
      // Without this, suspended users are omitted entirely and we could not
      // tell "suspended in Google" apart from "deleted from Google".
      showDeleted: 'false',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const json = await fetchJson(`${DIRECTORY}?${params.toString()}`, { headers, label: 'Google Directory' });
    for (const u of json.users || []) {
      if (!u.id) continue;
      entries.push({
        externalId: String(u.id),
        email: String(u.primaryEmail || '').toLowerCase() || null,
        enabled: u.suspended !== true && u.archived !== true,
      });
    }
    pageToken = json.nextPageToken || null;
    pages += 1;
  } while (pageToken);
  return entries;
}

export async function test(rawConfig) {
  const cfg = validateConfig(rawConfig);
  const token = await accessToken(cfg);
  const json = await fetchJson(`${DIRECTORY}?customer=${encodeURIComponent(cfg.customer)}&maxResults=1&projection=basic`, {
    headers: { Authorization: `Bearer ${token}` },
    label: 'Google Directory',
  });
  return { ok: true, detail: `Directory responded as ${cfg.adminEmail}; ${(json.users || []).length} sample user(s)` };
}

export default { type, label, secretFields, reportsDisabled, validateConfig, listUsers, test };
