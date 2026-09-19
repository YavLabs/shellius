/**
 * SendGrid adapter — v3 Mail Send API. Region picks the fixed endpoint
 * (EU accounts must use the EU host; their keys are rejected by the US one).
 */

import Joi from 'joi';
import { httpRequest, failFromResponse } from '../http.js';
import { validateWith, secret } from './common.js';

export const ENDPOINTS = {
  us: 'https://api.sendgrid.com/v3/mail/send',
  eu: 'https://api.eu.sendgrid.com/v3/mail/send',
};

const schema = Joi.object({
  apiKey: secret(1000).required(),
  region: Joi.string().valid('us', 'eu').default('us'),
});

export function validateConfig(config) {
  return validateWith(schema, config);
}

export async function send(config, message) {
  const content = [];
  // SendGrid requires text/plain before text/html.
  if (message.text) content.push({ type: 'text/plain', value: message.text });
  if (message.html) content.push({ type: 'text/html', value: message.html });

  const res = await httpRequest(ENDPOINTS[config.region] || ENDPOINTS.us, {
    label: 'SendGrid',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: message.to.map((email) => ({ email })) }],
      from: message.from.name ? { email: message.from.address, name: message.from.name } : { email: message.from.address },
      subject: message.subject,
      content,
    }),
  });
  if (!res.ok) {
    failFromResponse('SendGrid', res, (json) =>
      Array.isArray(json?.errors) ? json.errors.map((e) => e.message).filter(Boolean).join('; ') : null
    );
  }
  return { messageId: null };
}

export default {
  type: 'sendgrid',
  label: 'SendGrid',
  secretFields: ['apiKey'],
  requiresFromAddress: true,
  validateConfig,
  send,
};
