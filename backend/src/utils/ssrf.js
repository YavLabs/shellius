/**
 * ssrf.js — refuse to make outbound requests to private address space.
 *
 * Any feature where an org supplies a URL that the server then fetches is a
 * way to make Shellius probe its own network: SSO discovery, audit webhooks,
 * directory sync. One implementation so a fix reaches all of them.
 *
 * Lives in utils/ rather than in ssoConfigService, which is where it grew.
 * That module still re-exports it, so existing callers and their tests are
 * unchanged.
 */

import net from 'net';
import dns from 'dns';
import { promisify } from 'util';
import ApiError from './ApiError.js';

const dnsLookup = promisify(dns.lookup);

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (cloud metadata)
    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true; // loopback
    if (/^f[cd]/.test(normalized)) return true; // fc00::/7
    return false;
  }

  return false;
}

/**
 * Throw unless `rawUrl` points somewhere public.
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {boolean} [opts.allowPrivate]  skip the check entirely. Only for a
 *   destination an operator has deliberately opted into — an on-prem SIEM
 *   on a private network is a real and legitimate case, but it has to be a
 *   decision, not a default.
 */
export async function guardSsrf(rawUrl, { allowPrivate = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'Invalid URL');
  }

  if (allowPrivate) return;

  const { hostname } = parsed;

  // A bare IP literal needs no DNS round-trip.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new ApiError(400, 'SSRF guard: private IP addresses are not allowed');
    }
    return;
  }

  let resolvedIp;
  try {
    const result = await dnsLookup(hostname);
    resolvedIp = result.address;
  } catch {
    throw new ApiError(400, `SSRF guard: could not resolve hostname '${hostname}'`);
  }

  if (isPrivateIp(resolvedIp)) {
    throw new ApiError(400, 'SSRF guard: hostname resolves to a private IP address');
  }
}

export default { guardSsrf, isPrivateIp };
