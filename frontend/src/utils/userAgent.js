/**
 * userAgent.js — tiny, dependency-free parser for the device/browser summary
 * shown on the "Active sessions" card. Not exhaustive — good enough to turn
 * a raw UA string into something a human recognizes at a glance.
 */

const BROWSERS = [
  { re: /Edg\/([\d.]+)/, name: 'Edge' },
  { re: /OPR\/([\d.]+)/, name: 'Opera' },
  { re: /Firefox\/([\d.]+)/, name: 'Firefox' },
  { re: /CriOS\/([\d.]+)/, name: 'Chrome' },
  { re: /Chrome\/([\d.]+)/, name: 'Chrome' },
  { re: /Version\/([\d.]+).*Safari/, name: 'Safari' },
  { re: /Safari\//, name: 'Safari' },
];

const OS_LIST = [
  { re: /Windows NT 10\.0/, name: 'Windows 10/11' },
  { re: /Windows NT/, name: 'Windows' },
  { re: /Mac OS X ([\d_]+)/, name: 'macOS' },
  { re: /iPhone OS ([\d_]+)/, name: 'iOS' },
  { re: /iPad/, name: 'iPadOS' },
  { re: /Android ([\d.]+)/, name: 'Android' },
  { re: /CrOS/, name: 'ChromeOS' },
  { re: /Linux/, name: 'Linux' },
];

/**
 * parseUserAgent — best-effort browser + OS summary for a User-Agent string.
 * Returns { browser, os, label, isMobile } — `label` is the human string to
 * render directly (e.g. "Chrome on macOS").
 */
export function parseUserAgent(ua) {
  if (!ua || typeof ua !== 'string') {
    return { browser: null, os: null, label: 'Unknown device', isMobile: false };
  }

  // Non-browser API clients (TUI, CLI, scripts) — surface the raw token.
  const cliMatch = ua.match(/^([A-Za-z0-9._-]+)\/([\d.]+)/);
  if (!/Mozilla|Mobile/i.test(ua) && cliMatch) {
    return { browser: cliMatch[1], os: null, label: ua.slice(0, 60), isMobile: false, isCli: true };
  }

  const browser = BROWSERS.find((b) => b.re.test(ua))?.name || null;
  const os = OS_LIST.find((o) => o.re.test(ua))?.name || null;
  const isMobile = /Mobile|Android|iPhone|iPad/.test(ua);

  let label = 'Unknown device';
  if (browser && os) label = `${browser} on ${os}`;
  else if (browser) label = browser;
  else if (os) label = os;

  return { browser, os, label, isMobile, isCli: false };
}

/** clientType is reported by the API ('web' | 'cli' | ...) — fall back to UA sniffing. */
export function describeSession(session) {
  if (session?.clientType && session.clientType !== 'web') {
    return { label: session.clientType.toUpperCase(), isCli: true, isMobile: false };
  }
  const parsed = parseUserAgent(session?.userAgent);
  return parsed;
}
