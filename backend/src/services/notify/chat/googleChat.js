/**
 * google_chat — an incoming webhook into one space, rendered as a Cards v2
 * card.
 *
 * A Google Chat incoming webhook is one-way by design: it can post, and it
 * cannot receive anything back. Buttons that *do* something need a full Chat
 * app with its own endpoint, which is a separate build per platform. So the
 * card here carries one button and it opens Shellius — no approve/deny.
 *
 * Like Slack, a failure can arrive as HTTP 200 with an `error` object in the
 * body, so the body is inspected rather than trusted.
 *
 * The webhook URL carries `key` and `token` query parameters and is therefore
 * the credential itself, not merely an address.
 */

import { fetchJson } from './http.js';
import { ChatConfigError, PermanentChatError, RetryableChatError } from './errors.js';
import { normalizeMessage, escapeHtmlish, SEVERITY_MARK } from './message.js';

export const platform = 'google_chat';
export const label = 'Google Chat';
export const secretFields = ['url'];
export const supportsButtons = false;
export const supportsDirectMessages = false;

export function validateConfig(config = {}) {
  const url = String(config.url || '').trim();
  if (!url) throw new ChatConfigError('A Google Chat webhook URL is required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ChatConfigError('That is not a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'chat.googleapis.com') {
    throw new ChatConfigError('A Google Chat webhook URL looks like https://chat.googleapis.com/v1/spaces/…');
  }
  return { url };
}

export function describeConfig(config = {}) {
  if (!config.url) return 'Google Chat space';
  const m = String(config.url).match(/spaces\/([^/?]+)/);
  return m ? `space ${m[1]}` : 'Google Chat space';
}

export function buildCard(message) {
  const m = normalizeMessage(message);
  const widgets = [];
  if (m.summary) {
    widgets.push({ textParagraph: { text: escapeHtmlish(m.summary) } });
  }
  for (const f of m.fields) {
    widgets.push({
      decoratedText: { topLabel: escapeHtmlish(f.label), text: escapeHtmlish(f.value), wrapText: true },
    });
  }
  if (m.url) {
    widgets.push({
      buttonList: { buttons: [{ text: 'Open in Shellius', onClick: { openLink: { url: m.url } } }] },
    });
  }

  return {
    cardsV2: [
      {
        cardId: 'shellius',
        card: {
          header: { title: `${SEVERITY_MARK[m.severity] ?? ''} ${m.title}`.trim() },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

export async function deliver(config, message) {
  const cfg = validateConfig(config);
  const json = await fetchJson(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(buildCard(message)),
    label: 'Google Chat',
  });
  // Google answers a rejected card with 200 and an `error` object.
  if (json.error) {
    const code = json.error.code;
    if (code === 429 || code === 503) throw new RetryableChatError(`Google Chat: ${json.error.message}`);
    throw new PermanentChatError(`Google Chat rejected the message: ${json.error.message}`, {
      disable: code === 403 || code === 404,
    });
  }
  return { ok: true, messageName: json.name ?? null };
}

export async function test(config) {
  await deliver(config, {
    title: 'Shellius test message',
    summary: 'If you can read this, this destination is working.',
    severity: 'info',
  });
  return { ok: true, detail: 'Posted a test card to the space' };
}

export default {
  platform,
  label,
  secretFields,
  supportsButtons,
  supportsDirectMessages,
  validateConfig,
  describeConfig,
  buildCard,
  deliver,
  test,
};
