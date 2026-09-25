import express from 'express';
import crypto from 'crypto';
import Joi from 'joi';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import prisma from '../config/db.js';
import config from '../config/index.js';
import * as ssoService from '../services/ssoService.js';
import * as ssoConfigService from '../services/ssoConfigService.js';
import * as githubOAuth from '../services/githubOAuth.js';
import * as authService from '../services/authService.js';
import * as ssoLinkService from '../services/ssoLinkService.js';
import * as samlService from '../services/samlService.js';
import { log as auditLog, ACTIONS } from '../services/auditService.js';
import logger from '../utils/logger.js';
import redis from '../config/redis.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission } from '../middleware/rbac.js';
import { authLimiter, tokenActionLimiter, userRateLimiter } from '../middleware/rateLimiter.js';
import audit from '../middleware/audit.js';
import { assertSsoDefaultRole } from '../services/roleService.js';
import { externalIdFor } from '../services/directory/externalId.js';

const router = express.Router();

const FRONTEND_URL = config.frontendUrl;
const STATE_TTL_SEC = 10 * 60;
const SSO_CODE_TTL_SEC = 60;
const SSO_STATE_COOKIE = 'shellius_sso_state';

// SSO state in Redis so it survives backend restarts and works across replicas
// (the in-memory Map lost state on every redeploy → "Invalid or expired state").
// Also carries the PKCE code_verifier + (OIDC) nonce + providerId for this attempt.
const stateKey = (s) => `sso:state:${s}`;
async function saveSsoState(state, data) {
  await redis.set(stateKey(state), JSON.stringify(data), 'EX', STATE_TTL_SEC);
}
async function takeSsoState(state) {
  const key = stateKey(state);
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// One-time exchange code (Redis, 60s, single-use) — hands the frontend a
// short opaque value instead of putting tokens directly in the redirect URL.
const exchangeKey = (c) => `sso:exchange:${c}`;
async function saveExchangeCode(code, userId) {
  await redis.set(exchangeKey(code), JSON.stringify({ userId }), 'EX', SSO_CODE_TTL_SEC);
}
async function takeExchangeCode(code) {
  const key = exchangeKey(code);
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return null;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function setStateCookie(res, state) {
  res.cookie(SSO_STATE_COOKIE, state, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    maxAge: STATE_TTL_SEC * 1000,
    path: '/api/auth/sso',
  });
}

function redirectError(res, code) {
  res.clearCookie(SSO_STATE_COOKIE, { path: '/api/auth/sso' });
  // A Profile "connect" round-trip returns to Profile, not the sign-in page.
  if (res.locals?.ssoState?.mode === 'connect') {
    return res.redirect(`${FRONTEND_URL}/profile?${new URLSearchParams({ connect_error: code }).toString()}`);
  }
  return res.redirect(`${FRONTEND_URL}/auth/callback#${new URLSearchParams({ error: code }).toString()}`);
}

// Discovery cache stays in-memory (cheap, non-critical, re-fetched on miss).
const discoveryCache = new Map();

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(new ApiError(400, error.details.map((d) => d.message).join(', ')));
  req.body = value;
  next();
};

// ---------------------------------------------------------------------------
// Joi schemas for SSO config endpoints (legacy, single-row)
// ---------------------------------------------------------------------------

// Tight regexes for the per-preset identifier fields. These run BEFORE the
// derived issuer URL is built, so a malformed value can never be interpolated
// into login.microsoftonline.com/<tenantId>/v2.0 etc. (Phase 16F follow-up.)
const ENTRA_TENANT_RE = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$|^[a-zA-Z0-9.-]+$/;
const DNS_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// NOTE: this legacy single-row endpoint is OIDC-only, and now says so.
// It used to accept `provider: 'saml'` and `presetId: 'saml'`, which was a
// lie in two directions: `ssoConfigService.upsert()` has no SAML branch, and
// until this release nothing in the product could consume a SAML assertion at
// all. A config saved that way was accepted with a 200 and then silently
// unusable. SAML providers are created through POST /providers, which is the
// only path that generates the SP key pair and the ACS URL a SAML row needs.
const ssoConfigSchema = Joi.object({
  provider: Joi.string().valid('oidc').required(),
  presetId: Joi.string().valid('google', 'entra', 'okta', 'auth0', 'generic-oidc').optional(),
  clientId: Joi.string().min(1).max(500).required(),
  clientSecret: Joi.string().min(1).max(2000),
  issuerUrl: Joi.string().uri().required(),
  redirectUri: Joi.string().uri(),
  scopes: Joi.string().max(500),
  isActive: Joi.boolean(),
  // New-user provisioning policy: a role key. Checked against the org's roles
  // (never Super admin, never a role with sensitive permissions) below.
  defaultRole: Joi.string().max(100),
  defaultGroupId: Joi.string().allow(null, ''),
  autoProvision: Joi.boolean(),
  // Email domains allowed to sign in / be provisioned via SSO. Empty = any.
  allowedDomains: Joi.array().items(Joi.string().pattern(DOMAIN_RE)).max(50),
  // Only link an SSO identity to an existing account by email when the IdP
  // asserts email_verified.
  requireVerifiedEmail: Joi.boolean(),
  // Optional per-preset identifiers — accepted only when matching the
  // preset's expected pattern. Server-side defense in depth: even if the
  // frontend skips its own regex check, these can never reach the URL
  // builder with garbage in them.
  tenantId: Joi.string().pattern(ENTRA_TENANT_RE).optional()
    .messages({ 'string.pattern.base': 'tenantId must be a UUID or DNS-friendly name' }),
  oktaDomain: Joi.string().pattern(DNS_HOSTNAME_RE).optional()
    .messages({ 'string.pattern.base': 'oktaDomain must be a valid hostname like acme.okta.com' }),
  auth0Domain: Joi.string().pattern(DNS_HOSTNAME_RE).optional()
    .messages({ 'string.pattern.base': 'auth0Domain must be a valid hostname like acme.auth0.com' }),
});

