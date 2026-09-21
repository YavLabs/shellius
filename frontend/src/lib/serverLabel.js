/**
 * lib/serverLabel.js — single source of truth for how a server is labeled
 * anywhere it's rendered with less than the full ServerDetail page: the
 * display name (falling back to hostname, then a raw id) as the primary
 * label, with the hostname/IP as secondary, muted text when it adds
 * information beyond the primary label.
 *
 * components/shared/ServerName.jsx renders this; use these when you only
 * need the strings (search accessors, plain-text fallbacks, titles).
 */

/** The name a user should read as "this server" — never a bare hostname. */
export function serverPrimaryLabel(server, fallback = '-') {
  if (!server) return fallback;
  return server.displayName || server.hostname || server.name || fallback;
}

/** Hostname/IP shown under the primary label, or '' when it repeats it. */
export function serverSecondaryLabel(server) {
  if (!server) return '';
  const primary = serverPrimaryLabel(server, '');
  if (server.hostname && server.hostname !== primary) return server.hostname;
  if (server.ipAddress && server.ipAddress !== primary) return server.ipAddress;
  return '';
}

/** Build a search string covering both display name and hostname/IP. */
export function serverSearchString(server) {
  if (!server) return '';
  return [server.displayName, server.hostname, server.ipAddress, server.name, server.environment]
    .filter(Boolean)
    .join(' ');
}

/** "Display name (hostname)" — for places that only have room for one line. */
export function serverInlineLabel(server, fallback = '-') {
  const primary = serverPrimaryLabel(server, fallback);
  const secondary = serverSecondaryLabel(server);
  return secondary ? `${primary} (${secondary})` : primary;
}
