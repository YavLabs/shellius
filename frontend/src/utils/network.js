/**
 * Network helpers — frontend mirror of the backend SSRF guard ranges.
 *
 * isPrivateIP(addr) returns true for IPs that are unlikely to be reachable
 * from outside the deployment's own network. Used to surface a "you may
 * need to be on the VPN" warning whenever a server's IP is private.
 *
 * Coverage:
 *   IPv4:
 *     10.0.0.0/8         — RFC 1918 private
 *     172.16.0.0/12      — RFC 1918 private
 *     192.168.0.0/16     — RFC 1918 private
 *     127.0.0.0/8        — loopback
 *     169.254.0.0/16     — link-local
 *     100.64.0.0/10      — CGNAT (RFC 6598)
 *
 *   IPv6:
 *     ::1                — loopback
 *     fc00::/7           — ULA (RFC 4193)
 *     fe80::/10          — link-local
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIPv4(addr) {
  if (typeof addr !== 'string') return false;
  const m = IPV4_RE.exec(addr.trim());
  if (!m) return false;
  return m.slice(1).every((octet) => {
    const n = Number(octet);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function isIPv6(addr) {
  if (typeof addr !== 'string') return false;
  // Strip brackets if user typed [::1]
  const trimmed = addr.trim().replace(/^\[/, '').replace(/\]$/, '');
  // Very loose check — colons + hex digits, must contain at least one ':'
  return /^[0-9a-fA-F:]+$/.test(trimmed) && trimmed.includes(':');
}

function isPrivateIPv4(addr) {
  const m = IPV4_RE.exec(addr.trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function isPrivateIPv6(addr) {
  const trimmed = addr.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (trimmed === '::1') return true; // loopback
  if (/^f[cd]/.test(trimmed)) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(trimmed)) return true; // fe80::/10 link-local
  return false;
}

/**
 * @param {string} addr — IPv4 or IPv6 string
 * @returns {boolean}
 */
export function isPrivateIP(addr) {
  if (!addr || typeof addr !== 'string') return false;
  if (isIPv4(addr)) return isPrivateIPv4(addr);
  if (isIPv6(addr)) return isPrivateIPv6(addr);
  return false;
}

export default { isPrivateIP };
