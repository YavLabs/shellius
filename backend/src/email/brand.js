/**
 * Shellius email brand tokens + logo resolution.
 *
 * The header logo is the hosted PNG lockup served by the web app
 * (frontend/public/brand/png/…). Email clients block data: URIs and SVG, so a
 * hosted PNG is the only reliable image. When the app has no public URL
 * configured (or it points at localhost, which a recipient's mail client
 * can't reach) the header falls back to an HTML-only wordmark, so it never
 * shows a broken image.
 */

export const BRAND = {
  ink: '#09090C',
  indigo: '#141A2E',
  sky: '#8FB6F5',
  lavender: '#B9A6F2',
  light: '#EDEEF2',
  muted: '#8A8D94',
};

export const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const LOGO_PATH = '/brand/png/shellius-lockup-dark-bg-640x128.png';
export const LOGO_WIDTH = 200;
export const LOGO_HEIGHT = 40;

/**
 * The web app's public URL when one is explicitly configured, else null.
 * Same precedence as config/index.js (APP_URL → PUBLIC_BASE_URL →
 * FRONTEND_URL → TRAEFIK_HOST), read at call time; the dev fallback
 * (http://localhost:5173) and other loopback hosts count as "not configured".
 */
export function configuredAppUrl() {
  let url = null;
  if (process.env.APP_URL) url = process.env.APP_URL;
  else if (process.env.PUBLIC_BASE_URL) url = process.env.PUBLIC_BASE_URL;
  else if (process.env.FRONTEND_URL) url = process.env.FRONTEND_URL;
  else if (process.env.TRAEFIK_HOST) url = `https://${process.env.TRAEFIK_HOST}`;
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return null;
  }
  return url.replace(/\/+$/, '');
}

/** Absolute URL of the hosted header logo, or null → use the wordmark. */
export function logoUrl() {
  const base = configuredAppUrl();
  return base ? `${base}${LOGO_PATH}` : null;
}
