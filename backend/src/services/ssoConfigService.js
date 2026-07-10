import dns from 'dns';
import net from 'net';
import { promisify } from 'util';
import prisma from '../config/db.js';
import runtimeConfig from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import { encrypt } from '../utils/crypto.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Per-preset env-var defaults (Task 16B)
// ---------------------------------------------------------------------------

const ENV_DEFAULTS = {
  google: {
    clientId: process.env.SSO_GOOGLE_CLIENT_ID,
    clientSecret: process.env.SSO_GOOGLE_CLIENT_SECRET,
    issuerUrl: 'https://accounts.google.com',
  },
  entra: {
    tenantId: process.env.SSO_ENTRA_TENANT_ID,
    clientId: process.env.SSO_ENTRA_CLIENT_ID,
    clientSecret: process.env.SSO_ENTRA_CLIENT_SECRET,
  },
  okta: {
    oktaDomain: process.env.SSO_OKTA_DOMAIN,
    clientId: process.env.SSO_OKTA_CLIENT_ID,
    clientSecret: process.env.SSO_OKTA_CLIENT_SECRET,
  },
  auth0: {
    auth0Domain: process.env.SSO_AUTH0_DOMAIN,
    clientId: process.env.SSO_AUTH0_CLIENT_ID,
    clientSecret: process.env.SSO_AUTH0_CLIENT_SECRET,
  },
  'generic-oidc': {
    issuerUrl: process.env.SSO_ISSUER_URL,
    clientId: process.env.SSO_CLIENT_ID,
    clientSecret: process.env.SSO_CLIENT_SECRET,
  },
};

/**
 * Return the DB row merged with env-var defaults for the org's SSO preset.
 * DB values win over env vars. Secret values are never returned; only a
 * boolean `hasClientSecret` is included.
 *
 * @param {string} orgId
 * @returns {Promise<{row: object|null, envDefaults: object, source: object}>}
 */
/** Detect which preset has env credentials configured (clientId + secret). */
function detectEnvPreset() {
  for (const [id, d] of Object.entries(ENV_DEFAULTS)) {
    if (d.clientId && d.clientSecret) return id;
  }
  return null;
}

export async function getEffective(orgId) {
  const row = await prisma.ssoConfig.findUnique({ where: { orgId } });
  // When no row exists, fall back to whichever preset is configured via env so
  // the Settings UI can prefill it.
  const presetId = row?.presetId || detectEnvPreset();
  const envDefaults = presetId ? (ENV_DEFAULTS[presetId] || {}) : {};

  // Build a source map per logical field. NEVER leak env-var secret values —
  // only track provenance as 'db' | 'env' | null.
  const source = {};
  const fields = ['clientId', 'clientSecret', 'issuerUrl', 'tenantId', 'oktaDomain', 'auth0Domain'];
  for (const f of fields) {
    if (row && row[f]) source[f] = 'db';
    else if (envDefaults[f]) source[f] = 'env';
    else source[f] = null;
  }

  return {
    row: row ? maskRow(row) : null,
    envDefaults: {
      presetId,
      clientId: envDefaults.clientId || null,
      issuerUrl: envDefaults.issuerUrl || null,
      tenantId: envDefaults.tenantId || null,
      oktaDomain: envDefaults.oktaDomain || null,
      auth0Domain: envDefaults.auth0Domain || null,
      // NEVER include clientSecret in the response
      hasClientSecret: !!envDefaults.clientSecret,
    },
    source,
  };
}

const dnsLookup = promisify(dns.lookup);

// ---------------------------------------------------------------------------
// SSRF guard helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the IP address belongs to a private / loopback / link-local
 * range that should never be reachable from public SSO issuers.
 *
 * Checked ranges:
 *   IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *         127.0.0.0/8, 169.254.0.0/16
 *   IPv6: fc00::/7, ::1
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 127) return true;                         // 127.0.0.0/8
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16
    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true;              // loopback
    // fc00::/7 covers fc00:: through fdff::
    if (/^f[cd]/.test(normalized)) return true;
    return false;
  }

  return false;
}

/**
 * Resolve the hostname of a URL and throw if it points to a private range.
 *
 * @param {string} rawUrl
 * @returns {Promise<void>}
 */
// Exported so other modules (e.g. routes/sso.js discover()) can reuse the
// same SSRF defense.
export async function guardSsrf(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'Invalid URL');
  }

  const { hostname } = parsed;

  // Reject bare IP literals that are private without a DNS round-trip
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new ApiError(400, 'SSRF guard: private IP addresses are not allowed');
    }
    return;
  }

  let resolvedIp;
  try {
    const result = await dnsLookup(hostname);
    resolvedIp = result.address;
  } catch {
    throw new ApiError(400, `SSRF guard: could not resolve hostname '${hostname}'`);
  }

  if (isPrivateIp(resolvedIp)) {
    throw new ApiError(400, 'SSRF guard: hostname resolves to a private IP address');
  }
}

// ---------------------------------------------------------------------------
// Mask helper — never expose the raw encrypted secret
// ---------------------------------------------------------------------------

