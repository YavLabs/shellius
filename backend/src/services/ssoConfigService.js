import { guardSsrf, isPrivateIp } from '../utils/ssrf.js';
import prisma from '../config/db.js';
import runtimeConfig from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Per-preset env-var defaults (Task 16B; Revision 2 keeps only the Google
// preset materialised as a virtual provider — the others are now configured
// as ordinary DB-backed SsoConfig rows via the /providers CRUD).
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

/** Detect which preset has env credentials configured (clientId + secret). */
function detectEnvPreset() {
  for (const [id, d] of Object.entries(ENV_DEFAULTS)) {
    if (d.clientId && d.clientSecret) return id;
  }
  return null;
}

export async function getEffective(orgId) {
  const row = await prisma.ssoConfig.findFirst({ where: { orgId }, orderBy: { displayOrder: 'asc' } });
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
      allowedDomains: envAllowedDomains(),
    },
    source,
  };
}

/** SSO_ALLOWED_DOMAINS=acme.com,beta.io — env fallback for allowedDomains
 * when no DB row exists (e.g. the env-only Google preset). */
export function envAllowedDomains() {
  const raw = process.env.SSO_ALLOWED_DOMAINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}


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
// SSRF protection moved to utils/ssrf.js so the audit webhook sink and
// directory sync use the same rules. Re-exported here because routes/sso.js,
// githubOAuth.js and this module's tests already import it from this path.
export { guardSsrf, isPrivateIp };

// ---------------------------------------------------------------------------
// Mask helper — never expose the raw encrypted secret
// ---------------------------------------------------------------------------

function maskRow(row) {
  if (!row) return null;
  const { clientSecretEncrypted, ...rest } = row;
  return { ...rest, hasSecret: !!clientSecretEncrypted };
}

function safeDefaultRole(role) {
  if (!role || role === 'super_admin') return 'member';
  return role;
}

