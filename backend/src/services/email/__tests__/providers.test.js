/**
 * Email provider adapters — request shape, auth headers, error mapping,
 * config validation. All network calls go through a mocked global.fetch;
 * no live network or DB.
 */

import crypto from 'crypto';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { ADAPTERS, PROVIDER_TYPES, sendWith, resolveFrom } from '../providers/index.js';
import { transportOptions, validateConfig as validateSmtp } from '../providers/smtp.js';
import * as google from '../providers/google.js';
import * as microsoft from '../providers/microsoft.js';
import { clearTokenCache, ProviderError, formatAddress } from '../http.js';
import { ProviderConfigError } from '../providers/common.js';
import { envSmtpProvider } from '../envSmtp.js';

const MESSAGE = { to: 'dest@example.com', subject: 'Hello', html: '<p>Hi</p>', text: 'Hi' };

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

let fetchMock;
const realFetch = global.fetch;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  clearTokenCache();
});

afterAll(() => {
  global.fetch = realFetch;
});

function call(i = 0) {
  const [url, init] = fetchMock.mock.calls[i];
  return { url, init, body: init.body };
}

describe('registry', () => {
  test('exposes all seven provider types', () => {
    expect(PROVIDER_TYPES.sort()).toEqual(['google', 'mailgun', 'microsoft', 'postmark', 'resend', 'sendgrid', 'smtp']);
    for (const t of PROVIDER_TYPES) {
      expect(typeof ADAPTERS[t].send).toBe('function');
      expect(typeof ADAPTERS[t].validateConfig).toBe('function');
      expect(Array.isArray(ADAPTERS[t].secretFields)).toBe(true);
    }
  });

  test('resolveFrom uses fromAddress, then the adapter default, then a fallback', () => {
    expect(resolveFrom({ type: 'resend', config: {}, fromAddress: 'a@x.io', fromName: 'A' })).toEqual({ name: 'A', address: 'a@x.io' });
    expect(resolveFrom({ type: 'microsoft', config: { sender: 'mbox@x.io' } }).address).toBe('mbox@x.io');
    expect(resolveFrom({ type: 'google', config: { mode: 'oauth', connectedEmail: 'g@x.io' } }).address).toBe('g@x.io');
    expect(resolveFrom({ type: 'resend', config: {} }).address).toBe('noreply@shellius.local');
  });

  test('formatAddress quotes display names', () => {
    expect(formatAddress({ name: 'Ops "Team"', address: 'o@x.io' })).toBe('"Ops \\"Team\\"" <o@x.io>');
    expect(formatAddress({ address: 'o@x.io' })).toBe('o@x.io');
  });

  test('every request carries a timeout signal and refuses redirects', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'x' }));
    await sendWith({ type: 'resend', config: { apiKey: 're_1' }, fromAddress: 'a@x.io' }, MESSAGE);
    const { init } = call();
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });

  test('a timeout becomes a ProviderError with a readable message', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    await expect(sendWith({ type: 'resend', config: { apiKey: 're_1' }, fromAddress: 'a@x.io' }, MESSAGE)).rejects.toThrow(
      /Resend: request timed out after 15s/
    );
  });
});