const ssoTestSchema = Joi.object({
  // Discovery is an OIDC concept. SAML has no equivalent probe — see
  // ssoConfigService.testSamlProvider, reached via POST /providers/:id/test.
  provider: Joi.string().valid('oidc'),
  issuerUrl: Joi.string().uri(),
});

const exchangeSchema = Joi.object({
  code: Joi.string().required(),
});

// Pending-link / connect schemas (docs/auth-hardening.md "Linking SSO accounts")
const linkTokenSchema = Joi.object({
  token: Joi.string().length(64).hex().required(),
});

const confirmLinkSchema = Joi.object({
  token: Joi.string().length(64).hex().required(),
  password: Joi.string().min(1).max(200),
  method: Joi.string().valid('totp', 'email', 'backup'),
  code: Joi.string().min(1).max(64),
})
  .xor('password', 'method')
  .and('method', 'code');

const connectStartSchema = Joi.object({
  providerId: Joi.string().min(1).max(100).required(),
});

// ---------------------------------------------------------------------------
// Joi schemas — Revision 2, multi-provider CRUD
// ---------------------------------------------------------------------------

const OAUTH_PRESET_IDS = ['google', 'entra', 'okta', 'auth0', 'generic', 'github'];
const SAML_PRESET_IDS = ['saml', 'saml-entra', 'saml-okta', 'saml-adfs'];
const PRESET_IDS = [...OAUTH_PRESET_IDS, ...SAML_PRESET_IDS];
const isSaml = Joi.string().valid(...SAML_PRESET_IDS);

// Attribute-mapping keys are fixed (config/samlAttributes.js). An open object
// here would let an admin write arbitrary JSON into a column the mapper then
// iterates.
const samlAttributeMappingSchema = Joi.object({
  email: Joi.string().max(300).allow(''),
  name: Joi.string().max(300).allow(''),
  firstName: Joi.string().max(300).allow(''),
  lastName: Joi.string().max(300).allow(''),
  groups: Joi.string().max(300).allow(''),
  externalId: Joi.string().max(300).allow(''),
}).allow(null);

// SAML-only fields, shared by create and update. The IdP certificate is a
// pasted PEM (or the bare base64 an IdP console shows); it is validated
// properly in samlService.normalizeIdpCerts, which is what actually parses
// it — this only bounds the size.
const samlFields = {
  samlIdpEntryPoint: Joi.string().uri({ scheme: ['http', 'https'] }).max(2000),
  samlIdpEntityId: Joi.string().min(1).max(1024),
  samlIdpCertificate: Joi.string().max(100000).allow(''),
  samlSpEntityId: Joi.string().max(1024).allow(''),
  samlSignatureAlgorithm: Joi.string().valid('sha1', 'sha256', 'sha512'),
  samlWantAuthnResponseSigned: Joi.boolean(),
  samlAllowIdpInitiated: Joi.boolean(),
  samlClockSkewSec: Joi.number().integer().min(0).max(300),
  samlIdentifierFormat: Joi.string().max(200).allow(''),
  samlForceAuthn: Joi.boolean(),
  samlSignRequests: Joi.boolean(),
  samlAttributeMapping: samlAttributeMappingSchema,
};

