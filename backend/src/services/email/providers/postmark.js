/**
 * Postmark adapter — single-message Email API with a Server API token.
 */

import Joi from 'joi';
import { httpRequest, failFromResponse, formatAddress } from '../http.js';
import { validateWith, secret } from './common.js';

export const ENDPOINT = 'https://api.postmarkapp.com/email';

const schema = Joi.object({
  serverToken: secret(500).required(),
  messageStream: Joi.string().trim().max(100).pattern(/^[A-Za-z0-9_-]+$/).default('outbound'),
});

export function validateConfig(config) {
  return validateWith(schema, config);
}

export async function send(config, message) {
  const res = await httpRequest(ENDPOINT, {
    label: 'Postmark',
    headers: {
      'X-Postmark-Server-Token': config.serverToken,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      From: formatAddress(message.from),
      To: message.to.join(', '),
      Subject: message.subject,
      HtmlBody: message.html || undefined,
      TextBody: message.text || undefined,
      MessageStream: config.messageStream || 'outbound',
    }),
  });
  // Postmark reports some failures as 200 with a non-zero ErrorCode.
  if (!res.ok || (res.json && Number(res.json.ErrorCode) !== 0 && res.json.ErrorCode !== undefined)) {
    failFromResponse('Postmark', res, (json) =>
      json?.Message ? `${json.Message}${json.ErrorCode !== undefined ? ` (ErrorCode ${json.ErrorCode})` : ''}` : null
    );
  }
  return { messageId: res.json?.MessageID || null };
}

export default {
  type: 'postmark',
  label: 'Postmark',
  secretFields: ['serverToken'],
  requiresFromAddress: true,
  validateConfig,
  send,
};