describe('SendGrid', () => {
  const cfg = { apiKey: 'SG.secret', region: 'us' };

  test('posts v3 mail/send with Bearer key, text before html', async () => {
    fetchMock.mockResolvedValue(jsonResponse(202));
    await sendWith({ type: 'sendgrid', config: cfg, fromAddress: 'noreply@x.io', fromName: 'Shellius' }, MESSAGE);
    const { url, init, body } = call();
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer SG.secret');
    const parsed = JSON.parse(body);
    expect(parsed.personalizations).toEqual([{ to: [{ email: 'dest@example.com' }] }]);
    expect(parsed.from).toEqual({ email: 'noreply@x.io', name: 'Shellius' });
    expect(parsed.content.map((c) => c.type)).toEqual(['text/plain', 'text/html']);
  });

  test('EU region uses the EU host', async () => {
    fetchMock.mockResolvedValue(jsonResponse(202));
    await sendWith({ type: 'sendgrid', config: { ...cfg, region: 'eu' }, fromAddress: 'a@x.io' }, MESSAGE);
    expect(call().url).toBe('https://api.eu.sendgrid.com/v3/mail/send');
  });

  test('maps errors[].message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { errors: [{ message: 'The provided authorization grant is invalid' }] }));
    const err = await sendWith({ type: 'sendgrid', config: cfg, fromAddress: 'a@x.io' }, MESSAGE).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe('SendGrid error (HTTP 401): The provided authorization grant is invalid');
    expect(err.message).not.toContain('SG.secret');
  });

  test('validateConfig requires apiKey and a known region', () => {
    expect(() => ADAPTERS.sendgrid.validateConfig({})).toThrow(ProviderConfigError);
    expect(() => ADAPTERS.sendgrid.validateConfig({ apiKey: 'k', region: 'apac' })).toThrow(ProviderConfigError);
    expect(ADAPTERS.sendgrid.validateConfig({ apiKey: 'k' }).region).toBe('us');
  });
});