const providerCreateSchema = Joi.object({
  name: Joi.string().min(1).max(120).required(),
  presetId: Joi.string().valid(...PRESET_IDS).required(),
  // SAML has no client id / secret / issuer URL / scopes at all; OIDC and
  // GitHub still require a client id, as before.
  clientId: Joi.string().min(1).max(500).when('presetId', {
    is: isSaml,
    then: Joi.forbidden(),
    otherwise: Joi.required(),
  }),
  clientSecret: Joi.string().min(1).max(2000).allow(''),
  issuerUrl: Joi.string().uri(),
  scopes: Joi.string().max(500),
  ...samlFields,
  // A SAML provider is unusable without these three, so they are required at
  // the edge rather than discovered on the first failed sign-in.
  samlIdpEntryPoint: samlFields.samlIdpEntryPoint.when('presetId', { is: isSaml, then: Joi.required() }),
  samlIdpEntityId: samlFields.samlIdpEntityId.when('presetId', { is: isSaml, then: Joi.required() }),
  samlIdpCertificate: Joi.string().min(1).max(100000).when('presetId', {
    is: isSaml,
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  defaultRole: Joi.string().max(100).required(),
  defaultGroupId: Joi.string().allow(null, ''),
  autoProvision: Joi.boolean().required(),
  allowedDomains: Joi.array().items(Joi.string().pattern(DOMAIN_RE)).max(50).required(),
  // GitHub only (org membership gate); other providers don't send it.
  allowedOrgs: Joi.array().items(Joi.string().min(1).max(100)).max(50).default([]),
  requireVerifiedEmail: Joi.boolean().required(),
  isActive: Joi.boolean().required(),
});

// Resolve / vet body.defaultRole against this org's roles.
const checkDefaultRole = asyncHandler(async (req, res, next) => {
  if (req.body.defaultRole !== undefined) {
    req.body.defaultRole = await assertSsoDefaultRole(req.orgId, req.body.defaultRole);
  }
  next();
});

const providerUpdateSchema = Joi.object({
  ...samlFields,
  name: Joi.string().min(1).max(120),
  presetId: Joi.string().valid(...PRESET_IDS),
  clientId: Joi.string().min(1).max(500),
  clientSecret: Joi.string().max(2000).allow(''),
  issuerUrl: Joi.string().uri().allow(''),
  scopes: Joi.string().max(500),
  defaultRole: Joi.string().max(100),
  defaultGroupId: Joi.string().allow(null, ''),
  autoProvision: Joi.boolean(),
  allowedDomains: Joi.array().items(Joi.string().pattern(DOMAIN_RE)).max(50),
  allowedOrgs: Joi.array().items(Joi.string().min(1).max(100)).max(50),
  requireVerifiedEmail: Joi.boolean(),
  isActive: Joi.boolean(),
});

const providerTestDraftSchema = Joi.object({
  presetId: Joi.string().valid(...PRESET_IDS),
  issuerUrl: Joi.string().uri().allow(''),
});

const providerOrderSchema = Joi.object({
  ids: Joi.array().items(Joi.string()).min(1).required(),
});

// ---------------------------------------------------------------------------
// Admin SSO config endpoints (legacy, single-row) — must be registered
// BEFORE /:orgSlug routes
// ---------------------------------------------------------------------------

// GET /api/auth/sso/config
router.get(
  '/config',
  authenticate,
  tenant,
  requirePermission('settings.sso'),
  asyncHandler(async (req, res) => {
    const cfg = await ssoConfigService.get(req.orgId);
    const effective = await ssoConfigService.getEffective(req.orgId);
    res.json({ success: true, data: { config: cfg, effective } });
  })
);

// PUT /api/auth/sso/config
router.put(
  '/config',
  authenticate,
  tenant,
  requirePermission('settings.sso'),
  audit('sso.config.update', 'SsoConfig'),
  validate(ssoConfigSchema),
  checkDefaultRole,
  asyncHandler(async (req, res) => {
    const cfg = await ssoConfigService.upsert(req.orgId, req.body);
    res.json({ success: true, data: { config: cfg } });
  })
);

// POST /api/auth/sso/config/test
router.post(
  '/config/test',
  authenticate,
  tenant,
  requirePermission('settings.sso'),
  audit('sso.config.test', 'SsoConfig'),
  validate(ssoTestSchema),
  asyncHandler(async (req, res) => {
    const result = await ssoConfigService.test(req.orgId, req.body);
    res.json({ success: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// Revision 2 — GET/POST/PATCH/DELETE /api/auth/sso/providers
// ---------------------------------------------------------------------------

router.get(
  '/providers',
  authenticate,
  tenant,
  requirePermission('settings.sso'),
  asyncHandler(async (req, res) => {
    const providers = await ssoConfigService.listProviders(req.orgId);
    res.json({ success: true, data: { providers } });
  })
);

router.post(
  '/providers',
  authenticate,
  tenant,
  requirePermission('settings.sso'),
  audit('sso.provider.create', 'SsoConfig'),
  validate(providerCreateSchema),
  checkDefaultRole,
  asyncHandler(async (req, res) => {
    const provider = await ssoConfigService.createProvider(req.orgId, req.body);
    res.status(201).json({ success: true, data: { provider } });
  })
);

// POST /api/auth/sso/providers/test — unsaved draft test. MUST be registered
// before /providers/:id/test so Express doesn't treat "test" as an :id.
router.post(
  '/providers/test',
  authenticate,
  tenant,
  requirePermission('settings.sso'),
  audit('sso.provider.test', 'SsoConfig'),
  validate(providerTestDraftSchema),
  asyncHandler(async (req, res) => {
    const result = await ssoConfigService.testProvider(req.orgId, { data: req.body });
    res.json({ success: true, data: result });
  })
);

// PUT /api/auth/sso/providers/order
router.put(
  '/providers/order',
  authenticate,
  tenant,
  requirePermission('settings.sso'),
  audit('sso.provider.reorder', 'SsoConfig'),
  validate(providerOrderSchema),
  asyncHandler(async (req, res) => {
    const providers = await ssoConfigService.reorderProviders(req.orgId, req.body.ids);
    res.json({ success: true, data: { providers } });
  })
);

router.post(
  '/providers/:id/test',
  authenticate,
  tenant,
  requirePermission('settings.sso'),
  audit('sso.provider.test', 'SsoConfig'),
  asyncHandler(async (req, res) => {
    const result = await ssoConfigService.testProvider(req.orgId, { id: req.params.id });
    res.json({ success: true, data: result });
  })
);

// POST /api/auth/sso/providers/:id/rotate-sp-key — new SP key pair for a SAML
// provider. The old private key is destroyed, so the admin MUST re-upload the
// SP metadata to their IdP afterwards or signed AuthnRequests will be
// rejected. Audited; the new key is never returned, only its certificate.
router.post(
  '/providers/:id/rotate-sp-key',
  authenticate,
  tenant,
  requirePermission('settings.sso'),
  audit('sso.provider.rotate_sp_key', 'SsoConfig'),
  asyncHandler(async (req, res) => {
    const provider = await ssoConfigService.rotateSamlSpKey(req.orgId, req.params.id);
    res.json({ success: true, data: { provider } });
  })
);

router.patch(
  '/providers/:id',
  authenticate,
  tenant,
  requirePermission('settings.sso'),
  audit('sso.provider.update', 'SsoConfig'),
  validate(providerUpdateSchema),
  checkDefaultRole,
  asyncHandler(async (req, res) => {
    const provider = await ssoConfigService.updateProvider(req.orgId, req.params.id, req.body);
    res.json({ success: true, data: { provider } });
  })
);

router.delete(
  '/providers/:id',
  authenticate,
  tenant,
  requirePermission('settings.sso'),
  audit('sso.provider.delete', 'SsoConfig'),
  asyncHandler(async (req, res) => {
    const force = req.query.force === 'true';
    const result = await ssoConfigService.deleteProvider(req.orgId, req.params.id, { force });
    res.json({ success: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// GET /api/auth/sso/public-status — public; tells the unauth login page
// whether to render an SSO button and which provider(s) are active.
// MUST be registered before /:orgSlug or Express will swallow it.
// ---------------------------------------------------------------------------

async function resolvePublicOrg(req) {
  const hostname = req.hostname || req.get('host') || '';
  if (hostname) {
    const byDomain = await prisma.organization.findFirst({ where: { domain: hostname } });
    if (byDomain) return byDomain;
  }
  return prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
}

router.get(
  '/public-status',
  asyncHandler(async (req, res) => {
    const org = await resolvePublicOrg(req);
    if (!org) {
      return res.json({ success: true, data: { enabled: false, presetId: null, providers: [], orgSlug: null } });
    }
    const summary = await ssoService.getPublicSsoSummary(org.id);
    res.json({ success: true, data: { ...summary, orgSlug: org.slug, orgName: org.name } });
  })
);

// ---------------------------------------------------------------------------
// POST /api/auth/sso/exchange — public; trades a one-time callback code for
// a login-shaped response (so MFA applies uniformly to SSO sign-ins).
// MUST be registered before /:orgSlug (different HTTP method, but kept here
// for readability).
// ---------------------------------------------------------------------------

router.post(
  '/exchange',
  validate(exchangeSchema),
  asyncHandler(async (req, res) => {
    const payload = await takeExchangeCode(req.body.code);
    if (!payload) throw new ApiError(400, 'Invalid or expired code');

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { organization: true },
    });
    if (!user || user.status !== 'active') {
      throw new ApiError(401, 'Account is not available');
    }

    const gate = await authService.mfaGate(user);
    if (gate) {
      return res.json({ success: true, data: gate });
    }

    const session = await authService.issueSession(user, req.ip, req.get('user-agent') || '', 'web');
    res.json({ success: true, data: session });
  })
);

async function discover(issuerUrl) {
  const cached = discoveryCache.get(issuerUrl);
  if (cached && cached.expires > Date.now()) return cached.doc;

  // SSRF guard — same defense as ssoConfigService.test() so a tampered or
  // legacy DB row can't be used to scan internal services.
  await ssoConfigService.guardSsrf(issuerUrl);

  const url = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';

  // Bounded fetch — never let an unresponsive issuer hang an SSO login.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new ApiError(502, 'OIDC discovery failed');
  const doc = await res.json();
  discoveryCache.set(issuerUrl, { doc, expires: Date.now() + 60 * 60 * 1000 });
  return doc;
}

// ---------------------------------------------------------------------------
// OIDC callback — validates state/PKCE/nonce, exchanges the code, verifies
// the ID token (JWKS signature + iss/aud/exp/nonce) via jose, reconciles.
// ---------------------------------------------------------------------------

async function runOidcCallback(req, res, { org, cfg, code, stateData }) {
  let discovery;
  try {
    discovery = await discover(cfg.issuerUrl);
  } catch (err) {
    logger.error('SSO discovery failed during callback', { orgId: org.id, error: err.message });
    return redirectError(res, 'sso_failed');
  }

  try {
    await ssoConfigService.guardSsrf(discovery.token_endpoint);
    await ssoConfigService.guardSsrf(discovery.userinfo_endpoint);
    if (discovery.jwks_uri) await ssoConfigService.guardSsrf(discovery.jwks_uri);
  } catch (err) {
    logger.error('SSO discovered endpoint failed SSRF guard', { orgId: org.id, error: err.message });
    return redirectError(res, 'sso_failed');
  }

  let tokens;
  try {
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code_verifier: stateData.codeVerifier,
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      logger.error('OIDC token exchange failed', { text });
      return redirectError(res, 'sso_failed');
    }
    tokens = await tokenRes.json();
  } catch (err) {
    logger.error('OIDC token exchange request failed', { error: err.message });
    return redirectError(res, 'sso_failed');
  }

  if (!tokens.id_token) {
    logger.error('OIDC token response missing id_token', { orgId: org.id });
    return redirectError(res, 'sso_failed');
  }

  let idClaims;
  try {
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: discovery.issuer,
      audience: cfg.clientId,
    });
    idClaims = payload;
  } catch (err) {
    logger.warn('SSO ID token verification failed', { orgId: org.id, error: err.message });
    return redirectError(res, 'sso_failed');
  }

  if (!stateData.nonce || idClaims.nonce !== stateData.nonce) {
    logger.warn('SSO ID token nonce mismatch', { orgId: org.id });
    return redirectError(res, 'sso_failed');
  }

  let userinfo;
  try {
    const userinfoRes = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userinfoRes.ok) return redirectError(res, 'sso_failed');
    userinfo = await userinfoRes.json();
  } catch (err) {
    logger.warn('SSO userinfo fetch failed', { orgId: org.id, error: err.message });
    return redirectError(res, 'sso_failed');
  }

  const subject = idClaims.sub || userinfo.sub;
  const rawVerified = userinfo.email_verified ?? idClaims.email_verified ?? false;
  const emailVerified = rawVerified === true || rawVerified === 'true';

  return finishSsoCallback(req, res, {
    org,
    cfg,
    subject,
    // The directory id, which for Entra is the `oid` claim and not `sub`.
    externalId: externalIdFor(cfg, { subject, claims: { ...idClaims, ...userinfo } }),
    email: userinfo.email || idClaims.email,
    emailVerified,
    name: userinfo.name || userinfo.preferred_username,
    picture: userinfo.picture,
  });
}

// ---------------------------------------------------------------------------
// GitHub callback — OAuth 2.0 (not OIDC): token exchange, /user, /user/emails
// (primary && verified), allowedOrgs via /user/memberships/orgs/{org}.
// ---------------------------------------------------------------------------

async function runGithubCallback(req, res, { org, cfg, code, stateData }) {
  let tokens;
  try {
    tokens = await githubOAuth.exchangeCode({
      issuerUrl: cfg.issuerUrl,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code,
      redirectUri: cfg.redirectUri,
      codeVerifier: stateData.codeVerifier,
    });
  } catch (err) {
    logger.error('GitHub token exchange failed', { orgId: org.id, error: err.message });
    return redirectError(res, 'sso_failed');
  }

  let ghUser;
  try {
    ghUser = await githubOAuth.fetchUser(cfg.issuerUrl, tokens.access_token);
  } catch (err) {
    logger.warn('GitHub /user fetch failed', { orgId: org.id, error: err.message });
    return redirectError(res, 'sso_failed');
  }

  let email = null;
  let emailVerified = false;
  try {
    const emails = await githubOAuth.fetchEmails(cfg.issuerUrl, tokens.access_token);
    const primary = emails.find((e) => e.primary);
    if (primary && primary.verified) {
      email = primary.email.toLowerCase();
      emailVerified = true;
    } else if (primary && cfg.requireVerifiedEmail === false) {
      email = primary.email.toLowerCase();
      emailVerified = false;
    } else if (cfg.requireVerifiedEmail !== false) {
      return redirectError(res, 'email_not_verified');
    }
  } catch (err) {
    logger.warn('GitHub /user/emails fetch failed', { orgId: org.id, error: err.message });
    return redirectError(res, 'sso_failed');
  }

  if ((cfg.allowedOrgs || []).length > 0) {
    let allowed = false;
    for (const ghOrg of cfg.allowedOrgs) {
      try {
        if (await githubOAuth.isActiveOrgMember(cfg.issuerUrl, tokens.access_token, ghOrg)) {
          allowed = true;
          break;
        }
      } catch (err) {
        logger.warn('GitHub org membership check failed', { orgId: org.id, ghOrg, error: err.message });
      }
    }
    if (!allowed) return redirectError(res, 'org_not_allowed');
  }

  return finishSsoCallback(req, res, {
    org,
    cfg,
    subject: ghUser.subject,
    // GitHub's numeric user id is exactly what /orgs/{org}/members returns.
    externalId: externalIdFor(cfg, { subject: ghUser.subject }),
    email,
    emailVerified,
    name: ghUser.name,
    picture: ghUser.picture,
  });
}

// ---------------------------------------------------------------------------
// Shared tail — reconcile, audit, hand off a one-time exchange code.
// ---------------------------------------------------------------------------

async function finishConnectCallback(req, res, { org, cfg, subject, externalId, email, name, picture }) {
  const stateData = res.locals.ssoState;
  try {
    const result = await ssoLinkService.completeConnect({
      orgId: org.id,
      userId: stateData.userId,
      cfg,
      subject,
      externalId,
      email,
      name,
      picture,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    res.clearCookie(SSO_STATE_COOKIE, { path: '/api/auth/sso' });
    return res.redirect(`${FRONTEND_URL}/profile?${new URLSearchParams({ connected: result.providerName }).toString()}`);
  } catch (err) {
    const errorCode = err.errorCode || 'sso_failed';
    await auditLog({
      orgId: org.id,
      actorId: stateData.userId,
      action: ACTIONS.auth.identity_link_failed,
      resourceType: 'User',
      resourceId: stateData.userId,
      metadata: { reason: errorCode, method: 'connect', provider: cfg.name || cfg.provider, providerId: cfg.id },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    logger.warn('SSO connect rejected', { orgId: org.id, code: errorCode });
    return redirectError(res, errorCode);
  }
}

async function finishSsoCallback(req, res, { org, cfg, subject, externalId, email, emailVerified, name, picture }) {
  if (res.locals.ssoState?.mode === 'connect') {
    return finishConnectCallback(req, res, { org, cfg, subject, externalId, email, name, picture });
  }

  let user;
  try {
    user = await ssoService.reconcileSsoUser({ orgId: org.id, cfg, subject, externalId, email, emailVerified, name, picture });
  } catch (err) {
    const errorCode = err.errorCode || 'sso_failed';
    await auditLog({
      orgId: org.id,
      actorId: null,
      action: ACTIONS.auth.sso_failed,
      resourceType: 'User',
      metadata: { reason: errorCode, provider: cfg.provider, providerId: cfg.id },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    logger.warn('SSO sign-in rejected', { orgId: org.id, error: err.message, code: errorCode });
    return redirectError(res, errorCode);
  }

  // Email matched an account that may not be linked silently — confirm
  // first (password + MFA on /sso/link, or an emailed approval).
  if (user.pendingLink) {
    const pending = await ssoLinkService.createPendingLink(user.pendingLink, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    res.clearCookie(SSO_STATE_COOKIE, { path: '/api/auth/sso' });
    const frag =
      pending.mode === 'password'
        ? { token: pending.token }
        : { status: pending.emailSent ? 'approval_sent' : 'approval_failed', provider: user.pendingLink.providerName };
    return res.redirect(`${FRONTEND_URL}/sso/link#${new URLSearchParams(frag).toString()}`);
  }

  if (user.ssoLinkedVia) {
    await ssoLinkService.recordIdentityLinked({
      user,
      method: user.ssoLinkedVia,
      providerName: cfg.name || cfg.provider,
      providerId: cfg.id,
      identityEmail: email,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || '',
    });
  }

  const oneTimeCode = crypto.randomBytes(32).toString('hex');
  await saveExchangeCode(oneTimeCode, user.id);

  await auditLog({
    orgId: org.id,
    actorId: user.id,
    action: ACTIONS.auth.sso_login,
    resourceType: 'User',
    resourceId: user.id,
    metadata: { provider: cfg.provider, providerId: cfg.id },
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || '',
  });

  res.clearCookie(SSO_STATE_COOKIE, { path: '/api/auth/sso' });
  res.redirect(`${FRONTEND_URL}/auth/callback#${new URLSearchParams({ code: oneTimeCode }).toString()}`);
}

// ---------------------------------------------------------------------------
// Shared dispatcher — resolves org + provider from the stored state, then
// branches to the OIDC or GitHub callback handler.
// ---------------------------------------------------------------------------

async function runSsoCallback(req, res, { code, state, cookieState, orgHint = null }) {
  if (!code || !state) return redirectError(res, 'sso_failed');
  if (!cookieState || cookieState !== state) return redirectError(res, 'state_mismatch');

  const stateData = await takeSsoState(state);
  if (!stateData) return redirectError(res, 'state_mismatch');
  res.locals.ssoState = stateData;
  if (orgHint && orgHint !== stateData.orgId) return redirectError(res, 'state_mismatch');

  const org = await prisma.organization.findUnique({ where: { id: stateData.orgId } });
  if (!org) return redirectError(res, 'sso_failed');

  let row = null;
  if (stateData.providerId) {
    row = await prisma.ssoConfig.findFirst({ where: { id: stateData.providerId, orgId: org.id } });
  }
  if (!row && stateData.mode === 'connect') {
    // Never connect a different provider than the one the user picked.
    return redirectError(res, 'sso_not_configured');
  }
  if (!row) {
    // Very old in-flight state from before multi-provider support, or a
    // provider deleted mid-flow — fall back to the org's default provider.
    row = await ssoService.resolveProviderForStart(org.id, null);
  }
  if (!row) return redirectError(res, 'sso_not_configured');

  const cfg = ssoService.decryptProvider(row);

  if (cfg.provider === 'github') {
    return runGithubCallback(req, res, { org, cfg, code, stateData });
  }
  return runOidcCallback(req, res, { org, cfg, code, stateData });
}

// ---------------------------------------------------------------------------
// SAML — the inbound half. Called by routes/samlAcs.js, which owns the
// endpoint (it has to be mounted ahead of the global body parsers) but none of
// the logic. Everything after validation is the SAME tail OIDC and GitHub
// use: reconcileSsoUser, the pending-link branch, the audit entry, the
// one-time exchange code the frontend trades for a session.
// ---------------------------------------------------------------------------

async function auditSamlFailure(req, { org, providerId, reason }) {
  await auditLog({
    orgId: org.id,
    actorId: null,
    action: ACTIONS.auth.sso_failed,
    resourceType: 'User',
    metadata: { reason, provider: 'saml', providerId },
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || '',
  });
}

/**
 * Consume one SAMLResponse.
 *
 * Trust order matters here and is deliberate:
 *
 *   1. The provider row comes from the ACS URL's path, so the org, the
 *      trusted certificate, the expected audience and the Redis namespace are
 *      all fixed before a single byte of the assertion is examined. Nothing
 *      inside the assertion can move the request to a different org.
 *   2. The RelayState, if present, must be a state token WE issued, for THIS
 *      provider, in THIS org. It is single-use (taken from Redis). A
 *      RelayState we do not recognise is a refusal, not a fallback to
 *      IdP-initiated — otherwise "IdP-initiated is off" would be bypassable
 *      by sending garbage in RelayState.
 *   3. Only then is the assertion validated, by samlService.
 *
 * Note what is NOT here: any decision about who the user is. That is
 * ssoService.reconcileSsoUser, identical for every protocol, including its
 * refusal to silently adopt an account that has a password or holds a
 * privileged permission.
 */
export async function handleSamlAssertion(req, res, { row, samlResponse, relayState }) {
  const org = await prisma.organization.findUnique({ where: { id: row.orgId } });
  if (!org) {
    logger.error('SAML assertion for a provider whose org is gone', { providerId: row.id });
    return redirectError(res, 'sso_failed');
  }

  let cfg;
  try {
    cfg = samlService.decryptSamlProvider(row);
  } catch {
    // Wrong / rotated SERVER_ENCRYPTION_KEY. Never log the ciphertext or the
    // decryption error, which can echo key material state.
    logger.error('SAML provider secrets could not be decrypted', { providerId: row.id, orgId: row.orgId });
    return redirectError(res, 'sso_not_configured');
  }

  let stateData = null;
  if (relayState) {
    stateData = await takeSsoState(relayState);
    if (!stateData) {
      logger.warn('SAML RelayState was unknown or already used', { providerId: row.id, orgId: row.orgId });
      return redirectError(res, 'state_mismatch');
    }
    if (stateData.orgId !== row.orgId || stateData.providerId !== row.id) {
      // A state token issued for a DIFFERENT provider (possibly in a
      // different org) replayed against this ACS.
      logger.warn('SAML RelayState did not match this provider', { providerId: row.id, orgId: row.orgId });
      await auditSamlFailure(req, { org, providerId: row.id, reason: 'state_mismatch' });
      return redirectError(res, 'state_mismatch');
    }
    res.locals.ssoState = stateData;
  } else if (row.samlAllowIdpInitiated !== true) {
    // Unsolicited assertion, and this provider has not opted in. Refused
    // BEFORE validation: there is nothing to gain from examining it, and a
    // refusal that depends on less code is a refusal that is easier to trust.
    logger.warn('Unsolicited SAML assertion refused — IdP-initiated sign-in is disabled', {
      providerId: row.id,
      orgId: row.orgId,
    });
    await auditSamlFailure(req, { org, providerId: row.id, reason: 'saml_idp_initiated_disabled' });
    return redirectError(res, 'saml_idp_initiated_disabled');
  }

  // A "connect from Profile" round-trip can only exist with state we issued
  // (it carries `mode: 'connect'` and a userId), so an unsolicited assertion
  // can never reach the connect path — there is no state to carry it.

  let profile;
  try {
    profile = await samlService.consumeAssertion({
      cfg,
      samlResponse,
      expectedInResponseTo: stateData?.samlRequestId || null,
    });
  } catch (err) {
    const errorCode = err.errorCode || 'sso_failed';
    await auditSamlFailure(req, { org, providerId: cfg.id, reason: errorCode });
    // err.message is not logged: samlService already logged a classified
    // reason, and node-saml messages can quote document fragments.
    logger.warn('SAML sign-in rejected', { orgId: org.id, providerId: cfg.id, code: errorCode });
    return redirectError(res, errorCode);
  }

  return finishSsoCallback(req, res, {
    org,
    cfg,
    subject: profile.subject,
    externalId: profile.externalId,
    email: profile.email,
    emailVerified: profile.emailVerified,
    name: profile.name,
    picture: null,
  });
}

// No-orgSlug callback — the single redirect URI registered with the IdP. The
// org is derived from the signed `state`. MUST be registered before /:orgSlug.
router.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    const cookieState = readCookie(req, SSO_STATE_COOKIE);
    return runSsoCallback(req, res, { code, state, cookieState });
  })
);

// Revision 2 — per-provider callback (this is the `callbackUrl` in
// SsoProviderDTO, registered at the IdP). Provider resolution still trusts
// the server-side `state` (not this path param) for security; the param
// exists so each provider gets a distinct, registerable redirect URI.
router.get(
  '/callback/:providerId',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    const cookieState = readCookie(req, SSO_STATE_COOKIE);
    return runSsoCallback(req, res, { code, state, cookieState });
  })
);

/**
 * Create the state (Redis + cookie) for one IdP round-trip and return the
 * provider's authorize URL. `extra` is stored with the state — e.g.
 * `{ mode: 'connect', userId }` for a Profile "connect" flow.
 */
async function beginAuthorize(res, org, cfg, extra = {}) {
  const state = crypto.randomBytes(16).toString('hex');

  if (cfg.provider === 'saml') {
    // SAML has no PKCE and no nonce; its equivalents are the AuthnRequest ID
    // (echoed back as InResponseTo) and the RelayState. `startLogin` writes
    // the request id to Redis as a side effect and throws if it cannot, so a
    // login never starts unbound.
    const samlCfg = samlService.decryptSamlProvider(cfg);
    const { url, requestId } = await samlService.startLogin(samlCfg, state);
    await saveSsoState(state, {
      orgId: org.id,
      providerId: cfg.id,
      protocol: 'saml',
      samlRequestId: requestId,
      createdAt: Date.now(),
      ...extra,
    });
    // The state cookie is set for parity with the OIDC flow, but SAML does
    // NOT depend on it: the assertion comes back as a cross-site form POST
    // and a SameSite=Lax cookie is not sent on one. See routes/samlAcs.js.
    setStateCookie(res, state);
    return url;
  }

  const { codeVerifier, codeChallenge } = generatePkce();

  if (cfg.provider === 'github') {
    await saveSsoState(state, { orgId: org.id, providerId: cfg.id, codeVerifier, createdAt: Date.now(), ...extra });
    setStateCookie(res, state);
    return githubOAuth.buildAuthorizeUrl({
      issuerUrl: cfg.issuerUrl,
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      scopes: cfg.scopes,
      state,
      codeChallenge,
    });
  }

  const discovery = await discover(cfg.issuerUrl);
  const nonce = crypto.randomBytes(16).toString('hex');

  await saveSsoState(state, { orgId: org.id, providerId: cfg.id, nonce, codeVerifier, createdAt: Date.now(), ...extra });
  setStateCookie(res, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Pending SSO links — public, token-bound (docs/auth-hardening.md "Linking SSO
// accounts"). Registered before /:orgSlug for readability; all are POST.
// ---------------------------------------------------------------------------

// POST /api/auth/sso/link/info — what is being linked (for /sso/link)
router.post(
  '/link/info',
  authLimiter,
  validate(linkTokenSchema),
  asyncHandler(async (req, res) => {
    const info = await ssoLinkService.describePendingLink(req.body.token, 'password');
    res.json({ success: true, data: info });
  })
);

// POST /api/auth/sso/confirm-link — password (+ MFA) proof, then link + sign in
router.post(
  '/confirm-link',
  authLimiter,
  validate(confirmLinkSchema),
  asyncHandler(async (req, res) => {
    const result = await ssoLinkService.confirmPendingLink({
      token: req.body.token,
      password: req.body.password,
      method: req.body.method,
      code: req.body.code,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    res.json({ success: true, data: result });
  })
);

// POST /api/auth/sso/confirm-link/send-code — email the MFA code (step 2)
router.post(
  '/confirm-link/send-code',
  authLimiter,
  validate(linkTokenSchema),
  asyncHandler(async (req, res) => {
    const result = await ssoLinkService.sendConfirmLinkCode(req.body.token);
    res.json({ success: true, data: result });
  })
);

// POST /api/auth/sso/link/cancel — "Cancel" on /sso/link burns the token
router.post(
  '/link/cancel',
  authLimiter,
  validate(linkTokenSchema),
  asyncHandler(async (req, res) => {
    const result = await ssoLinkService.cancelPendingLink(req.body.token, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    res.json({ success: true, data: result });
  })
);

// POST /api/auth/sso/link/approve-info — what the emailed approval is for
router.post(
  '/link/approve-info',
  tokenActionLimiter,
  validate(linkTokenSchema),
  asyncHandler(async (req, res) => {
    const info = await ssoLinkService.describePendingLink(req.body.token, 'email_approval');
    res.json({ success: true, data: info });
  })
);

// POST /api/auth/sso/link/approve — the emailed approval: links, no sign-in
router.post(
  '/link/approve',
  tokenActionLimiter,
  validate(linkTokenSchema),
  asyncHandler(async (req, res) => {
    const result = await ssoLinkService.approvePendingLink(req.body.token, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    res.json({ success: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// POST /api/auth/sso/connect/start — signed-in user links another provider
// from Profile. Self-service (acts only on the caller's own account, like
// DELETE /api/auth/identities/:id), so no extra permission. The callback
// links to THIS user only — never by email.
// ---------------------------------------------------------------------------

// GET /api/auth/sso/connect/providers — the caller's org's active providers
// (for Profile → Sign-in methods). Same public-safe DTO as the login page.
router.get(
  '/connect/providers',
  authenticate,
  tenant,
  asyncHandler(async (req, res) => {
    const providers = await ssoConfigService.listActiveProviders(req.orgId);
    res.json({ success: true, data: { providers } });
  })
);

router.post(
  '/connect/start',
  authenticate,
  tenant,
  userRateLimiter({ keyPrefix: 'rl:sso-connect', windowSeconds: 60, max: 10 }),
  validate(connectStartSchema),
  asyncHandler(async (req, res) => {
    const row = await ssoLinkService.assertCanStartConnect({
      orgId: req.orgId,
      userId: req.user.userId,
      providerId: req.body.providerId,
    });
    const org = await prisma.organization.findUnique({ where: { id: req.orgId } });
    const cfg = ssoService.decryptProvider(row);
    const url = await beginAuthorize(res, org, cfg, { mode: 'connect', userId: req.user.userId });
    await auditLog({
      orgId: req.orgId,
      actorId: req.user.userId,
      action: ACTIONS.auth.identity_connect_started,
      resourceType: 'User',
      resourceId: req.user.userId,
      metadata: { provider: cfg.name || cfg.provider, providerId: cfg.id },
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || '',
    });
    res.json({ success: true, data: { url } });
  })
);

router.get(
  '/:orgSlug',
  asyncHandler(async (req, res) => {
    const { orgSlug } = req.params;
    const org = await prisma.organization.findUnique({ where: { slug: orgSlug } });
    if (!org) throw new ApiError(404, 'Organization not found');

    const providerIdParam = req.query.provider ? String(req.query.provider) : null;
    const row = await ssoService.resolveProviderForStart(org.id, providerIdParam);
    if (!row || !row.isActive) {
      return redirectError(res, 'sso_not_configured');
    }

    const cfg = ssoService.decryptProvider(row);
    const authorizeUrl = await beginAuthorize(res, org, cfg);
    res.redirect(authorizeUrl);
  })
);

// Legacy per-org callback (kept for back-compat with older IdP registrations).
router.get(
  '/:orgSlug/callback',
  asyncHandler(async (req, res) => {
    const { orgSlug } = req.params;
    const { code, state } = req.query;
    const cookieState = readCookie(req, SSO_STATE_COOKIE);
    const org = await prisma.organization.findUnique({ where: { slug: orgSlug } });
    if (!org) return redirectError(res, 'sso_failed');
    return runSsoCallback(req, res, { code, state, cookieState, orgHint: org.id });
  })
);

export default router;
