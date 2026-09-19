/**
 * Mailgun adapter — Messages API (form-encoded, HTTP Basic "api:<key>").
 * The sending domain is a path segment on a fixed regional host, restricted
 * to a hostname and URL-encoded, so it can't redirect the request elsewhere.
 */

import Joi from 'joi';
import { httpRequest, failFromResponse, formatAddress } from '../http.js';
import { validateWith, secret, hostname } from './common.js';

export const BASES = {
  us: 'https://api.mailgun.net',
  eu: 'https://api.eu.mailgun.net',
};

const schema = Joi.object({
  apiKey: secret(1000).required(),
  domain: hostname().required(),
  region: Joi.string().valid('us', 'eu').default('us'),
});

export function validateConfig(config) {
  return validateWith(schema, config);
}

export function endpoint(config) {
  return `${BASES[config.region] || BASES.us}/v3/${encodeURIComponent(config.domain)}/messages`;
}

export async function send(config, message) {
  const form = new URLSearchParams();
  form.set('from', formatAddress(message.from));
  for (const to of message.to) form.append('to', to);
  form.set('subject', message.subject);
  if (message.text) form.set('text', message.text);
  if (message.html) form.set('html', message.html);

  const res = await httpRequest(endpoint(config), {
    label: 'Mailgun',
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${config.apiKey}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) failFromResponse('Mailgun', res, (json) => json?.message);
  return { messageId: res.json?.id || null };
}

export default {
  type: 'mailgun',
  label: 'Mailgun',
  secretFields: ['apiKey'],
  requiresFromAddress: true,
  validateConfig,
  send,
};