describe('Mailgun', () => {
  const cfg = { apiKey: 'key-secret', domain: 'mg.example.com', region: 'eu' };

  test('posts form data to the regional host with Basic api:key', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: '<1@mg>', message: 'Queued. Thank you.' }));
    const res = await sendWith({ type: 'mailgun', config: cfg, fromAddress: 'noreply@x.io', fromName: 'Shellius' }, MESSAGE);
    const { url, init, body } = call();
    expect(url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('api:key-secret').toString('base64')}`);
    const form = new URLSearchParams(body);
    expect(form.get('from')).toBe('"Shellius" <noreply@x.io>');
    expect(form.getAll('to')).toEqual(['dest@example.com']);
    expect(form.get('subject')).toBe('Hello');
    expect(form.get('html')).toBe('<p>Hi</p>');
    expect(res.messageId).toBe('<1@mg>');
  });

  test('maps { message } errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { message: 'Domain not found' }));
    await expect(sendWith({ type: 'mailgun', config: cfg, fromAddress: 'a@x.io' }, MESSAGE)).rejects.toThrow(
      'Mailgun error (HTTP 403): Domain not found'
    );
  });

  test('domain must be a hostname (no path / URL injection)', () => {
    expect(() => ADAPTERS.mailgun.validateConfig({ apiKey: 'k', domain: 'evil.com/../x' })).toThrow(ProviderConfigError);
    expect(() => ADAPTERS.mailgun.validateConfig({ apiKey: 'k', domain: 'https://evil.com' })).toThrow(ProviderConfigError);
  });
});

describe('Postmark', () => {
  const cfg = { serverToken: 'pm-secret', messageStream: 'outbound' };

  test('posts with X-Postmark-Server-Token and MessageStream', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ErrorCode: 0, MessageID: 'm1' }));
    await sendWith({ type: 'postmark', config: cfg, fromAddress: 'a@x.io' }, MESSAGE);
    const { url, init, body } = call();
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect(init.headers['X-Postmark-Server-Token']).toBe('pm-secret');
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ From: 'a@x.io', To: 'dest@example.com', Subject: 'Hello', HtmlBody: '<p>Hi</p>', TextBody: 'Hi', MessageStream: 'outbound' });
  });

  test('maps Message + ErrorCode', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { ErrorCode: 300, Message: 'Invalid email request' }));
    await expect(sendWith({ type: 'postmark', config: cfg, fromAddress: 'a@x.io' }, MESSAGE)).rejects.toThrow(
      'Postmark error (HTTP 422): Invalid email request (ErrorCode 300)'
    );
  });
});

describe('Resend', () => {
  test('posts JSON with Bearer key', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'r1' }));
    await sendWith({ type: 'resend', config: { apiKey: 're_secret' }, fromAddress: 'a@x.io', fromName: 'S' }, MESSAGE);
    const { url, init, body } = call();
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_secret');
    expect(JSON.parse(body)).toMatchObject({ from: '"S" <a@x.io>', to: ['dest@example.com'], subject: 'Hello' });
  });

  test('maps { message } errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { name: 'validation_error', message: 'The x.io domain is not verified.' }));
    await expect(sendWith({ type: 'resend', config: { apiKey: 'k' }, fromAddress: 'a@x.io' }, MESSAGE)).rejects.toThrow(
      'Resend error (HTTP 403): The x.io domain is not verified.'
    );
  });

  test('non-JSON error bodies are truncated, not dumped', async () => {
    fetchMock.mockResolvedValue(jsonResponse(502, `<html>${'x'.repeat(2000)}</html>`));
    const err = await sendWith({ type: 'resend', config: { apiKey: 'k' }, fromAddress: 'a@x.io' }, MESSAGE).catch((e) => e);
    expect(err.message.length).toBeLessThan(600);
  });
});

describe('Microsoft Graph', () => {
  const cfg = {
    tenantId: 'contoso.onmicrosoft.com',
    clientId: '11111111-2222-3333-4444-555555555555',
    clientSecret: 'ms-secret',
    sender: 'alerts@contoso.com',
  };

  test('client-credentials token, then sendMail as the sender mailbox', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'AT1', expires_in: 3599 }))
      .mockResolvedValueOnce(jsonResponse(202));
    await sendWith({ type: 'microsoft', config: cfg, fromName: 'Shellius' }, MESSAGE);

    const token = call(0);
    expect(token.url).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token');
    const form = new URLSearchParams(token.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(form.get('client_secret')).toBe('ms-secret');

    const send = call(1);
    expect(send.url).toBe('https://graph.microsoft.com/v1.0/users/alerts%40contoso.com/sendMail');
    expect(send.init.headers.Authorization).toBe('Bearer AT1');
    const body = JSON.parse(send.body);
    expect(body.message.body).toEqual({ contentType: 'HTML', content: '<p>Hi</p>' });
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'dest@example.com' } }]);
    expect(body.message.from.emailAddress).toEqual({ address: 'alerts@contoso.com', name: 'Shellius' });
  });

  test('caches the token until expiry', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'AT1', expires_in: 3599 }))
      .mockResolvedValue(jsonResponse(202));
    await sendWith({ type: 'microsoft', config: cfg }, MESSAGE);
    await sendWith({ type: 'microsoft', config: cfg }, MESSAGE);
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => u.includes('login.microsoftonline.com'));
    expect(tokenCalls).toHaveLength(1);
  });

  test('a changed secret does not reuse the cached token', async () => {
    fetchMock.mockImplementation(async (u) =>
      u.includes('login.') ? jsonResponse(200, { access_token: 'AT', expires_in: 3599 }) : jsonResponse(202)
    );
    await sendWith({ type: 'microsoft', config: cfg }, MESSAGE);
    await sendWith({ type: 'microsoft', config: { ...cfg, clientSecret: 'other' } }, MESSAGE);
    expect(fetchMock.mock.calls.filter(([u]) => u.includes('login.'))).toHaveLength(2);
  });

  test('maps AADSTS token errors (first line only)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: abc' })
    );
    await expect(sendWith({ type: 'microsoft', config: cfg }, MESSAGE)).rejects.toThrow(
      'Microsoft sign-in error (HTTP 401): AADSTS7000215: Invalid client secret provided.'
    );
  });

  test('maps Graph error.code / message', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'AT1', expires_in: 3599 }))
      .mockResolvedValueOnce(jsonResponse(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }));
    await expect(sendWith({ type: 'microsoft', config: cfg }, MESSAGE)).rejects.toThrow(
      'Microsoft Graph error (HTTP 403): ErrorAccessDenied: Access is denied.'
    );
  });

  test('tenant id cannot smuggle a path', () => {
    expect(() => microsoft.validateConfig({ ...cfg, tenantId: '../evil' })).toThrow(ProviderConfigError);
    expect(() => microsoft.validateConfig({ ...cfg, tenantId: 'x/y' })).toThrow(ProviderConfigError);
  });
});

describe('Google (Gmail API)', () => {
  const oauthCfg = {
    mode: 'oauth',
    clientId: 'cid.apps.googleusercontent.com',
    clientSecret: 'g-secret',
    refreshToken: 'refresh-1',
    connectedEmail: 'ops@example.com',
  };

  test('refreshes an access token and sends a base64url RFC 2822 message', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'GAT', expires_in: 3599 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'gm1' }));
    const res = await sendWith({ type: 'google', config: oauthCfg, fromName: 'Shellius' }, MESSAGE);
    expect(res.messageId).toBe('gm1');

    const token = call(0);
    expect(token.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(token.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('refresh-1');

    const send = call(1);
    expect(send.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(send.init.headers.Authorization).toBe('Bearer GAT');
    const raw = Buffer.from(JSON.parse(send.body).raw, 'base64url').toString('utf8');
    expect(raw).toMatch(/^From: "?Shellius"? <ops@example.com>/m);
    expect(raw).toMatch(/^To: dest@example.com/m);
    expect(raw).toMatch(/^Subject: Hello/m);
    expect(raw).toContain('multipart/alternative');
  });

  test('not connected → clear error, no network call', async () => {
    const err = await sendWith({ type: 'google', config: { ...oauthCfg, refreshToken: null } }, MESSAGE).catch((e) => e);
    expect(err.message).toMatch(/not connected/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('falls back to SSO_GOOGLE_* for the OAuth client', () => {
    const saved = { id: process.env.SSO_GOOGLE_CLIENT_ID, secret: process.env.SSO_GOOGLE_CLIENT_SECRET };
    process.env.SSO_GOOGLE_CLIENT_ID = 'env-cid';
    process.env.SSO_GOOGLE_CLIENT_SECRET = 'env-secret';
    try {
      const c = google.resolveOAuthClient({ clientId: null, clientSecret: null });
      expect(c).toEqual({ clientId: 'env-cid', clientSecret: 'env-secret', fromEnv: true });
      expect(google.resolveOAuthClient({ clientId: 'own', clientSecret: 's' }).fromEnv).toBe(false);
    } finally {
      if (saved.id === undefined) delete process.env.SSO_GOOGLE_CLIENT_ID;
      else process.env.SSO_GOOGLE_CLIENT_ID = saved.id;
      if (saved.secret === undefined) delete process.env.SSO_GOOGLE_CLIENT_SECRET;
      else process.env.SSO_GOOGLE_CLIENT_SECRET = saved.secret;
    }
  });

  test('buildAuthUrl asks for gmail.send, offline access and consent', () => {
    const url = new URL(google.buildAuthUrl({ clientId: 'cid', redirectUri: 'https://app.x/api/settings/email/google/callback', state: 's1' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope').split(' ')).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  test('exchangeCode returns the refresh token and the ID-token email', async () => {
    const idToken = jwt.sign({ email: 'ops@example.com', email_verified: true }, 'x');
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: 'a', refresh_token: 'r1', id_token: idToken, scope: `openid email ${google.GMAIL_SEND_SCOPE}` })
    );
    const out = await google.exchangeCode({ clientId: 'c', clientSecret: 's', code: 'code1', redirectUri: 'https://app.x/cb' });
    expect(out).toMatchObject({ refreshToken: 'r1', email: 'ops@example.com' });
    const form = new URLSearchParams(call(0).body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code1');
    expect(form.get('redirect_uri')).toBe('https://app.x/cb');
  });

  test('exchangeCode rejects a grant without gmail.send', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: 'a', refresh_token: 'r1', scope: 'openid email' }));
    await expect(google.exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' })).rejects.toMatchObject({
      code: 'SCOPE_MISSING',
    });
  });

  test('exchangeCode maps token errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant', error_description: 'Bad Request' }));
    await expect(google.exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' })).rejects.toThrow(
      'Google sign-in error (HTTP 400): invalid_grant: Bad Request'
    );
  });

  test('service account: RS256 JWT bearer for the delegated user, fixed token URL', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const saJson = JSON.stringify({
      type: 'service_account',
      client_email: 'mailer@proj.iam.gserviceaccount.com',
      private_key: pem,
      private_key_id: 'kid1',
      token_uri: 'https://evil.example.com/token',
    });
    const cfg = google.validateConfig({ mode: 'service_account', serviceAccountJson: saJson, delegatedUser: 'alerts@example.com' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'SAT', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'g2' }));
    await sendWith({ type: 'google', config: cfg }, MESSAGE);

    const token = call(0);
    expect(token.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(token.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = jwt.decode(form.get('assertion'), { complete: true });
    expect(claims.header).toMatchObject({ alg: 'RS256', kid: 'kid1' });
    expect(claims.payload).toMatchObject({
      iss: 'mailer@proj.iam.gserviceaccount.com',
      sub: 'alerts@example.com',
      scope: google.GMAIL_SEND_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
    });
    const raw = Buffer.from(JSON.parse(call(1).body).raw, 'base64url').toString('utf8');
    expect(raw).toMatch(/^From: alerts@example.com/m);
  });

  test('service account config is validated', () => {
    expect(() => google.validateConfig({ mode: 'service_account', serviceAccountJson: '{nope', delegatedUser: 'a@x.io' })).toThrow(ProviderConfigError);
    expect(() => google.validateConfig({ mode: 'service_account', serviceAccountJson: '{"client_email":"x"}', delegatedUser: 'a@x.io' })).toThrow(
      /client_email and private_key/
    );
  });
});

describe('SMTP', () => {
  test('security → nodemailer options', () => {
    expect(transportOptions({ host: 'h', port: 465, security: 'tls' })).toMatchObject({ secure: true, requireTLS: false });
    expect(transportOptions({ host: 'h', port: 587, security: 'starttls' })).toMatchObject({ secure: false, requireTLS: true });
    expect(transportOptions({ host: 'h', port: 25, security: 'none' })).toMatchObject({ secure: false, requireTLS: false });
    // The old bug: TLS on a non-465 port used to silently mean "no TLS required".
    expect(transportOptions({ host: 'h', port: 2465, security: 'tls' }).secure).toBe(true);
  });

  test('timeouts are set on the transport', () => {
    const o = transportOptions({ host: 'h', port: 587, security: 'starttls' });
    expect(o.connectionTimeout).toBe(15000);
    expect(o.greetingTimeout).toBe(15000);
    expect(o.socketTimeout).toBe(15000);
  });

  test('auth only when both username and password are set', () => {
    expect(transportOptions({ host: 'h', port: 587, username: 'u', password: 'p' }).auth).toEqual({ user: 'u', pass: 'p' });
    expect(transportOptions({ host: 'h', port: 587, username: 'u', password: null }).auth).toBeUndefined();
  });

  test('validateConfig defaults security by port and rejects URL-ish hosts', () => {
    expect(validateSmtp({ host: 'smtp.x.io', port: 465 }).security).toBe('tls');
    expect(validateSmtp({ host: 'smtp.x.io' })).toMatchObject({ port: 587, security: 'starttls' });
    expect(() => validateSmtp({ host: 'smtp://x.io' })).toThrow(ProviderConfigError);
    expect(() => validateSmtp({ host: 'x.io', security: 'ssl' })).toThrow(ProviderConfigError);
  });

  test('a delivery failure becomes a ProviderError with the server reply', async () => {
    // Nothing listens on port 1 → connection refused, fast.
    const err = await sendWith(
      { type: 'smtp', config: { host: '127.0.0.1', port: 1, security: 'none' }, fromAddress: 'a@x.io' },
      MESSAGE
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/^SMTP error: /);
  });
});

describe('env SMTP fallback', () => {
  const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE', 'SMTP_SECURITY'];
  const saved = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('null without SMTP_HOST', () => {
    expect(envSmtpProvider()).toBeNull();
  });

  test('legacy behaviour: 465 → tls, otherwise opportunistic', () => {
    process.env.SMTP_HOST = 'smtp.x.io';
    process.env.SMTP_PORT = '465';
    expect(envSmtpProvider().config.security).toBe('tls');
    process.env.SMTP_PORT = '587';
    expect(envSmtpProvider().config.security).toBe('none');
  });

  test('SMTP_SECURITY overrides', () => {
    process.env.SMTP_HOST = 'smtp.x.io';
    process.env.SMTP_SECURITY = 'starttls';
    expect(envSmtpProvider().config).toMatchObject({ host: 'smtp.x.io', port: 587, security: 'starttls' });
  });
});
