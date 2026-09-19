/**
 * Microsoft 365 adapter — Microsoft Graph sendMail with app-only (client
 * credentials) auth.
 *
 * Entra ID setup: register an app, add the Microsoft Graph APPLICATION
 * permission Mail.Send, grant admin consent, create a client secret. Scope
 * it to the sending mailbox with an Exchange application access policy /
 * RBAC for Applications (otherwise the app may send as any mailbox).
 *
 * Tokens are cached until shortly before expiry.
 */

import Joi from 'joi';
import {
  httpRequest,
  failFromResponse,
  ProviderError,
  getCachedToken,
  setCachedToken,
} from '../http.js';
import { validateWith, secret, email, credentialKey } from './common.js';

export const LOGIN_BASE = 'https://login.microsoftonline.com';
export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
export const SCOPE = 'https://graph.microsoft.com/.default';

const schema = Joi.object({
  // Directory (tenant) ID — a GUID or a verified domain (contoso.onmicrosoft.com).
  tenantId: Joi.string()
    .trim()
    .max(253)
    .pattern(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, 'tenant ID or domain')
    .required(),
  clientId: Joi.string().trim().max(100).pattern(/^[A-Za-z0-9-]+$/, 'application (client) ID').required(),
  clientSecret: secret(1000).required(),
  sender: email().required(),
});

export function validateConfig(config) {
  return validateWith(schema, config);
}

export function tokenUrl(tenantId) {
  return `${LOGIN_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

export function sendMailUrl(sender) {
  return `${GRAPH_BASE}/users/${encodeURIComponent(sender)}/sendMail`;
}

export async function getAccessToken(config) {
  const key = `microsoft:${credentialKey(config.tenantId, config.clientId, config.clientSecret)}`;
  const cached = getCachedToken(key);
  if (cached) return cached;

  const res = await httpRequest(tokenUrl(config.tenantId), {
    label: 'Microsoft sign-in',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: SCOPE,
      grant_type: 'client_credentials',
    }).toString(),
  });
  if (!res.ok || !res.json?.access_token) {
    failFromResponse('Microsoft sign-in', res, (json) =>
      // error_description starts with an AADSTS code, e.g. "AADSTS7000215: Invalid client secret provided."
      json?.error_description ? String(json.error_description).split(/\r?\n/)[0] : json?.error
    );
  }
  setCachedToken(key, res.json.access_token, res.json.expires_in);
  return res.json.access_token;
}

export async function send(config, message) {
  const token = await getAccessToken(config);
  const res = await httpRequest(sendMailUrl(config.sender), {
    label: 'Microsoft Graph',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject: message.subject,
        body: message.html
          ? { contentType: 'HTML', content: message.html }
          : { contentType: 'Text', content: message.text || '' },
        toRecipients: message.to.map((address) => ({ emailAddress: { address } })),
        from: { emailAddress: { address: message.from.address, ...(message.from.name ? { name: message.from.name } : {}) } },
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) {
    failFromResponse('Microsoft Graph', res, (json) => {
      const e = json?.error;
      if (!e) return null;
      return e.code ? `${e.code}: ${e.message}` : e.message;
    });
  }
  if (res.status !== 202 && res.status !== 200) {
    throw new ProviderError(`Microsoft Graph: unexpected HTTP ${res.status}`, { status: res.status });
  }
  return { messageId: null };
}

export default {
  type: 'microsoft',
  label: 'Microsoft 365 (Graph)',
  secretFields: ['clientSecret'],
  validateConfig,
  defaultFrom: (config) => config.sender || null,
  send,
};
