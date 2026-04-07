# Task 18E: Private-IP VPN warning helper + component + placements

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** 18Q-E, 18R-E
**Blocked By:** None
**Model:** sonnet

## Goal
Whenever a server's IP address looks like a private/RFC1918 range,
display a warning banner near the connect/request flow:

> 🛜 **Private network address** — `10.6.30.14` looks like a private
> IP. The Shellius backend can only reach this host if it (or your
> browser, for direct downloads) is on the same network. **Make sure
> you're connected to the appropriate VPN before connecting.**

## Implementation

### `frontend/src/utils/network.js` (NEW)
```js
/**
 * Returns true when the IP address belongs to a private / loopback /
 * link-local range that is unlikely to be reachable from outside the
 * deployment's own network. Coverage:
 *
 *   IPv4:
 *     10.0.0.0/8        — RFC 1918
 *     172.16.0.0/12     — RFC 1918
 *     192.168.0.0/16    — RFC 1918
 *     127.0.0.0/8       — loopback
 *     169.254.0.0/16    — link-local
 *     100.64.0.0/10     — CGNAT (RFC 6598)
 *
 *   IPv6:
 *     ::1               — loopback
 *     fc00::/7          — RFC 4193 ULA
 *     fe80::/10         — link-local
 */
export function isPrivateIP(addr) { ... }
```

Mirror the patterns from `backend/src/services/ssoConfigService.js`
`isPrivateIp` (which already exists for the SSRF guard).

### `frontend/src/components/servers/PrivateIPWarning.jsx` (NEW)
```jsx
function PrivateIPWarning({ ipAddress, variant = 'banner' }) {
  if (!ipAddress || !isPrivateIP(ipAddress)) return null;
  // banner: full-width amber alert above forms
  // pill: small inline badge for tables / hover cards
  ...
}
```

### Placements
1. `frontend/src/components/servers/QuickConnectModal.jsx` — banner
   above the Connect button, only when private
2. `frontend/src/components/access-requests/RequestForm.jsx` — banner
   above the form fields after a server is selected
3. `frontend/src/components/servers/ServerForm.jsx` — soft note
   under the IP field at create/edit time
4. `frontend/src/pages/ServerDetail.jsx` — banner in the header
   below the title

## Tests
- Vitest unit test for `isPrivateIP`: 10.x ✓, 172.16.x-172.31.x ✓,
  192.168.x ✓, 127.x ✓, 169.254.x ✓, 100.64.x ✓ (CGNAT), ::1 ✓,
  fc00::/7 ✓, fe80::/10 ✓; AND 8.8.8.8 ✗, 1.1.1.1 ✗, 172.32.0.1 ✗
  (just outside RFC 1918), 100.63.255.255 ✗ (just outside CGNAT).
- Visual: load any server with a 10.x IP, see the banner appear in
  all four placements.

## Acceptance
- `isPrivateIP` correctly classifies RFC 1918 + CGNAT + loopback +
  link-local for both IPv4 and IPv6
- Warning visible (and dismissible? — no, sticky) in all four
  placements when the IP is private
- Public IPs render no warning anywhere
