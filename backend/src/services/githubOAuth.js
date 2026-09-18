/**
 * githubOAuth.js — GitHub OAuth 2.0 login (not OIDC).
 *
 * Fixed endpoints for github.com; GitHub Enterprise Server (GHE) support via
 * `issuerUrl` = the GHE base URL (e.g. `https://ghe.example.com`), whose API
 * lives under `/api/v3` instead of `api.github.com`. The GHE base is subject
 * to the same SSRF guard as OIDC issuers.
 *
 * Flow (state + PKCE S256, mirroring the OIDC path):
 *   1. buildAuthorizeUrl() — GET https://github.com/login/oauth/authorize
 *   2. exchangeCode()      — POST https://github.com/login/oauth/access_token
 *   3. fetchUser()          — GET /user
 *   4. fetchPrimaryVerifiedEmail() — GET /user/emails (primary && verified)
 *   5. checkOrgMembership() — GET /user/memberships/orgs/{org} (state === 'active')
 */

import ApiError from '../utils/ApiError.js';
import { guardSsrf } from './ssoConfigService.js';
import logger from '../utils/logger.js';

const DEFAULT_BASE = 'https://github.com';
const FETCH_TIMEOUT_MS = 8000;

/** Resolve authorize/token/api endpoints for github.com or a GHE instance. */
export function resolveEndpoints(issuerUrl) {
  const base = (issuerUrl || DEFAULT_BASE).replace(/\/$/, '');
  const isDotCom = base === DEFAULT_BASE;
  return {
    base,
    authorizeUrl: `${base}/login/oauth/authorize`,
    tokenUrl: `${base}/login/oauth/access_token`,
    apiBase: isDotCom ? 'https://api.github.com' : `${base}/api/v3`,
  };
}

async function boundedFetch(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Default scopes: read:user user:email (+ read:org when allowedOrgs is non-empty). */
export function defaultScopes(allowedOrgs = []) {
  return allowedOrgs.length > 0 ? 'read:user user:email read:org' : 'read:user user:email';
}

export function buildAuthorizeUrl({ issuerUrl, clientId, redirectUri, scopes, state, codeChallenge }) {
  const { authorizeUrl } = resolveEndpoints(issuerUrl);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    allow_signup: 'true',
  });
  return `${authorizeUrl}?${params.toString()}`;
}

export async function exchangeCode({ issuerUrl, clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const { tokenUrl, base } = resolveEndpoints(issuerUrl);
  await guardSsrf(base);

  let res;
  try {
    res = await boundedFetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
  } catch (err) {
    logger.error('githubOAuth.exchangeCode: request failed', { error: err.message });
    throw new ApiError(502, 'GitHub token exchange failed');
  }
  if (!res.ok) {
    throw new ApiError(502, `GitHub token exchange returned HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.error || !body.access_token) {
    logger.warn('githubOAuth.exchangeCode: error response', { error: body.error });
    throw new ApiError(502, body.error_description || 'GitHub token exchange failed');
  }
  return body; // { access_token, scope, token_type }
}

async function apiGet(issuerUrl, accessToken, path) {
  const { apiBase, base } = resolveEndpoints(issuerUrl);
  await guardSsrf(base);
  const res = await boundedFetch(`${apiBase}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'shellius',
    },
  });
  return res;
}

/** GET /user — subject = String(id), name = name || login, picture = avatar_url. */
export async function fetchUser(issuerUrl, accessToken) {
  const res = await apiGet(issuerUrl, accessToken, '/user');
  if (!res.ok) throw new ApiError(502, `GitHub /user returned HTTP ${res.status}`);
  const user = await res.json();
  return {
    subject: String(user.id),
    login: user.login,
    name: user.name || user.login,
    picture: user.avatar_url || null,
  };
}

/** GET /user/emails — raw list of { email, primary, verified }. */
export async function fetchEmails(issuerUrl, accessToken) {
  const res = await apiGet(issuerUrl, accessToken, '/user/emails');
  if (!res.ok) throw new ApiError(502, `GitHub /user/emails returned HTTP ${res.status}`);
  const emails = await res.json();
  return Array.isArray(emails) ? emails : [];
}

/** The primary && verified email, or null. */
export async function fetchPrimaryVerifiedEmail(issuerUrl, accessToken) {
  const emails = await fetchEmails(issuerUrl, accessToken);
  const primary = emails.find((e) => e.primary && e.verified);
  return primary ? { email: primary.email.toLowerCase(), verified: true } : null;
}

/** GET /user/memberships/orgs/{org} — true when state === 'active' (requires read:org). */
export async function isActiveOrgMember(issuerUrl, accessToken, org) {
  const res = await apiGet(issuerUrl, accessToken, `/user/memberships/orgs/${encodeURIComponent(org)}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new ApiError(502, `GitHub org membership check returned HTTP ${res.status}`);
  const body = await res.json();
  return body.state === 'active';
}

export default {
  resolveEndpoints,
  defaultScopes,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUser,
  fetchEmails,
  fetchPrimaryVerifiedEmail,
  isActiveOrgMember,
};
