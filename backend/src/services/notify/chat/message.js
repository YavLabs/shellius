/**
 * The neutral message, and the rules for getting text safely into a chat
 * platform.
 *
 * Every adapter renders from this one shape, which is the chat analogue of
 * `email/index.js`'s templates:
 *
 *   { title, summary, fields: [{label, value}], severity, url, actions }
 *
 * ## Why the escaping matters here
 *
 * Posture findings carry process names and unix usernames read off a
 * monitored host, and an access request carries a reason somebody typed. The
 * email path already escapes these — `postureAlertService` has a comment
 * saying exactly why. Chat needs the same care for a different reason: Slack's
 * `mrkdwn` will render `<!channel>` as a broadcast ping and `<http://x|OK>` as
 * a disguised link, so a compromised host could use a process name to notify
 * everyone in a channel, or to put a plausible-looking link in front of an
 * administrator.
 *
 * The defence is twofold: escape the three characters Slack treats as special,
 * and prefer `plain_text` blocks — which do no markup at all — for anything
 * that did not originate in Shellius's own source.
 *
 * ## Why the truncation matters
 *
 * Slack rejects a `text` object over 3000 characters, and rejects the whole
 * message rather than trimming it. One long finding would therefore silently
 * deliver nothing. Everything is truncated on the way in, with the full detail
 * one click away in Shellius.
 */

/** Slack's limit is 3000; leave room for the surrounding block. */
export const MAX_TEXT = 2500;
/** A single field value should stay scannable. */
export const MAX_FIELD = 400;

/**
 * Escape the characters Slack's mrkdwn parser treats as control characters.
 * Slack's own guidance: only these three, and only these three.
 */
export function escapeSlack(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Google Chat and Teams render HTML-ish markup in some surfaces. */
export function escapeHtmlish(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function truncate(value, max = MAX_TEXT) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Normalise whatever a call site passed into the shape every adapter expects,
 * with every string bounded. Adapters escape; this one only trims and bounds,
 * because the escaping rules differ per platform.
 */
export function normalizeMessage({ title, summary, fields = [], severity = 'info', url = null, actions = [] } = {}) {
  return {
    title: truncate(title, 300),
    summary: truncate(summary, MAX_TEXT),
    fields: fields
      .filter((f) => f && f.label && f.value !== undefined && f.value !== null && f.value !== '')
      .slice(0, 10)
      .map((f) => ({ label: truncate(f.label, 80), value: truncate(String(f.value), MAX_FIELD) })),
    severity,
    url,
    actions: actions.slice(0, 5),
  };
}

/** A leading marker, so severity survives platforms with no colour to give. */
export const SEVERITY_MARK = {
  info: 'ℹ️',
  notice: '🔔',
  warning: '⚠️',
  critical: '🚨',
};

/** Slack attachment / Google Chat accent colours. */
export const SEVERITY_COLOR = {
  info: '#6b7280',
  notice: '#2563eb',
  warning: '#d97706',
  critical: '#dc2626',
};

export default {
  normalizeMessage,
  escapeSlack,
  escapeHtmlish,
  truncate,
  SEVERITY_MARK,
  SEVERITY_COLOR,
  MAX_TEXT,
  MAX_FIELD,
};
