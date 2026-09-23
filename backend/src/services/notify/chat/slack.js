/**
 * slack — incoming webhooks, and the Web API when a bot token is configured.
 *
 * Two modes, because they are genuinely different capabilities:
 *
 *   `webhook`  an incoming-webhook URL. Posts to one channel and nothing else:
 *              no buttons, no direct messages, no editing a message later.
 *   `app`      a bot token. Everything above, plus approve/deny buttons and
 *              DMs — which is why Slack is the only platform here that gets
 *              them. Google Chat webhooks are one-way, and Teams Workflows
 *              webhooks post as the Flow bot with no interaction callback.
 *
 * ## The trap this file exists to avoid
 *
 * **Slack answers `chat.postMessage` with HTTP 200 and `{ok: false}`.** A
 * status-code-based error classifier — the one the audit sinks use, quite
 * correctly, for arbitrary HTTP collectors — reads every Slack failure as a
 * success. The consequence is the worst kind: the failure counter never
 * increments, the destination is never auto-disabled, the delivery log reads
 * "delivered", and an organisation believes its approvals are reaching Slack
 * while nothing has arrived for a week. So the body is parsed first, always,
 * and the `error` string decides.
 *
 * ## The other trap
 *
 * The webhook URL is itself a bearer credential: anyone holding it can post as
 * Shellius. It is therefore a secret field, unlike the audit sink's `url`,
 * which merely names a customer's own collector.
 */

import { fetchJson, postForm } from './http.js';
import { ChatConfigError, RetryableChatError, PermanentChatError } from './errors.js';
import { normalizeMessage, escapeSlack, SEVERITY_MARK, SEVERITY_COLOR } from './message.js';

export const platform = 'slack';
export const label = 'Slack';
/** Both the webhook URL and the bot token grant "post as Shellius". */
export const secretFields = ['url', 'botToken', 'signingSecret'];
export const supportsButtons = true;
export const supportsDirectMessages = true;

const API = 'https://slack.com/api';

/**
 * Slack error strings that mean the destination is broken rather than this
 * one message. These auto-disable it, with the reason shown in the UI.
 */
const FATAL = new Set([
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'not_authed',
  'channel_not_found',
  'is_archived',
  'not_in_channel',
  'invalid_blocks',
  'no_permission',
]);

export function validateConfig(config = {}) {
  const mode = config.mode === 'app' ? 'app' : 'webhook';
  if (mode === 'app') {
    const botToken = String(config.botToken || '').trim();
    const channel = String(config.channel || '').trim();
    if (!botToken.startsWith('xoxb-')) {
      throw new ChatConfigError('A Slack bot token starts with "xoxb-"');
    }
    if (!channel) throw new ChatConfigError('A channel is required (for example #security or a channel ID)');
    return {
      mode,
      botToken,
      channel,
      signingSecret: config.signingSecret ? String(config.signingSecret).trim() : undefined,
      workspaceId: config.workspaceId ? String(config.workspaceId).trim() : undefined,
    };
  }

  const url = String(config.url || '').trim();
  if (!url) throw new ChatConfigError('A Slack incoming webhook URL is required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ChatConfigError('That is not a valid URL');
  }
  // Host allowlist rather than an SSRF check: the destination is a known
  // service, so anything else is a misconfiguration or worse.
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'hooks.slack.com') {
    throw new ChatConfigError('A Slack webhook URL looks like https://hooks.slack.com/services/…');
  }
  return { mode, url };
}

