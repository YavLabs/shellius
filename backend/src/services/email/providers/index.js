/**
 * Email provider registry. Each adapter exposes:
 *   type, label
 *   secretFields      — config keys that are secrets (encrypted, never returned)
 *   internalFields    — config keys only the server sets (never accepted from the API)
 *   requiresFromAddress — provider has no implicit sender, so fromAddress is required
 *   validateConfig(config) → normalised config (throws ProviderConfigError)
 *   notReadyReason?(config) → string | null (e.g. Google not yet connected)
 *   defaultFrom?(config) → sender address when the provider has none set
 *   send(config, { from: {name,address}, to: string[], subject, html, text }) → { messageId }
 */

import smtp from './smtp.js';
import google from './google.js';
import microsoft from './microsoft.js';
import sendgrid from './sendgrid.js';
import mailgun from './mailgun.js';
import postmark from './postmark.js';
import resend from './resend.js';
import { recipients } from '../http.js';

export const ADAPTERS = { smtp, google, microsoft, sendgrid, mailgun, postmark, resend };
export const PROVIDER_TYPES = Object.keys(ADAPTERS);

export function getAdapter(type) {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`Unknown email provider type: ${type}`);
  return adapter;
}

export const FALLBACK_FROM = 'noreply@shellius.local';

/** Sender for a provider: its fromAddress, else the adapter's implicit sender. */
export function resolveFrom({ type, config, fromAddress, fromName }) {
  const adapter = getAdapter(type);
  const address = fromAddress || adapter.defaultFrom?.(config || {}) || FALLBACK_FROM;
  return { name: fromName || null, address };
}

/**
 * Send one message through a provider definition
 * ({ type, config (decrypted), fromAddress, fromName }).
 * Throws ProviderError on failure.
 */
export async function sendWith(provider, { to, subject, html, text }) {
  const adapter = getAdapter(provider.type);
  const list = recipients(to);
  if (list.length === 0) throw new Error('No recipient');
  return adapter.send(provider.config, {
    from: resolveFrom(provider),
    to: list,
    subject,
    html,
    text,
  });
}

export default { ADAPTERS, PROVIDER_TYPES, getAdapter, resolveFrom, sendWith };
