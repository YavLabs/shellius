import prisma from '../config/db.js';
import ssoConfig from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import { encrypt, decrypt } from '../utils/crypto.js';

function redactSecret(config) {
  if (!config) return config;
  const { clientSecretEncrypted, ...rest } = config;
  return { ...rest, clientSecret: '***REDACTED***' };
}

export async function getSsoConfig(orgId) {
  const cfg = await prisma.ssoConfig.findUnique({ where: { orgId } });
  return redactSecret(cfg);
}

export async function upsertSsoConfig(orgId, configData) {
  const {
    provider,
    clientId,
    clientSecret,
    issuerUrl,
    redirectUri,
    scopes,
    isActive,
  } = configData;

  if (!provider || !clientId || !issuerUrl || !redirectUri) {
    throw new ApiError(400, 'provider, clientId, issuerUrl, redirectUri are required');
  }

  const encrypted = clientSecret ? encrypt(clientSecret) : undefined;

  const data = {
    provider,
    clientId,
    issuerUrl,
    redirectUri,
    scopes: scopes || 'openid profile email',
    isActive: isActive !== undefined ? isActive : true,
  };

  const existing = await prisma.ssoConfig.findUnique({ where: { orgId } });

  let result;
  if (existing) {
    result = await prisma.ssoConfig.update({
      where: { orgId },
      data: { ...data, ...(encrypted ? { clientSecretEncrypted: encrypted } : {}) },
    });
  } else {
    if (!encrypted) {
      throw new ApiError(400, 'clientSecret is required for new SSO config');
    }
    result = await prisma.ssoConfig.create({
      data: { orgId, ...data, clientSecretEncrypted: encrypted },
    });
  }

  return redactSecret(result);
}

// Env-only preset definitions used as a fallback when no DB row exists.
// Lets operators wire up Google SSO purely from .env.prod without ever
// touching the Settings → SSO wizard. Add new presets here as needed.
const ENV_ONLY_PRESETS = {
  google: () => {
    const clientId = process.env.SSO_GOOGLE_CLIENT_ID;
    const clientSecret = process.env.SSO_GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return {
      provider: 'oidc',
      presetId: 'google',
      clientId,
      clientSecret,
      issuerUrl: 'https://accounts.google.com',
      scopes: 'openid email profile',
      isActive: true,
    };
  },
};

/**
 * Build the public callback URL for an org. Used when no DB row exists
 * (env-only configs) so the OAuth redirect_uri matches whatever public
 * host the user is hitting Shellius on.
 */
function buildEnvCallbackUrl(orgSlug, req) {
  // Prefer config.publicBaseUrl (derived from TRAEFIK_HOST / FRONTEND_URL /
  // PUBLIC_BASE_URL) — single source of truth. Falls back to the incoming
  // request origin for dev / reverse-proxy-less setups.
  const publicBase =
    ssoConfig.publicBaseUrl ||
    (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:3001');
  return `${publicBase.replace(/\/$/, '')}/api/auth/sso/${orgSlug}/callback`;
}

export async function getDecryptedConfig(orgId, { orgSlug = null, req = null } = {}) {
  const cfg = await prisma.ssoConfig.findUnique({ where: { orgId } });
  if (cfg) {
    return { ...cfg, clientSecret: decrypt(cfg.clientSecretEncrypted) };
  }

  // Fall back to env-only presets
  for (const [presetId, build] of Object.entries(ENV_ONLY_PRESETS)) {
    const envCfg = build();
    if (envCfg) {
      return {
        ...envCfg,
        redirectUri: buildEnvCallbackUrl(orgSlug, req),
      };
    }
    // suppress unused
    void presetId;
  }

  return null;
}

/**
 * Lightweight public probe used by the unauthenticated login page to
 * decide which SSO button(s) to render. Never returns secrets — only
 * { enabled, presetId }.
 */
export async function getPublicSsoStatus(orgId) {
  const row = await prisma.ssoConfig.findUnique({ where: { orgId } });
  if (row && row.isActive) {
    return { enabled: true, presetId: row.presetId || 'oidc' };
  }
  for (const [presetId, build] of Object.entries(ENV_ONLY_PRESETS)) {
    if (build()) return { enabled: true, presetId };
  }
  return { enabled: false, presetId: null };
}

export async function handleOidcUserInfo(userinfo, orgId) {
  const email = userinfo.email;
  if (!email) {
    throw new ApiError(400, 'OIDC userinfo missing email claim');
  }

  let user = await prisma.user.findFirst({ where: { orgId, email } });

  const name = userinfo.name || userinfo.preferred_username || email;
  const avatarUrl = userinfo.picture || null;
  const ssoSub = userinfo.sub;

  if (!user) {
    user = await prisma.user.create({
      data: {
        orgId,
        email,
        name,
        role: 'viewer',
        status: 'active',
        ssoProvider: 'oidc',
        ssoSub,
        avatarUrl,
      },
    });
  } else {
    if (user.status === 'deleted' || user.status === 'suspended' || user.status === 'deactivated') {
      throw new ApiError(403, 'Account is not active');
    }
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        // Keep the user's existing display name if they've already set one.
        name: user.name || name,
        avatarUrl: avatarUrl || user.avatarUrl,
        ssoProvider: user.ssoProvider || 'oidc',
        ssoSub: user.ssoSub || ssoSub,
        // First SSO sign-in for an invited / pending user activates the account
        // (linking by email — no separate password step required).
        status: 'active',
        lastLoginAt: new Date(),
      },
    });
  }

  return user;
}

export default { getSsoConfig, upsertSsoConfig, getDecryptedConfig, handleOidcUserInfo };
