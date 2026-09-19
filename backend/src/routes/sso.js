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
import { log as auditLog, ACTIONS } from '../services/auditService.js';
import logger from '../utils/logger.js';
import redis from '../config/redis.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import { requirePermission } from '../middleware/rbac.js';
import audit from '../middleware/audit.js';
import { assertSsoDefaultRole } from '../services/roleService.js';

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

const ssoConfigSchema = Joi.object({
  provider: Joi.string().valid('oidc', 'saml').required(),
  presetId: Joi.string().valid('google', 'entra', 'okta', 'auth0', 'generic-oidc', 'saml').optional(),
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
  provider: Joi.string().valid('oidc', 'saml'),
  issuerUrl: Joi.string().uri(),
});

const exchangeSchema = Joi.object({
  code: Joi.string().required(),
});

// ---------------------------------------------------------------------------
// Joi schemas — Revision 2, multi-provider CRUD
// ---------------------------------------------------------------------------

const PRESET_IDS = ['google', 'entra', 'okta', 'auth0', 'generic', 'github'];

const providerCreateSchema = Joi.object({
  name: Joi.string().min(1).max(120).required(),
  presetId: Joi.string().valid(...PRESET_IDS).required(),
  clientId: Joi.string().min(1).max(500).required(),
  clientSecret: Joi.string().min(1).max(2000).allow(''),
  issuerUrl: Joi.string().uri(),
  scopes: Joi.string().max(500),
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
    email,
    emailVerified,
    name: ghUser.name,
    picture: ghUser.picture,
  });
}

// ---------------------------------------------------------------------------
// Shared tail — reconcile, audit, hand off a one-time exchange code.
// ---------------------------------------------------------------------------

async function finishSsoCallback(req, res, { org, cfg, subject, email, emailVerified, name, picture }) {
  let user;
  try {
    user = await ssoService.reconcileSsoUser({ orgId: org.id, cfg, subject, email, emailVerified, name, picture });
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
  if (orgHint && orgHint !== stateData.orgId) return redirectError(res, 'state_mismatch');

  const org = await prisma.organization.findUnique({ where: { id: stateData.orgId } });
  if (!org) return redirectError(res, 'sso_failed');

  let row = null;
  if (stateData.providerId) {
    row = await prisma.ssoConfig.findFirst({ where: { id: stateData.providerId, orgId: org.id } });
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
    const state = crypto.randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = generatePkce();

    if (cfg.provider === 'github') {
      await saveSsoState(state, { orgId: org.id, providerId: cfg.id, codeVerifier, createdAt: Date.now() });
      setStateCookie(res, state);
      const authorizeUrl = githubOAuth.buildAuthorizeUrl({
        issuerUrl: cfg.issuerUrl,
        clientId: cfg.clientId,
        redirectUri: cfg.redirectUri,
        scopes: cfg.scopes,
        state,
        codeChallenge,
      });
      return res.redirect(authorizeUrl);
    }

    const discovery = await discover(cfg.issuerUrl);
    const nonce = crypto.randomBytes(16).toString('hex');

    await saveSsoState(state, { orgId: org.id, providerId: cfg.id, nonce, codeVerifier, createdAt: Date.now() });
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

    res.redirect(`${discovery.authorization_endpoint}?${params.toString()}`);
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
