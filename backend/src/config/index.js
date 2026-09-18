/**
 * Centralized runtime config.
 *
 * Public-URL handling: TRAEFIK_HOST is the single source of truth in prod.
 * Everything else (corsOrigin, publicBaseUrl, frontendUrl) is derived from
 * it unless an explicit override is set. This means .env.prod only needs:
 *
 *   TRAEFIK_HOST=shellius.example.com
 *
 * and all the URL-based callers (SSO, device auth, CORS, bootstrap links,
 * email buttons) just work. The old per-purpose vars (CORS_ORIGIN,
 * FRONTEND_URL, PUBLIC_BASE_URL) remain honored as overrides for anyone
 * who already has them set, so this change is backwards compatible.
 */

function computePublicBaseUrl() {
  // Explicit override wins.
  if (process.env.PUBLIC_BASE_URL) return stripTrailingSlash(process.env.PUBLIC_BASE_URL);
  if (process.env.FRONTEND_URL) return stripTrailingSlash(process.env.FRONTEND_URL);
  // Derive from TRAEFIK_HOST (bare hostname — we assume https in prod).
  if (process.env.TRAEFIK_HOST) return `https://${process.env.TRAEFIK_HOST}`;
  // Dev fallback.
  return 'http://localhost:5173';
}

function computeCorsOrigin(publicBaseUrl) {
  if (process.env.CORS_ORIGIN) return process.env.CORS_ORIGIN;
  // In dev, Vite runs on 5173 by default and hits the backend via proxy;
  // the publicBaseUrl fallback matches that, so this works for both.
  return publicBaseUrl;
}

function stripTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

const publicBaseUrl = computePublicBaseUrl();

const config = {
  port: parseInt(process.env.PORT, 10) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Public URL surface — all derived from TRAEFIK_HOST unless explicitly
  // overridden. Use these throughout the codebase instead of reading
  // process.env.* directly.
  publicBaseUrl,
  corsOrigin: computeCorsOrigin(publicBaseUrl),
  // Legacy alias so old imports keep working.
  frontendUrl: publicBaseUrl,

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-jwt-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
    // Read from env so operators can extend session lifetimes without
    // patching the source. Defaults match the original hardcoded values
    // so existing deployments don't shift behavior on upgrade.
    expiry: process.env.JWT_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },

  encryption: {
    key: process.env.SERVER_ENCRYPTION_KEY || '',
  },

  bcryptRounds: 12,

  // Per-account lockout (auth hardening).
  auth: {
    lockoutThreshold: parseInt(process.env.AUTH_LOCKOUT_THRESHOLD, 10) || 5,
    lockoutMinutes: parseInt(process.env.AUTH_LOCKOUT_MINUTES, 10) || 15,
    // Absolute lifetime of a refresh-token family, regardless of activity.
    sessionAbsoluteTtlMs:
      (parseInt(process.env.SESSION_ABSOLUTE_TTL, 10) || 30) * 24 * 60 * 60 * 1000,
    // Grace window during which a rotated-but-reused refresh token is
    // treated as a benign client race rather than theft.
    refreshReuseGraceMs: 10 * 1000,
  },
};

// ---------------------------------------------------------------------------
// Startup safety checks
// ---------------------------------------------------------------------------

const DEV_DEFAULT_JWT_SECRET = 'dev-jwt-secret-change-me';
const DEV_DEFAULT_REFRESH_SECRET = 'dev-refresh-secret-change-me';

if (config.nodeEnv === 'production') {
  if (
    config.jwt.secret === DEV_DEFAULT_JWT_SECRET ||
    config.jwt.refreshSecret === DEV_DEFAULT_REFRESH_SECRET
  ) {
    throw new Error(
      'Refusing to start in production with default JWT_SECRET/JWT_REFRESH_SECRET. ' +
        'Set both to strong, unique random values.'
    );
  }
  if (!config.encryption.key) {
    // eslint-disable-next-line no-console
    console.warn(
      '[config] WARNING: SERVER_ENCRYPTION_KEY is not set in production. ' +
        'A fallback key derived from a constant will be used, which is NOT secure ' +
        'for encrypted-at-rest secrets (CA keys, SSO client secrets, MFA secrets). ' +
        'Set SERVER_ENCRYPTION_KEY — changing it later will orphan already-encrypted data.'
    );
  }
}

export default config;