function maskRow(row) {
  if (!row) return null;
  const { clientSecretEncrypted, ...rest } = row;
  return { ...rest, hasSecret: !!clientSecretEncrypted };
}

// ---------------------------------------------------------------------------
// Public service functions
// ---------------------------------------------------------------------------

/**
 * Get the SSO config for the org (masked — no secret).
 *
 * @param {string} orgId
 * @returns {Promise<object|null>}
 */
export async function get(orgId) {
  const row = await prisma.ssoConfig.findUnique({ where: { orgId } });
  return maskRow(row);
}

/**
 * Upsert the SSO config for the org.
 * If `clientSecret` is present in data, encrypt and store it.
 * If absent, leave any existing encrypted secret untouched.
 *
 * @param {string} orgId
 * @param {object} data
 * @param {string}  data.provider
 * @param {string}  data.clientId
 * @param {string}  [data.clientSecret]
 * @param {string}  data.issuerUrl
 * @param {string}  [data.redirectUri]
 * @param {string}  [data.scopes]
 * @param {boolean} [data.isActive]
 * @returns {Promise<object>} masked row
 */
// APP_URL override takes precedence; otherwise falls back to the centrally
// derived publicBaseUrl (which itself honors FRONTEND_URL → PUBLIC_BASE_URL
// → TRAEFIK_HOST in that order).
const DEFAULT_APP_URL = process.env.APP_URL || runtimeConfig.publicBaseUrl;
const DEFAULT_REDIRECT_URI = `${DEFAULT_APP_URL.replace(/\/$/, '')}/api/auth/sso/callback`;

export async function upsert(orgId, data) {
  const {
    provider, presetId, clientId, clientSecret, issuerUrl, redirectUri, scopes, isActive,
    defaultRole, defaultGroupId, autoProvision,
  } = data;

  const existing = await prisma.ssoConfig.findUnique({ where: { orgId } });

  // Compute effective redirectUri — use supplied value, fall back to env-derived default
  const effectiveRedirectUri = redirectUri || DEFAULT_REDIRECT_URI;

  // The preset's env secret (if any) lets a row be saved without re-entering it.
  const envHasSecret = presetId ? !!(ENV_DEFAULTS[presetId] || {}).clientSecret : false;

  const baseData = {
    provider,
    clientId,
    issuerUrl,
    redirectUri: effectiveRedirectUri,
    ...(presetId !== undefined && { presetId }),
    ...(scopes !== undefined && { scopes }),
    ...(isActive !== undefined && { isActive }),
    ...(defaultRole !== undefined && { defaultRole }),
    ...(defaultGroupId !== undefined && { defaultGroupId: defaultGroupId || null }),
    ...(autoProvision !== undefined && { autoProvision }),
  };

  if (clientSecret) {
    baseData.clientSecretEncrypted = encrypt(clientSecret);
  } else if (!existing && !envHasSecret) {
    // New config with no stored secret and none available from env.
    throw new ApiError(400, 'clientSecret is required when creating a new SSO configuration');
  }

  let result;
  if (existing) {
    result = await prisma.ssoConfig.update({ where: { orgId }, data: baseData });
  } else {
    result = await prisma.ssoConfig.create({ data: { orgId, ...baseData } });
  }

  logger.info('ssoConfigService.upsert: SSO config updated', { orgId, provider });
  return maskRow(result);
}

/**
 * Test OIDC connectivity by fetching the well-known discovery document.
 * Applies SSRF guard before making any outbound request.
 *
 * @param {string} orgId
 * @param {object} body  - { provider?, issuerUrl? }; falls back to saved config
 * @returns {Promise<{ ok: boolean, providerName: string, scopesSupported: string[], authorizationEndpoint: string }>}
 */
export async function test(orgId, body) {
  let { issuerUrl, provider } = body || {};

  // Fall back to saved config if caller didn't supply values
  if (!issuerUrl) {
    const saved = await prisma.ssoConfig.findUnique({ where: { orgId } });
    if (!saved) throw new ApiError(400, 'No SSO configuration found and no issuerUrl provided');
    issuerUrl = saved.issuerUrl;
    provider = provider || saved.provider;
  }

  provider = provider || 'oidc';

  // Only OIDC discovery is implemented; SAML would need a different approach
  if (provider !== 'oidc') {
    throw new ApiError(400, `Discovery test is only supported for provider 'oidc' (got '${provider}')`);
  }

  // SSRF guard — rejects private/loopback hosts
  await guardSsrf(issuerUrl);

  const discoveryUrl = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  let doc;
  try {
    const res = await fetch(discoveryUrl, { signal: controller.signal });
    if (!res.ok) {
      throw new ApiError(400, `OIDC discovery returned HTTP ${res.status}`);
    }
    doc = await res.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') {
      throw new ApiError(400, 'OIDC discovery timed out (5s)');
    }
    throw new ApiError(400, `OIDC discovery failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  return {
    ok: true,
    providerName: doc.issuer ?? issuerUrl,
    scopesSupported: Array.isArray(doc.scopes_supported) ? doc.scopes_supported : [],
    authorizationEndpoint: doc.authorization_endpoint ?? null,
  };
}
