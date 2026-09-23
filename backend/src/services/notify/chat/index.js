/**
 * The chat adapter registry.
 *
 * Same shape as the audit sink and email provider registries. What differs
 * between these adapters is worth reading off the table rather than guessing:
 * only Slack, and only with a bot token, can carry a button that does
 * something or send a direct message. The other three post and that is all.
 */

import * as slack from './slack.js';
import * as googleChat from './googleChat.js';
import * as teams from './teams.js';
import * as webhook from './webhook.js';
import { ChatConfigError } from './errors.js';

export const ADAPTERS = {
  slack,
  google_chat: googleChat,
  teams,
  webhook,
};

export const PLATFORMS = Object.keys(ADAPTERS);

export function getAdapter(platform) {
  const adapter = ADAPTERS[platform];
  if (!adapter) throw new ChatConfigError(`Unknown chat platform '${platform}'`);
  return adapter;
}

/**
 * Can this destination carry an approve/deny button?
 *
 * Slack can, but only in `app` mode — an incoming webhook cannot receive the
 * press. Everything else gets a link.
 */
export const canAct = (platform, mode) => platform === 'slack' && mode === 'app';

/** `[{ platform, label, secretFields, supportsButtons, … }]` for the UI. */
export const describeAdapters = () =>
  PLATFORMS.map((p) => ({
    platform: p,
    label: ADAPTERS[p].label,
    secretFields: ADAPTERS[p].secretFields,
    supportsButtons: ADAPTERS[p].supportsButtons,
    supportsDirectMessages: ADAPTERS[p].supportsDirectMessages,
  }));

export default { ADAPTERS, PLATFORMS, getAdapter, canAct, describeAdapters };
