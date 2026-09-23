/**
 * teams — Microsoft Teams, via a Power Automate **Workflows** URL.
 *
 * Not via an Office 365 connector: those were retired in May 2026, so a
 * connector URL configured earlier has already stopped working. The
 * replacement is a "Post to a channel when a webhook request is received"
 * workflow, whose URL lives on logic.azure.com and carries a SAS signature in
 * its query string — which makes the URL the credential, and a secret field.
 *
 * The payload is an Adaptive Card. Its buttons can only open a link: a
 * workflow webhook posts as the Flow bot and has no way to send an
 * interaction back, so approve/deny in Teams would need a full bot
 * application. That is a separate build and is not attempted here.
 */

import { fetchJson } from './http.js';
import { ChatConfigError } from './errors.js';
import { normalizeMessage, escapeHtmlish, SEVERITY_MARK } from './message.js';

export const platform = 'teams';
export const label = 'Microsoft Teams';
export const secretFields = ['url'];
export const supportsButtons = false;
export const supportsDirectMessages = false;

/** Workflows URLs, and the older connector hosts we still recognise to warn. */
const WORKFLOW_HOSTS = /(^|\.)logic\.azure\.com$|(^|\.)azure\.com$/i;
const LEGACY_CONNECTOR_HOST = /(^|\.)webhook\.office\.com$/i;

export function validateConfig(config = {}) {
  const url = String(config.url || '').trim();
  if (!url) throw new ChatConfigError('A Teams workflow URL is required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ChatConfigError('That is not a valid URL');
  }
  if (parsed.protocol !== 'https:') throw new ChatConfigError('The URL must be https');
  if (LEGACY_CONNECTOR_HOST.test(parsed.hostname)) {
    throw new ChatConfigError(
      'That is an Office 365 connector URL. Connectors were retired in May 2026 — create a "Post to a channel when a webhook request is received" workflow in Teams and use its URL instead.'
    );
  }
  if (!WORKFLOW_HOSTS.test(parsed.hostname)) {
    throw new ChatConfigError('A Teams workflow URL is issued on logic.azure.com');
  }
  return { url };
}

export function describeConfig(config = {}) {
  if (!config.url) return 'Teams channel';
  try {
    return new URL(config.url).hostname;
  } catch {
    return 'Teams channel';
  }
}

export function buildCard(message) {
  const m = normalizeMessage(message);
  const body = [
    {
      type: 'TextBlock',
      size: 'Large',
      weight: 'Bolder',
      wrap: true,
      text: `${SEVERITY_MARK[m.severity] ?? ''} ${m.title}`.trim(),
    },
  ];
  if (m.summary) body.push({ type: 'TextBlock', wrap: true, text: escapeHtmlish(m.summary) });
  if (m.fields.length) {
    body.push({
      type: 'FactSet',
      facts: m.fields.map((f) => ({ title: escapeHtmlish(f.label), value: escapeHtmlish(f.value) })),
    });
  }

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
          ...(m.url
            ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in Shellius', url: m.url }] }
            : {}),
        },
      },
    ],
  };
}

export async function deliver(config, message) {
  const cfg = validateConfig(config);
  // A workflow answers 202 with an empty body on success.
  await fetchJson(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildCard(message)),
    label: 'Teams',
  });
  return { ok: true };
}

export async function test(config) {
  await deliver(config, {
    title: 'Shellius test message',
    summary: 'If you can read this, this destination is working.',
    severity: 'info',
  });
  return { ok: true, detail: 'Posted a test card to the workflow' };
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
