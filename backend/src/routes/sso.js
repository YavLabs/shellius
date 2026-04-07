import express from 'express';
import crypto from 'crypto';
import Joi from 'joi';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import prisma from '../config/db.js';
import * as ssoService from '../services/ssoService.js';
import * as ssoConfigService from '../services/ssoConfigService.js';
import { generateAccessToken, generateRefreshToken, hashToken } from '../utils/jwt.js';
import logger from '../utils/logger.js';
import authenticate from '../middleware/auth.js';
import tenant from '../middleware/tenant.js';
import requireRole from '../middleware/rbac.js';
import audit from '../middleware/audit.js';

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// In-memory state store (TODO: move to Redis for production)
const stateStore = new Map();
// Discovery cache (TODO: persist w/ TTL in Redis)
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
// Joi schemas for SSO config endpoints
// ---------------------------------------------------------------------------

const ssoConfigSchema = Joi.object({
  provider: Joi.string().valid('oidc', 'saml').required(),
  presetId: Joi.string().valid('google', 'entra', 'okta', 'auth0', 'generic-oidc', 'saml').optional(),
  clientId: Joi.string().min(1).max(500).required(),
  clientSecret: Joi.string().min(1).max(2000),
  issuerUrl: Joi.string().uri().required(),
  redirectUri: Joi.string().uri(),
  scopes: Joi.string().max(500),
  isActive: Joi.boolean(),
});

const ssoTestSchema = Joi.object({
  provider: Joi.string().valid('oidc', 'saml'),
  issuerUrl: Joi.string().uri(),
});

// ---------------------------------------------------------------------------
// Admin SSO config endpoints — must be registered BEFORE /:orgSlug routes
// ---------------------------------------------------------------------------

// GET /api/auth/sso/config
router.get(
  '/config',
  authenticate,
  tenant,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const config = await ssoConfigService.get(req.orgId);
    res.json({ success: true, data: { config } });
  })
);

// PUT /api/auth/sso/config
router.put(
  '/config',
  authenticate,
  tenant,
  requireRole('admin'),
  audit('sso.config.update', 'SsoConfig'),
  validate(ssoConfigSchema),
  asyncHandler(async (req, res) => {
    const config = await ssoConfigService.upsert(req.orgId, req.body);
    res.json({ success: true, data: { config } });
  })
);

// POST /api/auth/sso/config/test
router.post(
  '/config/test',
  authenticate,
  tenant,
  requireRole('admin'),
  audit('sso.config.test', 'SsoConfig'),
  validate(ssoTestSchema),
  asyncHandler(async (req, res) => {
    const result = await ssoConfigService.test(req.orgId, req.body);
    res.json({ success: true, data: result });
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

router.get(
  '/:orgSlug',
  asyncHandler(async (req, res) => {
    const { orgSlug } = req.params;
    const org = await prisma.organization.findUnique({ where: { slug: orgSlug } });
    if (!org) throw new ApiError(404, 'Organization not found');

    const cfg = await ssoService.getDecryptedConfig(org.id);
    if (!cfg || !cfg.isActive) {
      return res.status(400).json({
        success: false,
        error: 'SSO is not configured for this organization',
      });
    }

    const discovery = await discover(cfg.issuerUrl);
    const state = crypto.randomBytes(16).toString('hex');
    stateStore.set(state, { orgId: org.id, createdAt: Date.now() });

    // GC old states
    for (const [k, v] of stateStore) {
      if (Date.now() - v.createdAt > 10 * 60 * 1000) stateStore.delete(k);
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      scope: cfg.scopes,
      state,
    });

    res.redirect(`${discovery.authorization_endpoint}?${params.toString()}`);
  })
);

router.get(
  '/:orgSlug/callback',
  asyncHandler(async (req, res) => {
    const { orgSlug } = req.params;
    const { code, state } = req.query;
    if (!code || !state) throw new ApiError(400, 'Missing code or state');

    const stateData = stateStore.get(state);
    if (!stateData) throw new ApiError(400, 'Invalid or expired state');
    stateStore.delete(state);

    const org = await prisma.organization.findUnique({ where: { slug: orgSlug } });
    if (!org || org.id !== stateData.orgId) throw new ApiError(400, 'Org mismatch');

    const cfg = await ssoService.getDecryptedConfig(org.id);
    if (!cfg) throw new ApiError(400, 'SSO not configured');

    const discovery = await discover(cfg.issuerUrl);

    // Exchange code for tokens
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      logger.error('OIDC token exchange failed', { text });
      throw new ApiError(401, 'Token exchange failed');
    }

    const tokens = await tokenRes.json();

    // Fetch userinfo
    const userinfoRes = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userinfoRes.ok) throw new ApiError(401, 'Userinfo fetch failed');
    const userinfo = await userinfoRes.json();

    const user = await ssoService.handleOidcUserInfo(userinfo, org.id);

    const accessToken = generateAccessToken({
      userId: user.id,
      orgId: user.orgId,
      role: user.role,
      email: user.email,
    });
    const refreshToken = generateRefreshToken({ userId: user.id, tokenId: crypto.randomUUID() });

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        clientType: 'web',
        ipAddress: req.ip,
        userAgent: req.get('user-agent') || '',
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });

    const fragment = new URLSearchParams({
      access_token: accessToken,
      refresh_token: refreshToken,
    }).toString();
    res.redirect(`${FRONTEND_URL}/auth/callback#${fragment}`);
  })
);

export default router;
