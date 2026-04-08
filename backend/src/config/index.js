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
    expiry: '15m',
    refreshExpiry: '7d',
  },

  encryption: {
    key: process.env.SERVER_ENCRYPTION_KEY || '',
  },

  bcryptRounds: 12,
};

export default config;