function normalizeDomains(allowedDomains) {
  return (allowedDomains || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
}

function normalizeOrgs(allowedOrgs) {
  return (allowedOrgs || []).map((o) => String(o).trim()).filter(Boolean);
}

function callbackUrlFor(id) {
  return `${runtimeConfig.publicBaseUrl.replace(/\/$/, '')}/api/auth/sso/callback/${id}`;
}

function defaultScopesFor(provider, allowedOrgs) {
  if (provider === 'github') {
    return (allowedOrgs || []).length > 0 ? 'read:user user:email read:org' : 'read:user user:email';
  }
  return 'openid profile email';
}

// ---------------------------------------------------------------------------
// Public service functions (legacy — Revision 1 — single config per org)
// ---------------------------------------------------------------------------

/**
 * Get the SSO config for the org (masked — no secret).
 *
 * @param {string} orgId
 * @returns {Promise<object|null>}
 */
export async function get(orgId) {
  const row = await prisma.ssoConfig.findFirst({ where: { orgId }, orderBy: { displayOrder: 'asc' } });
  return maskRow(row);
}

// APP_URL override takes precedence; otherwise falls back to the centrally
// derived publicBaseUrl (which itself honors FRONTEND_URL → PUBLIC_BASE_URL
// → TRAEFIK_HOST in that order).
const DEFAULT_APP_URL = process.env.APP_URL || runtimeConfig.publicBaseUrl;
const DEFAULT_REDIRECT_URI = `${DEFAULT_APP_URL.replace(/\/$/, '')}/api/auth/sso/callback`;

/**
 * Legacy upsert — operates on the org's first provider (by displayOrder),
 * creating one if none exists. Kept for `PUT /api/auth/sso/config` back-compat.
 */
export async function upsert(orgId, data) {
  const {
    provider, presetId, clientId, clientSecret, issuerUrl, redirectUri, scopes, isActive,
    defaultRole, defaultGroupId, autoProvision, allowedDomains, requireVerifiedEmail,
  } = data;

  const existing = await prisma.ssoConfig.findFirst({ where: { orgId }, orderBy: { displayOrder: 'asc' } });

  // Compute effective redirectUri — use supplied value, fall back to env-derived default
  const effectiveRedirectUri = redirectUri || (existing ? undefined : DEFAULT_REDIRECT_URI);

  // The preset's env secret (if any) lets a row be saved without re-entering it.
  const envHasSecret = presetId ? !!(ENV_DEFAULTS[presetId] || {}).clientSecret : false;

  // Defense in depth — a JIT-provisioned SSO user must never land as
  // super_admin, even if a stale/hand-edited request slips past the route's
  // Joi schema.
  const safeRole =
    defaultRole !== undefined ? safeDefaultRole(defaultRole) : undefined;

  const baseData = {
    provider,
    clientId,
    issuerUrl,
    ...(effectiveRedirectUri !== undefined && { redirectUri: effectiveRedirectUri }),
    ...(presetId !== undefined && { presetId }),
    ...(scopes !== undefined && { scopes }),
    ...(isActive !== undefined && { isActive }),
    ...(safeRole !== undefined && { defaultRole: safeRole }),
    ...(defaultGroupId !== undefined && { defaultGroupId: defaultGroupId || null }),
    ...(autoProvision !== undefined && { autoProvision }),
    ...(allowedDomains !== undefined && { allowedDomains: normalizeDomains(allowedDomains) }),
    ...(requireVerifiedEmail !== undefined && { requireVerifiedEmail }),
  };

  if (clientSecret) {
    baseData.clientSecretEncrypted = encrypt(clientSecret);
  } else if (!existing && !envHasSecret) {
    // New config with no stored secret and none available from env.
    throw new ApiError(400, 'clientSecret is required when creating a new SSO configuration');
  }

  let result;
  if (existing) {
    result = await prisma.ssoConfig.update({ where: { id: existing.id }, data: baseData });
  } else {
    result = await prisma.ssoConfig.create({ data: { orgId, redirectUri: DEFAULT_REDIRECT_URI, ...baseData } });
    result = await prisma.ssoConfig.update({
      where: { id: result.id },
      data: { redirectUri: redirectUri || callbackUrlFor(result.id) },
    });
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
    const saved = await prisma.ssoConfig.findFirst({ where: { orgId }, orderBy: { displayOrder: 'asc' } });
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

// ---------------------------------------------------------------------------
// Revision 2 — multiple SSO providers per org
// ---------------------------------------------------------------------------

/** Build the public SsoProviderDTO for a DB row (never includes the secret). */
export async function toProviderDTO(row) {
  const identities = await prisma.userIdentity.findMany({
    where: { ssoConfigId: row.id },
    select: { userId: true },
    distinct: ['userId'],
  });
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    presetId: row.presetId || null,
    clientId: row.clientId,
    hasClientSecret: !!row.clientSecretEncrypted || (row.presetId ? !!(ENV_DEFAULTS[row.presetId] || {}).clientSecret : false),
    issuerUrl: row.issuerUrl,
    callbackUrl: callbackUrlFor(row.id),
    scopes: row.scopes,
    defaultRole: row.defaultRole,
    defaultGroupId: row.defaultGroupId,
    autoProvision: row.autoProvision,
    allowedDomains: row.allowedDomains || [],
    allowedOrgs: row.allowedOrgs || [],
    requireVerifiedEmail: row.requireVerifiedEmail,
    isActive: row.isActive,
    displayOrder: row.displayOrder,
    userCount: identities.length,
    source: 'db',
  };
}

/** Virtual DTO for the env-var Google preset, shown when no DB row exists
 * for presetId 'google' yet. Materialised into a real DB row on first login. */
export function envGooglePresetDTO(orgId) {
  const preset = ENV_DEFAULTS.google;
  if (!preset.clientId || !preset.clientSecret) return null;
  return {
    id: 'env-google',
    name: 'Google',
    provider: 'oidc',
    presetId: 'google',
    clientId: preset.clientId,
    hasClientSecret: true,
    issuerUrl: preset.issuerUrl,
    callbackUrl: callbackUrlFor('env-google'),
    scopes: 'openid profile email',
    defaultRole: safeDefaultRole(process.env.SSO_DEFAULT_ROLE),
    defaultGroupId: null,
    autoProvision: process.env.SSO_AUTO_PROVISION !== 'false',
    allowedDomains: envAllowedDomains(),
    allowedOrgs: [],
    requireVerifiedEmail: true,
    isActive: true,
    displayOrder: -1,
    userCount: 0,
    source: 'env',
    orgId,
  };
}

/** GET /api/auth/sso/providers — all providers for the org, DB rows first
 * (by displayOrder) plus the virtual env-google preset when applicable. */
export async function listProviders(orgId) {
  const rows = await prisma.ssoConfig.findMany({ where: { orgId }, orderBy: { displayOrder: 'asc' } });
  const dtos = await Promise.all(rows.map((r) => toProviderDTO(r)));
  const hasGoogleDb = rows.some((r) => r.presetId === 'google');
  if (!hasGoogleDb) {
    const envDto = envGooglePresetDTO(orgId);
    if (envDto) dtos.push(envDto);
  }
  return dtos;
}

/** Active providers only, ordered — used by public login-options/public-status. */
export async function listActiveProviders(orgId) {
  const all = await listProviders(orgId);
  return all
    .filter((p) => p.isActive)
    .map((p) => ({ id: p.id, name: p.name, presetId: p.presetId, provider: p.provider }));
}

export async function getProviderRow(orgId, id) {
  const row = await prisma.ssoConfig.findFirst({ where: { id, orgId } });
  if (!row) throw new ApiError(404, 'SSO provider not found');
  return row;
}

export async function createProvider(orgId, data) {
  const {
    name, presetId, clientId, clientSecret, issuerUrl, scopes,
    defaultRole, defaultGroupId, autoProvision, allowedDomains, allowedOrgs,
    requireVerifiedEmail, isActive,
  } = data;

  const provider = presetId === 'github' ? 'github' : 'oidc';

  if (provider === 'oidc' && !issuerUrl) {
    throw new ApiError(400, 'issuerUrl is required for OIDC providers');
  }
  const effectiveIssuerUrl = issuerUrl || (provider === 'github' ? 'https://github.com' : null);
  if (provider === 'oidc') await guardSsrf(effectiveIssuerUrl);
  else if (issuerUrl) await guardSsrf(issuerUrl); // GHE base URL

  const envPreset = presetId ? ENV_DEFAULTS[presetId] : null;
  if (!clientSecret && !(envPreset && envPreset.clientSecret)) {
    throw new ApiError(400, 'clientSecret is required');
  }

  const effAllowedOrgs = provider === 'github' ? normalizeOrgs(allowedOrgs) : [];
  const effScopes = scopes || defaultScopesFor(provider, effAllowedOrgs);
  const safeRole = safeDefaultRole(defaultRole);

  const maxOrder = await prisma.ssoConfig.aggregate({ where: { orgId }, _max: { displayOrder: true } });
  const displayOrder = (maxOrder._max.displayOrder ?? -1) + 1;

  let created = await prisma.ssoConfig.create({
    data: {
      orgId,
      provider,
      presetId: presetId || null,
      name: name || (provider === 'github' ? 'GitHub' : 'Single Sign-On'),
      displayOrder,
      clientId,
      clientSecretEncrypted: clientSecret ? encrypt(clientSecret) : null,
      issuerUrl: effectiveIssuerUrl || '',
      redirectUri: 'pending', // replaced below once we know the row's id
      scopes: effScopes,
      defaultRole: safeRole,
      defaultGroupId: defaultGroupId || null,
      autoProvision: autoProvision !== false,
      allowedDomains: normalizeDomains(allowedDomains),
      requireVerifiedEmail: requireVerifiedEmail !== false,
      allowedOrgs: effAllowedOrgs,
      isActive: isActive !== false,
    },
  });
  created = await prisma.ssoConfig.update({
    where: { id: created.id },
    data: { redirectUri: callbackUrlFor(created.id) },
  });

  logger.info('ssoConfigService.createProvider: SSO provider created', { orgId, provider, presetId });
  return toProviderDTO(created);
}

export async function updateProvider(orgId, id, data) {
  const existing = await getProviderRow(orgId, id);
  const {
    name, presetId, clientId, clientSecret, issuerUrl, scopes,
    defaultRole, defaultGroupId, autoProvision, allowedDomains, allowedOrgs,
    requireVerifiedEmail, isActive,
  } = data;

  const provider = presetId !== undefined ? (presetId === 'github' ? 'github' : 'oidc') : existing.provider;

  if (issuerUrl !== undefined && issuerUrl) await guardSsrf(issuerUrl);
  if (provider === 'oidc') {
    const effIssuer = issuerUrl !== undefined ? issuerUrl : existing.issuerUrl;
    if (!effIssuer) throw new ApiError(400, 'issuerUrl is required for OIDC providers');
  }

  const nextAllowedOrgs = allowedOrgs !== undefined ? normalizeOrgs(allowedOrgs) : existing.allowedOrgs;

  const updateData = {
    ...(name !== undefined && { name }),
    ...(presetId !== undefined && { presetId: presetId || null, provider }),
    ...(clientId !== undefined && { clientId }),
    ...(issuerUrl !== undefined && { issuerUrl }),
    ...(scopes !== undefined && { scopes }),
    ...(defaultRole !== undefined && { defaultRole: safeDefaultRole(defaultRole) }),
    ...(defaultGroupId !== undefined && { defaultGroupId: defaultGroupId || null }),
    ...(autoProvision !== undefined && { autoProvision }),
    ...(allowedDomains !== undefined && { allowedDomains: normalizeDomains(allowedDomains) }),
    ...(allowedOrgs !== undefined && { allowedOrgs: nextAllowedOrgs }),
    ...(requireVerifiedEmail !== undefined && { requireVerifiedEmail }),
    ...(isActive !== undefined && { isActive }),
  };
  // Blank/omitted clientSecret keeps the stored one.
  if (clientSecret) updateData.clientSecretEncrypted = encrypt(clientSecret);

  const result = await prisma.ssoConfig.update({ where: { id: existing.id }, data: updateData });
  logger.info('ssoConfigService.updateProvider: SSO provider updated', { orgId, id });
  return toProviderDTO(result);
}

/**
 * DELETE — cascades the provider's UserIdentity rows. Refused (409
 * LAST_SIGN_IN_METHOD) if any linked user would be left with no password
 * and no other identity, unless `force`.
 */
export async function deleteProvider(orgId, id, { force = false } = {}) {
  const existing = await getProviderRow(orgId, id);

  if (!force) {
    const identities = await prisma.userIdentity.findMany({
      where: { ssoConfigId: id },
      select: { userId: true },
    });
    const userIds = [...new Set(identities.map((i) => i.userId))];
    for (const userId of userIds) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
      if (user && !user.passwordHash) {
        const otherIdentities = await prisma.userIdentity.count({
          where: { userId, ssoConfigId: { not: id } },
        });
        if (otherIdentities === 0) {
          throw new ApiError(
            409,
            'Deleting this provider would leave at least one user with no way to sign in',
            { code: 'LAST_SIGN_IN_METHOD' }
          );
        }
      }
    }
  }

  await prisma.ssoConfig.delete({ where: { id: existing.id } }); // cascades UserIdentity
  logger.info('ssoConfigService.deleteProvider: SSO provider deleted', { orgId, id, force });
  return { deleted: true };
}

export async function reorderProviders(orgId, ids) {
  const rows = await prisma.ssoConfig.findMany({ where: { orgId, id: { in: ids } }, select: { id: true } });
  if (rows.length !== ids.length) throw new ApiError(400, 'One or more provider ids do not belong to this org');

  await prisma.$transaction(
    ids.map((id, index) => prisma.ssoConfig.update({ where: { id }, data: { displayOrder: index } }))
  );
  return listProviders(orgId);
}

/**
 * Test connectivity for a saved provider, or an unsaved draft (no id — the
 * full config is supplied in `data`, secret optional if the row already
 * has one stored… but a draft has no row, so clientSecret is only needed
 * when the test actually needs to authenticate, which discovery does not).
 */
export async function testProvider(orgId, { id, data } = {}) {
  let row;
  if (id) {
    row = await getProviderRow(orgId, id);
  } else {
    row = {
      provider: data?.presetId === 'github' ? 'github' : 'oidc',
      issuerUrl: data?.issuerUrl || (data?.presetId === 'github' ? 'https://github.com' : null),
    };
  }

  if (row.provider === 'github') {
    const base = (row.issuerUrl || 'https://github.com').replace(/\/$/, '');
    await guardSsrf(base);
    const apiBase = base === 'https://github.com' ? 'https://api.github.com' : `${base}/api/v3`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${apiBase}/zen`, { signal: controller.signal });
      if (!res.ok && res.status !== 404) throw new ApiError(400, `GitHub API returned HTTP ${res.status}`);
      return { ok: true, message: 'GitHub API reachable', details: { apiBase } };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(400, `GitHub connectivity test failed: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!row.issuerUrl) throw new ApiError(400, 'issuerUrl is required to test an OIDC provider');
  const discoveryResult = await test(orgId, { provider: 'oidc', issuerUrl: row.issuerUrl });
  return {
    ok: discoveryResult.ok,
    message: `OIDC discovery succeeded (${discoveryResult.providerName})`,
    details: {
      authorizationEndpoint: discoveryResult.authorizationEndpoint,
      scopesSupported: discoveryResult.scopesSupported,
    },
  };
}

// ---------------------------------------------------------------------------
// Decryption — used by ssoService when logging a user in
// ---------------------------------------------------------------------------

/** Decrypt a DB row's secret, falling back to the preset's env secret. */
export function decryptProviderSecret(row) {
  if (row.clientSecretEncrypted) return decrypt(row.clientSecretEncrypted);
  const envPreset = row.presetId ? ENV_DEFAULTS[row.presetId] : null;
  return envPreset?.clientSecret || null;
}

export { ENV_DEFAULTS, callbackUrlFor, safeDefaultRole };

