import express from 'express';
import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import prisma from '../config/db.js';
import * as ssoService from '../services/ssoService.js';
import { generateAccessToken, generateRefreshToken, hashToken } from '../utils/jwt.js';
import logger from '../utils/logger.js';

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// In-memory state store (TODO: move to Redis for production)
const stateStore = new Map();
// Discovery cache (TODO: persist w/ TTL in Redis)
const discoveryCache = new Map();

async function discover(issuerUrl) {
  const cached = discoveryCache.get(issuerUrl);
  if (cached && cached.expires > Date.now()) return cached.doc;
  const url = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const res = await fetch(url);
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
