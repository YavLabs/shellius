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
 * email buttons) just work. Overrides, in order: APP_URL, PUBLIC_BASE_URL,
 * FRONTEND_URL (all mean "the public URL of the web app"); CORS_ORIGIN
 * overrides CORS only.
 */

function computePublicBaseUrl() {
  // Explicit overrides win. APP_URL is the documented "public URL of the web
  // app"; PUBLIC_BASE_URL / FRONTEND_URL are older spellings of the same.
  if (process.env.APP_URL) return stripTrailingSlash(process.env.APP_URL);
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
    // Comma-separated list of previously-active keys, kept around so
    // decrypt() can still read rows encrypted before a key rotation.
    previousKeys: (process.env.SERVER_ENCRYPTION_KEY_PREVIOUS || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
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

  certificates: {
    // check-principals runs on every SSH connection in the fleet, so the
    // owner-status check it performs has an off switch that doesn't need a
    // deploy. Revoking a disabled user's certificates is the primary fix and
    // is never disabled by this; turning it off only drops the backstop that
    // covers a certificate issued in the window before the revoke lands.
    checkUserStatus: process.env.CERT_VERIFY_CHECK_USER_STATUS !== 'false',
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
  // SERVER_ENCRYPTION_KEY must be set and strong: either a 64-char hex
  // string (32 raw bytes) or any string of at least 32 characters (hashed
  // with SHA-256 to derive the AES-256 key). This is a hard requirement in
  // production — every encrypted-at-rest secret (CA private key, SSH keys,
  // credentials, SSO client secrets, MFA secrets, RDP passwords) depends on
  // it, and the insecure dev fallback key is a publicly-known constant.
  const encKey = config.encryption.key;
  const isHex64 = /^[0-9a-fA-F]{64}$/.test(encKey);
  const isStrongEncryptionKey = !!encKey && (isHex64 || encKey.length >= 32);
  if (!isStrongEncryptionKey) {
    throw new Error(
      'Refusing to start in production without a strong SERVER_ENCRYPTION_KEY. ' +
        'Set it to a 64-character hex string (32 random bytes) or a random string ' +
        'of at least 32 characters. Generate one with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
} else if (!config.encryption.key) {
  // eslint-disable-next-line no-console
  console.warn(
    '[config] WARNING: SERVER_ENCRYPTION_KEY is not set. Falling back to an insecure, ' +
      'publicly-known development key for encryption. This is only acceptable outside ' +
      'production — set SERVER_ENCRYPTION_KEY in any environment with real data.'
  );
}

export default config;
