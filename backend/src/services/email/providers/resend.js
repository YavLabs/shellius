/**
 * Resend adapter — POST /emails with a Bearer API key.
 */

import Joi from 'joi';
import { httpRequest, failFromResponse, formatAddress } from '../http.js';
import { validateWith, secret } from './common.js';

export const ENDPOINT = 'https://api.resend.com/emails';

const schema = Joi.object({
  apiKey: secret(500).required(),
});

export function validateConfig(config) {
  return validateWith(schema, config);
}

export async function send(config, message) {
  const res = await httpRequest(ENDPOINT, {
    label: 'Resend',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: formatAddress(message.from),
      to: message.to,
      subject: message.subject,
      html: message.html || undefined,
      text: message.text || undefined,
    }),
  });
  if (!res.ok) failFromResponse('Resend', res, (json) => json?.message || json?.error?.message);
  return { messageId: res.json?.id || null };
}

export default {
  type: 'resend',
  label: 'Resend',
  secretFields: ['apiKey'],
  requiresFromAddress: true,
  validateConfig,
  send,
};
