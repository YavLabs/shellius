/**
 * bootstrapUrlService — builds a signed install.sh URL for a server, without a
 * request object (used by the background onboarding worker). Mirrors the
 * token-signing + URL-resolution logic in routes/servers.js and routes/bootstrap.js.
 */

import jwt from 'jsonwebtoken';
import config from '../config/index.js';

/** Resolve the public backend base URL from env (no request available). */
export function resolveBackendUrl() {
  if (process.env.TRAEFIK_HOST) return `https://${process.env.TRAEFIK_HOST}`;
  if (process.env.PUBLIC_API_URL) return String(process.env.PUBLIC_API_URL).replace(/\/$/, '').replace(/\/api$/, '');
  if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '').replace(/\/api$/, '');
  if (process.env.VITE_API_URL) return String(process.env.VITE_API_URL).replace(/\/$/, '').replace(/\/api$/, '');
  return 'http://localhost:3001';
}

/**
 * @param {string} orgId
 * @param {string} serverId
 * @returns {Promise<string>} full https URL to install.sh with a 30-min token
 */
export async function buildBootstrapUrl(orgId, serverId) {
  const token = jwt.sign({ kind: 'bootstrap', serverId, orgId }, config.jwt.secret, { expiresIn: 30 * 60 });
  return `${resolveBackendUrl()}/api/bootstrap/install.sh?token=${token}`;
}

export default { buildBootstrapUrl, resolveBackendUrl };