/** Enough of the URL to tell two destinations apart, without the credential. */
export function describeConfig(config = {}) {
  if (config.mode === 'app') return config.channel ? `channel ${config.channel}` : 'Slack app';
  if (!config.url) return 'Slack webhook';
  const tail = String(config.url).split('/services/')[1] || '';
  return `hooks.slack.com/…/${tail.slice(0, 6)}…`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Block Kit. Field values use `plain_text` wherever they carry text that came
 * from a host or a person, so Slack does no markup on them at all.
 */
export function buildBlocks(msg, { actions = [] } = {}) {
  const m = normalizeMessage(msg);
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${SEVERITY_MARK[m.severity] ?? ''} ${m.title}`.trim().slice(0, 150), emoji: true },
    },
  ];

  if (m.summary) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: escapeSlack(m.summary) } });
  }

  if (m.fields.length) {
    // Slack allows ten fields in a section; the message model caps at ten too.
    blocks.push({
      type: 'section',
      fields: m.fields.map((f) => ({
        type: 'mrkdwn',
        text: `*${escapeSlack(f.label)}*\n${escapeSlack(f.value)}`,
      })),
    });
  }

  const elements = [];
  for (const action of actions) {
    elements.push({
      type: 'button',
      action_id: action.id,
      text: { type: 'plain_text', text: action.label, emoji: false },
      value: action.value,
      ...(action.style ? { style: action.style } : {}),
      ...(action.confirm
        ? {
            confirm: {
              title: { type: 'plain_text', text: action.confirm.title },
              text: { type: 'mrkdwn', text: escapeSlack(action.confirm.text) },
              confirm: { type: 'plain_text', text: action.confirm.ok },
              deny: { type: 'plain_text', text: 'Cancel' },
              ...(action.confirm.danger ? { style: 'danger' } : {}),
            },
          }
        : {}),
    });
  }
  if (m.url) {
    elements.push({
      type: 'button',
      action_id: 'open_in_shellius',
      text: { type: 'plain_text', text: 'Open in Shellius', emoji: false },
      url: m.url,
    });
  }
  if (elements.length) blocks.push({ type: 'actions', elements });

  return blocks;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Turn a Slack Web API response into the right kind of failure.
 * Exported because it is the piece most worth testing directly.
 */
export function classify(json) {
  const err = String(json?.error || 'unknown_error');
  if (err === 'ratelimited' || err === 'rate_limited') {
    return new RetryableChatError('Slack is rate limiting us', { retryAfterMs: null });
  }
  if (FATAL.has(err)) {
    return new PermanentChatError(`Slack rejected the message: ${err}`, { disable: true });
  }
  if (err === 'message_too_long' || err === 'invalid_arguments' || err === 'msg_too_long') {
    return new PermanentChatError(`Slack rejected the message: ${err}`);
  }
  // Unknown errors are worth one more try before giving up on them.
  return new RetryableChatError(`Slack returned ${err}`);
}

export async function deliver(config, message, { actions = [], channel = null } = {}) {
  const cfg = validateConfig(config);
  const blocks = buildBlocks(message, { actions });
  const text = normalizeMessage(message).title; // notification/fallback text

  if (cfg.mode === 'webhook') {
    // An incoming webhook answers with the literal body "ok", not JSON.
    const res = await postForm(cfg.url, JSON.stringify({ text, blocks }), {
      contentType: 'application/json',
      label: 'Slack',
    });
    if (res.status === 429) {
      throw new RetryableChatError('Slack is rate limiting this webhook', { retryAfterMs: res.retryAfterMs });
    }
    if (res.status >= 500) throw new RetryableChatError(`Slack returned ${res.status}`);
    if (res.status !== 200) {
      // 400 with "invalid_token" / 404 with "no_service" — the URL is dead.
      throw new PermanentChatError(`Slack rejected this webhook (${res.status}: ${res.body.slice(0, 120)})`, {
        disable: true,
      });
    }
    return { ok: true };
  }

  const json = await fetchJson(`${API}/chat.postMessage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: channel || cfg.channel, text, blocks }),
    label: 'Slack',
  });
  // HTTP 200 proves nothing here. The body decides.
  if (!json.ok) throw classify(json);
  return { ok: true, channel: json.channel, ts: json.ts };
}

/** Open a DM with one Slack user and post there. Bot token only. */
export async function deliverDirect(config, message, externalUserId, { actions = [] } = {}) {
  const cfg = validateConfig(config);
  if (cfg.mode !== 'app') throw new ChatConfigError('Direct messages need a Slack bot token');

  const open = await fetchJson(`${API}/conversations.open`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ users: externalUserId }),
    label: 'Slack',
  });
  if (!open.ok) throw classify(open);
  return deliver(config, message, { actions, channel: open.channel.id });
}

export async function test(config) {
  const cfg = validateConfig(config);
  if (cfg.mode === 'app') {
    const json = await fetchJson(`${API}/auth.test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: '{}',
      label: 'Slack',
    });
    if (!json.ok) throw classify(json);
    return { ok: true, detail: `Connected to ${json.team} as ${json.user}`, workspaceId: json.team_id };
  }
  await deliver(config, {
    title: 'Shellius test message',
    summary: 'If you can read this, this destination is working.',
    severity: 'info',
  });
  return { ok: true, detail: 'Posted a test message to the webhook' };
}

export default {
  platform,
  label,
  secretFields,
  supportsButtons,
  supportsDirectMessages,
  validateConfig,
  describeConfig,
  buildBlocks,
  classify,
  deliver,
  deliverDirect,
  test,
};
