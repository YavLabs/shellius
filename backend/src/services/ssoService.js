import prisma from '../config/db.js';
import ssoConfig from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { envAllowedDomains } from './ssoConfigService.js';

function redactSecret(config) {
  if (!config) return config;
  const { clientSecretEncrypted, ...rest } = config;
  return { ...rest, clientSecret: '***REDACTED***' };
}

export async function getSsoConfig(orgId) {
  const cfg = await prisma.ssoConfig.findFirst({ where: { orgId }, orderBy: { displayOrder: 'asc' } });
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

  const existing = await prisma.ssoConfig.findFirst({ where: { orgId }, orderBy: { displayOrder: 'asc' } });

  let result;
  if (existing) {
    result = await prisma.ssoConfig.update({
      where: { id: existing.id },
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
  // Single org-agnostic callback (org is carried in `state`). Matches the
  // GET /api/auth/sso/callback route and the saved-row default redirect URI.
  void orgSlug;
  return `${publicBase.replace(/\/$/, '')}/api/auth/sso/callback`;
}

function safeDefaultRole(role) {
  if (!role || role === 'super_admin') return 'member';
  return role;
}

/**
 * Resolve the org's full effective SSO policy — connection params (client
 * id/secret/issuer/redirect/scopes) AND provisioning/reconciliation policy
 * (allowedDomains, requireVerifiedEmail, autoProvision, defaultRole,
 * defaultGroupId) — merging a DB row over env-var presets.
 */
export async function getDecryptedConfig(orgId, { orgSlug = null, req = null } = {}) {
  const cfg = await prisma.ssoConfig.findFirst({ where: { orgId }, orderBy: { displayOrder: 'asc' } });
  if (cfg) {
    // Secret from the row, or fall back to the preset's env secret/clientId so
    // an env-backed config (managed only for defaultRole/autoProvision) works.
    const envPreset = cfg.presetId ? ENV_ONLY_PRESETS[cfg.presetId]?.() : null;
    const clientSecret = cfg.clientSecretEncrypted
      ? decrypt(cfg.clientSecretEncrypted)
      : envPreset?.clientSecret || null;
    return {
      ...cfg,
      clientId: cfg.clientId || envPreset?.clientId || null,
      clientSecret,
      defaultRole: safeDefaultRole(cfg.defaultRole),
      allowedDomains: cfg.allowedDomains || [],
      requireVerifiedEmail: cfg.requireVerifiedEmail !== false,
    };
  }

  // Fall back to env-only presets
  for (const [presetId, build] of Object.entries(ENV_ONLY_PRESETS)) {
    const envCfg = build();
    if (envCfg) {
      return {
        ...envCfg,
        redirectUri: buildEnvCallbackUrl(orgSlug, req),
        allowedDomains: envAllowedDomains(),
        requireVerifiedEmail: true,
        autoProvision: process.env.SSO_AUTO_PROVISION !== 'false',
        defaultRole: safeDefaultRole(process.env.SSO_DEFAULT_ROLE),
        defaultGroupId: null,
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
  const row = await prisma.ssoConfig.findFirst({ where: { orgId }, orderBy: { displayOrder: 'asc' } });
  if (row && row.isActive) {
    return { enabled: true, presetId: row.presetId || 'oidc' };
  }
  for (const [presetId, build] of Object.entries(ENV_ONLY_PRESETS)) {
    if (build()) return { enabled: true, presetId };
  }
  return { enabled: false, presetId: null };
}

// ---------------------------------------------------------------------------
// Reconciliation — turns a verified ID token + userinfo response into a
// Shellius User, per docs/auth-hardening.md:
//   1. match on (orgId, ssoProvider, ssoSub)
//   2. else match on email — only when email_verified is asserted (when the
//      config requires it) AND the candidate has no different ssoSub
//   3. else JIT-provision if autoProvision
// allowedDomains (empty = any) gates both sign-in and provisioning.
// defaultRole can never be super_admin.
// ---------------------------------------------------------------------------

/** Error with a stable `errorCode` the callback route maps to `#error=<code>`. */
export function ssoError(code, message, statusCode = 403) {
  const err = new ApiError(statusCode, message);
  err.errorCode = code;
  return err;
}

export async function reconcileOidcUser({ orgId, cfg, idClaims, userinfo }) {
  const email = String(userinfo.email || idClaims.email || '').toLowerCase().trim();
  // Some IdPs (e.g. Cognito) send email_verified as the string "true".
  const rawVerified = userinfo.email_verified ?? idClaims.email_verified ?? false;
  const emailVerified = rawVerified === true || rawVerified === 'true';
  const requireVerified = cfg.requireVerifiedEmail !== false;
  const sub = idClaims.sub || userinfo.sub;

  if (!sub) {
    throw ssoError('sso_failed', 'OIDC response is missing a sub claim');
  }

  const allowedDomains = cfg.allowedDomains || [];
  if (allowedDomains.length > 0) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain || !allowedDomains.includes(domain)) {
      throw ssoError('domain_not_allowed', 'Your email domain is not permitted to sign in to this organization');
    }
  }

  // 1. Match on (orgId, provider, sub) — the strongest, most stable identity.
  let user = await prisma.user.findFirst({ where: { orgId, ssoProvider: 'oidc', ssoSub: sub } });

  // 2. Fall back to matching an existing local/invited account by email.
  if (!user && email) {
    const candidate = await prisma.user.findFirst({ where: { orgId, email } });
    if (candidate) {
      if (candidate.ssoSub && candidate.ssoSub !== sub) {
        throw ssoError('identity_conflict', 'This email is already linked to a different identity provider account');
      }
      if (requireVerified && !emailVerified) {
        throw ssoError('email_not_verified', 'Your identity provider did not assert a verified email for this account');
      }
      user = candidate;
    }
  }

  if (!user) {
    if (!cfg.autoProvision) {
      throw ssoError(
        'provisioning_disabled',
        'Your account has not been set up in Shellius yet. Please contact your administrator to request access.'
      );
    }
    if (!email) {
      throw ssoError('sso_failed', 'OIDC response is missing an email claim');
    }
    // allowedDomains is only meaningful if the email is verified — never
    // provision an account from an unverified email claim.
    if (requireVerified && !emailVerified) {
      throw ssoError('email_not_verified', 'Your identity provider did not assert a verified email for this account');
    }
    const defaultRole = safeDefaultRole(cfg.defaultRole);
    const created = await prisma.user.create({
      data: {
        orgId,
        email,
        name: userinfo.name || userinfo.preferred_username || email,
        role: defaultRole,
        status: 'active',
        ssoProvider: 'oidc',
        ssoSub: sub,
        avatarUrl: userinfo.picture || null,
      },
    });
    if (cfg.defaultGroupId) {
      await prisma.groupMembership
        .create({ data: { groupId: cfg.defaultGroupId, userId: created.id } })
        .catch(() => {}); // ignore if group was deleted / already a member
    }
    user = created;
  } else {
    if (['deleted', 'suspended', 'deactivated'].includes(user.status)) {
      throw ssoError('account_disabled', 'Account is not active');
    }
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        // Keep the user's existing display name if they've already set one.
        name: user.name || userinfo.name || user.name,
        avatarUrl: userinfo.picture || user.avatarUrl,
        ssoProvider: user.ssoProvider || 'oidc',
        ssoSub: user.ssoSub || sub,
        // First SSO sign-in for an invited / pending user activates the
        // account (linking by email — no separate password step required).
        // Safe here: the disabled-status branch above already rejected
        // suspended/deactivated/deleted accounts.
        status: 'active',
        lastLoginAt: new Date(),
      },
    });
  }

  // Always return the user WITH organization included — issueSession()/mfaGate()
  // expect it.
  return prisma.user.findUnique({ where: { id: user.id }, include: { organization: true } });
}

export default {
  getSsoConfig,
  upsertSsoConfig,
  getDecryptedConfig,
  getPublicSsoStatus,
  reconcileOidcUser,
  ssoError,
};
