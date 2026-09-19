/**
 * Google adapter — Gmail API users.messages.send.
 *
 * Two modes:
 *   oauth           — "Connect Google account": an admin consents once with
 *                     scope gmail.send (offline access); the refresh token is
 *                     stored encrypted. Client ID/secret come from the
 *                     provider, or default to SSO_GOOGLE_CLIENT_ID/SECRET.
 *   service_account — Google Workspace domain-wide delegation: a service
 *                     account JSON key signs a JWT (RS256) for the delegated
 *                     sender mailbox. The key's own token_uri is ignored —
 *                     tokens are always requested from the fixed Google URL.
 *
 * The message is built as RFC 2822 by nodemailer's MailComposer and sent
 * base64url-encoded in `raw`.
 */

import Joi from 'joi';
import jwt from 'jsonwebtoken';
import MailComposer from 'nodemailer/lib/mail-composer';
import {
  httpRequest,
  failFromResponse,
  ProviderError,
  getCachedToken,
  setCachedToken,
} from '../http.js';
import { validateWith, secret, email, credentialKey, ProviderConfigError } from './common.js';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
// openid + email: the ID token in the code exchange names the connected
// account, so the UI can show "Connected as …" without reading the mailbox.
export const CONNECT_SCOPES = ['openid', 'email', GMAIL_SEND_SCOPE];

const schema = Joi.object({
  mode: Joi.string().valid('oauth', 'service_account').default('oauth'),
  clientId: Joi.string().trim().max(300).allow('', null),
  clientSecret: secret(1000).allow('', null),
  refreshToken: secret(4096).allow('', null),
  connectedEmail: email().allow('', null),
  serviceAccountJson: secret(20000).allow('', null),
  delegatedUser: email().allow('', null),
});

export function parseServiceAccount(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new ProviderConfigError('Service account key must be the JSON key file downloaded from Google Cloud');
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.client_email || !parsed.private_key) {
    throw new ProviderConfigError('Service account key JSON must contain client_email and private_key');
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(parsed.private_key)) {
    throw new ProviderConfigError('Service account private_key is not a PEM private key');
  }
  return parsed;
}

export function validateConfig(config) {
  const value = validateWith(schema, config);
  for (const k of ['clientId', 'clientSecret', 'refreshToken', 'connectedEmail', 'serviceAccountJson', 'delegatedUser']) {
    if (!value[k]) value[k] = null;
  }
  if (value.mode === 'service_account') {
    if (!value.serviceAccountJson) throw new ProviderConfigError('serviceAccountJson is required for a service account');
    parseServiceAccount(value.serviceAccountJson);
    if (!value.delegatedUser) throw new ProviderConfigError('delegatedUser (the Workspace mailbox to send as) is required');
  }
  return value;
}

/** OAuth client for the connect flow / refresh: provider values, else SSO_GOOGLE_* env. */
export function resolveOAuthClient(config) {
  const clientId = config.clientId || process.env.SSO_GOOGLE_CLIENT_ID || null;
  const clientSecret = config.clientSecret || process.env.SSO_GOOGLE_CLIENT_SECRET || null;
  return {
    clientId,
    clientSecret,
    fromEnv: !config.clientId && !!process.env.SSO_GOOGLE_CLIENT_ID,
  };
}

/** Why this config can't send yet (null when ready). */
export function notReadyReason(config) {
  if (config.mode === 'service_account') return null;
  const { clientId, clientSecret } = resolveOAuthClient(config);
  if (!clientId || !clientSecret) return 'Google OAuth client ID and secret are not set';
  if (!config.refreshToken) return 'Google account not connected — click "Connect Google account"';
  return null;
}

export function buildAuthUrl({ clientId, redirectUri, state, loginHint }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', CONNECT_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

const tokenError = (json) => (json?.error_description ? `${json.error}: ${json.error_description}` : json?.error);

/**
 * Exchange an authorization code. Returns { refreshToken, email, scope }.
 * The ID token comes straight from Google's token endpoint over TLS, so its
 * claims are read without re-verifying the signature (OIDC Core 3.1.3.7).
 */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await httpRequest(TOKEN_URL, {
    label: 'Google sign-in',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!res.ok) failFromResponse('Google sign-in', res, tokenError);
  const scope = String(res.json?.scope || '');
  if (!scope.split(/\s+/).includes(GMAIL_SEND_SCOPE)) {
    throw new ProviderError('Google sign-in: the "Send email on your behalf" permission was not granted', {
      code: 'SCOPE_MISSING',
    });
  }
  if (!res.json?.refresh_token) {
    throw new ProviderError('Google sign-in: no refresh token returned — remove Shellius from the account\'s third-party access and connect again', {
      code: 'NO_REFRESH_TOKEN',
    });
  }
  const claims = res.json.id_token ? jwt.decode(res.json.id_token) : null;
  return {
    refreshToken: res.json.refresh_token,
    email: claims?.email_verified === false ? null : claims?.email || null,
    scope,
  };
}

async function oauthAccessToken(config) {
  const { clientId, clientSecret } = resolveOAuthClient(config);
  const reason = notReadyReason(config);
  if (reason) throw new ProviderError(`Google: ${reason}`, { code: 'NOT_CONNECTED' });

  const key = `google:${credentialKey(clientId, clientSecret, config.refreshToken)}`;
  const cached = getCachedToken(key);
  if (cached) return cached;

  const res = await httpRequest(TOKEN_URL, {
    label: 'Google sign-in',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok || !res.json?.access_token) failFromResponse('Google sign-in', res, tokenError);
  setCachedToken(key, res.json.access_token, res.json.expires_in);
  return res.json.access_token;
}

async function serviceAccountAccessToken(config) {
  const sa = parseServiceAccount(config.serviceAccountJson);
  const key = `google-sa:${credentialKey(sa.client_email, sa.private_key_id, config.delegatedUser)}`;
  const cached = getCachedToken(key);
  if (cached) return cached;

  let assertion;
  try {
    assertion = jwt.sign(
      { iss: sa.client_email, sub: config.delegatedUser, scope: GMAIL_SEND_SCOPE, aud: TOKEN_URL },
      sa.private_key,
      { algorithm: 'RS256', expiresIn: 3600, ...(sa.private_key_id ? { keyid: sa.private_key_id } : {}) }
    );
  } catch {
    throw new ProviderError('Google: could not sign with the service account private key', { code: 'BAD_KEY' });
  }

  const res = await httpRequest(TOKEN_URL, {
    label: 'Google sign-in',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!res.ok || !res.json?.access_token) failFromResponse('Google sign-in', res, tokenError);
  setCachedToken(key, res.json.access_token, res.json.expires_in);
  return res.json.access_token;
}

export async function getAccessToken(config) {
  return config.mode === 'service_account' ? serviceAccountAccessToken(config) : oauthAccessToken(config);
}

/** RFC 2822 message, base64url-encoded for the Gmail `raw` field. */
export async function buildRawMessage(message) {
  const composer = new MailComposer({
    from: message.from.name ? { name: message.from.name, address: message.from.address } : message.from.address,
    to: message.to,
    subject: message.subject,
    text: message.text || undefined,
    html: message.html || undefined,
  });
  const buf = await composer.compile().build();
  return Buffer.from(buf).toString('base64url');
}

export async function send(config, message) {
  const token = await getAccessToken(config);
  const raw = await buildRawMessage(message);
  const res = await httpRequest(SEND_URL, {
    label: 'Gmail API',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) failFromResponse('Gmail API', res, (json) => json?.error?.message);
  return { messageId: res.json?.id || null };
}

export default {
  type: 'google',
  label: 'Google (Gmail API)',
  secretFields: ['clientSecret', 'refreshToken', 'serviceAccountJson'],
  // Set only by the OAuth callback — never accepted from the API.
  internalFields: ['refreshToken', 'connectedEmail'],
  validateConfig,
  notReadyReason,
  defaultFrom: (config) => (config.mode === 'service_account' ? config.delegatedUser : config.connectedEmail) || null,
  send,
};
