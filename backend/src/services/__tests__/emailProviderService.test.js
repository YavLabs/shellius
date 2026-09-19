/**
 * emailProviderService + mailer resolution — live-DB tests (auto-skip when
 * no DB; see testDbHelper.js). Outbound provider calls go to a mocked
 * global.fetch; the Google OAuth state store is swapped for an in-memory
 * one so Redis isn't required.
 *
 * Covers: secrets never returned, PUT keeps omitted secrets, the one-active
 * invariant (service + partial unique index), test sends with `to`,
 * mailer resolution order (active provider → env SMTP → log-only), the
 * legacy smtp_configs import, and Google callback state validation.
 */

import { jest } from '@jest/globals';
import prisma from '../../config/db.js';
import { encrypt, decrypt } from '../../utils/crypto.js';
import * as svc from '../emailProviderService.js';
import { sendMail } from '../mailer.js';
import { clearTokenCache } from '../email/http.js';
import { GMAIL_SEND_SCOPE } from '../email/providers/google.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

const SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE', 'SMTP_SECURITY'];

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function memoryStateStore() {
  const map = new Map();
  return {
    map,
    async put(k, v) {
      map.set(k, v);
    },
    async take(k) {
      const v = map.get(k) ?? null;
      map.delete(k);
      return v;
    },
  };
}

describe('emailProviderService (live DB)', () => {
  let reachable;
  let org;
  let admin;
  let member;
  const savedEnv = {};
  const realFetch = global.fetch;
  let fetchMock;

  beforeAll(async () => {
    for (const k of SMTP_VARS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] emailProviderService: no live DB');
      return;
    }
    org = await createTestOrg();
    admin = await createTestUser(org.id, { role: 'super_admin' });
    member = await createTestUser(org.id, { role: 'member' });
  });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    clearTokenCache();
  });

  afterEach(async () => {
    for (const k of SMTP_VARS) delete process.env[k];
    if (reachable && org) await prisma.emailProvider.deleteMany({ where: { orgId: org.id } });
  });

  afterAll(async () => {
    global.fetch = realFetch;
    for (const k of SMTP_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (!reachable) return;
    await prisma.smtpConfig.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const ctx = () => ({ userId: admin.id, ip: '127.0.0.1' });

  test('create/list/get never return secret values', async () => {
    if (!reachable) return;
    const created = await svc.create(
      org.id,
      { name: 'Resend', type: 'resend', fromAddress: 'noreply@example.com', config: { apiKey: 're_TOPSECRET' } },
      ctx()
    );
    expect(created.config.apiKey).toEqual({ set: true });

    const { providers, meta } = await svc.list(org.id);
    const one = await svc.get(org.id, created.id);
    for (const payload of [created, providers, one]) {
      const json = JSON.stringify(payload);
      expect(json).not.toContain('re_TOPSECRET');
      expect(json).not.toContain('configEncrypted');
    }
    expect(meta).toMatchObject({ envSmtpConfigured: false, activeProviderId: null });

    // Stored encrypted, not plaintext.
    const row = await prisma.emailProvider.findFirst({ where: { id: created.id, orgId: org.id } });
    expect(row.configEncrypted).not.toContain('re_TOPSECRET');
    expect(JSON.parse(decrypt(row.configEncrypted)).apiKey).toBe('re_TOPSECRET');
  });

  test('audit entries never carry secrets', async () => {
    if (!reachable) return;
    const p = await svc.create(org.id, { name: 'SG', type: 'sendgrid', fromAddress: 'a@example.com', config: { apiKey: 'SG.AUDITSECRET' } }, ctx());
    await svc.update(org.id, p.id, { config: { apiKey: 'SG.NEWAUDITSECRET' } }, ctx());
    const logs = await prisma.auditLog.findMany({ where: { orgId: org.id, resourceId: p.id } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['email_provider.create', 'email_provider.update']));
    const json = JSON.stringify(logs);
    expect(json).not.toContain('AUDITSECRET');
    const upd = logs.find((l) => l.action === 'email_provider.update');
    expect(upd.metadata.changedFields).toContain('config.apiKey');
  });

  test('PUT keeps secrets when omitted or empty, clears on null', async () => {
    if (!reachable) return;
    const p = await svc.create(
      org.id,
      { name: 'SMTP', type: 'smtp', config: { host: 'smtp.example.com', port: 587, username: 'u', password: 'pw1' } },
      ctx()
    );
    await svc.update(org.id, p.id, { name: 'SMTP 2', config: { host: 'smtp2.example.com' } }, ctx());
    await svc.update(org.id, p.id, { config: { password: '' } }, ctx());
    let row = await prisma.emailProvider.findFirst({ where: { id: p.id, orgId: org.id } });
    let cfg = JSON.parse(decrypt(row.configEncrypted));
    expect(cfg).toMatchObject({ host: 'smtp2.example.com', password: 'pw1', username: 'u' });
    expect(row.name).toBe('SMTP 2');

    await svc.update(org.id, p.id, { config: { password: null } }, ctx());
    row = await prisma.emailProvider.findFirst({ where: { id: p.id, orgId: org.id } });
    cfg = JSON.parse(decrypt(row.configEncrypted));
    expect(cfg.password).toBeNull();
  });

  test('type cannot change; required fields are validated', async () => {
    if (!reachable) return;
    const p = await svc.create(org.id, { name: 'R', type: 'resend', fromAddress: 'a@example.com', config: { apiKey: 'k' } }, ctx());
    await expect(svc.update(org.id, p.id, { type: 'smtp' }, ctx())).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.create(org.id, { name: 'X', type: 'resend', config: { apiKey: 'k' } }, ctx())).rejects.toMatchObject({
      statusCode: 400,
    }); // fromAddress required
    await expect(svc.create(org.id, { name: 'X', type: 'mailgun', fromAddress: 'a@example.com', config: { apiKey: 'k' } }, ctx())).rejects.toMatchObject({
      statusCode: 400,
    }); // domain required
  });

  test('Google refreshToken cannot be injected through the API', async () => {
    if (!reachable) return;
    const p = await svc.create(
      org.id,
      { name: 'G', type: 'google', config: { mode: 'oauth', clientId: 'c', clientSecret: 's', refreshToken: 'INJECTED', connectedEmail: 'x@evil.com' } },
      ctx()
    );
    const row = await prisma.emailProvider.findFirst({ where: { id: p.id, orgId: org.id } });
    const cfg = JSON.parse(decrypt(row.configEncrypted));
    expect(cfg.refreshToken).toBeNull();
    expect(cfg.connectedEmail).toBeNull();
    expect(p.google.connected).toBe(false);
    // Not connected → cannot be activated.
    await expect(svc.activate(org.id, p.id, ctx())).rejects.toMatchObject({ statusCode: 400 });
  });

  test('only one provider is active per org', async () => {
    if (!reachable) return;
    const a = await svc.create(org.id, { name: 'A', type: 'resend', fromAddress: 'a@example.com', config: { apiKey: 'ka' } }, ctx());
    const b = await svc.create(org.id, { name: 'B', type: 'postmark', fromAddress: 'b@example.com', config: { serverToken: 'kb' } }, ctx());
    await svc.activate(org.id, a.id, ctx());
    await svc.activate(org.id, b.id, ctx());
    const active = await prisma.emailProvider.findMany({ where: { orgId: org.id, isActive: true } });
    expect(active.map((r) => r.id)).toEqual([b.id]);

    // The partial unique index backs the invariant at the DB level.
    await expect(
      prisma.emailProvider.update({ where: { id: a.id }, data: { isActive: true } })
    ).rejects.toMatchObject({ code: 'P2002' });

    // create(..., isActive: true) also switches.
    const c = await svc.create(org.id, { name: 'C', type: 'resend', fromAddress: 'c@example.com', config: { apiKey: 'kc' }, isActive: true }, ctx());
    expect(c.isActive).toBe(true);
    expect(await prisma.emailProvider.count({ where: { orgId: org.id, isActive: true } })).toBe(1);

    // Deleting the active provider leaves none active.
    const del = await svc.remove(org.id, c.id, ctx());
    expect(del).toEqual({ deleted: true, wasActive: true });
    expect(await prisma.emailProvider.count({ where: { orgId: org.id, isActive: true } })).toBe(0);
  });

  test('queries are org-scoped', async () => {
    if (!reachable) return;
    const other = await createTestOrg();
    try {
      const p = await svc.create(other.id, { name: 'O', type: 'resend', fromAddress: 'o@example.com', config: { apiKey: 'k' } }, {});
      await expect(svc.get(org.id, p.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(svc.remove(org.id, p.id, ctx())).rejects.toMatchObject({ statusCode: 404 });
      await expect(svc.activate(org.id, p.id, ctx())).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await cleanupOrg(other.id);
    }
  });

  test('test() sends to the given address and records the result', async () => {
    if (!reachable) return;
    const p = await svc.create(org.id, { name: 'R', type: 'resend', fromAddress: 'noreply@example.com', config: { apiKey: 'k' } }, ctx());
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'r1' }));
    const ok = await svc.test(org.id, p.id, { to: 'someone@example.org', orgName: 'Acme' }, ctx());
    expect(ok).toMatchObject({ ok: true, sentTo: 'someone@example.org', error: null });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual(['someone@example.org']);
    expect(body.subject).toBe('[Shellius] Test email');
    expect(body.html).toContain('R'); // provider name in the body
    expect(body.text).toMatch(/Provider: R/);
    let row = await prisma.emailProvider.findFirst({ where: { id: p.id, orgId: org.id } });
    expect(row.lastTestOk).toBe(true);
    expect(row.lastTestAt).toBeInstanceOf(Date);

    fetchMock.mockResolvedValueOnce(jsonResponse(403, { message: 'The example.com domain is not verified.' }));
    const bad = await svc.test(org.id, p.id, { to: 'someone@example.org' }, ctx());
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('Resend error (HTTP 403): The example.com domain is not verified.');
    row = await prisma.emailProvider.findFirst({ where: { id: p.id, orgId: org.id } });
    expect(row.lastTestOk).toBe(false);
    expect(row.lastTestError).toContain('not verified');
  });

  describe('mailer.sendMail resolution order', () => {
    test('active provider first', async () => {
      if (!reachable) return;
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = '1';
      await svc.create(org.id, { name: 'R', type: 'resend', fromAddress: 'n@example.com', config: { apiKey: 'k' }, isActive: true }, ctx());
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'x' }));
      const res = await sendMail({ orgId: org.id, to: 'u@example.com', subject: 's', html: '<p>h</p>', text: 't' });
      expect(res).toEqual({ delivered: true, transport: 'resend' });
    });

    test('provider failure is reported with its type and error (no silent env fallback)', async () => {
      if (!reachable) return;
      process.env.SMTP_HOST = '127.0.0.1';
      await svc.create(org.id, { name: 'R', type: 'resend', fromAddress: 'n@example.com', config: { apiKey: 'k' }, isActive: true }, ctx());
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'API key is invalid' }));
      const res = await sendMail({ orgId: org.id, to: 'u@example.com', subject: 's', text: 't' });
      expect(res).toEqual({ delivered: false, transport: 'resend', error: 'Resend error (HTTP 401): API key is invalid' });
    });

    test('no active provider → env SMTP', async () => {
      if (!reachable) return;
      await svc.create(org.id, { name: 'inactive', type: 'resend', fromAddress: 'n@example.com', config: { apiKey: 'k' } }, ctx());
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = '1'; // nothing listens → fast failure
      const res = await sendMail({ orgId: org.id, to: 'u@example.com', subject: 's', text: 't' });
      expect(res.transport).toBe('env-smtp');
      expect(res.delivered).toBe(false);
      expect(res.error).toMatch(/^SMTP error/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('nothing configured → log-only', async () => {
      if (!reachable) return;
      const res = await sendMail({ orgId: org.id, to: 'u@example.com', subject: 's', text: 't' });
      expect(res).toEqual({ delivered: false, transport: 'log' });
    });
  });

  test('legacy smtp_configs rows are imported once, password decrypted into the blob', async () => {
    if (!reachable) return;
    const legacy = await prisma.smtpConfig.upsert({
      where: { orgId: org.id },
      update: {},
      create: {
        orgId: org.id,
        host: 'legacy.example.com',
        port: 587,
        username: 'legacy-user',
        passwordEncrypted: encrypt('legacy-pass'),
        fromAddress: 'legacy@example.com',
        useTls: true,
      },
    });
    // What the SQL migration inserts:
    const row = await prisma.emailProvider.create({
      data: { orgId: org.id, name: 'SMTP', type: 'smtp', fromAddress: 'legacy@example.com', isActive: true, legacySmtpConfigId: legacy.id },
    });
    const listed = await svc.list(org.id); // lazy import on read
    expect(listed.providers[0]).toMatchObject({ id: row.id, pendingImport: false, ready: true });
    expect(listed.providers[0].config).toMatchObject({ host: 'legacy.example.com', security: 'starttls', password: { set: true } });

    const stored = await prisma.emailProvider.findFirst({ where: { id: row.id, orgId: org.id } });
    expect(JSON.parse(decrypt(stored.configEncrypted))).toEqual({
      host: 'legacy.example.com',
      port: 587,
      security: 'starttls',
      username: 'legacy-user',
      password: 'legacy-pass',
    });
    // Idempotent: a second boot-time pass leaves it alone.
    const before = stored.configEncrypted;
    await svc.importLegacySmtpConfigs();
    const again = await prisma.emailProvider.findFirst({ where: { id: row.id, orgId: org.id } });
    expect(again.configEncrypted).toBe(before);
    // smtp_configs untouched (rollback safety).
    expect(await prisma.smtpConfig.findFirst({ where: { id: legacy.id } })).not.toBeNull();
  });

  test('legacySmtpToConfig maps useTls/port to security', () => {
    expect(svc.legacySmtpToConfig({ host: 'h', port: 465, useTls: true }).security).toBe('tls');
    expect(svc.legacySmtpToConfig({ host: 'h', port: 587, useTls: true }).security).toBe('starttls');
    expect(svc.legacySmtpToConfig({ host: 'h', port: 25, useTls: false }).security).toBe('none');
  });

  describe('Google connect callback', () => {
    let store;
    beforeEach(() => {
      store = memoryStateStore();
      svc._setStateStore(store);
    });

    async function googleProvider() {
      return svc.create(org.id, { name: 'Gmail', type: 'google', config: { mode: 'oauth', clientId: 'cid', clientSecret: 'csecret' } }, ctx());
    }

    test('start → state bound to org+provider+user, 10 min TTL', async () => {
      if (!reachable) return;
      const p = await googleProvider();
      const putSpy = jest.spyOn(store, 'put');
      const { authUrl, redirectUri } = await svc.startGoogleConnect(org.id, p.id, ctx());
      const state = new URL(authUrl).searchParams.get('state');
      expect(state).toMatch(/^[a-f0-9]{64}$/);
      expect(redirectUri).toMatch(/\/api\/settings\/email\/google\/callback$/);
      expect(putSpy).toHaveBeenCalledWith(expect.stringContaining(state), expect.any(String), 600);
      expect(JSON.parse(store.map.get(`email:google:state:${state}`))).toEqual({ orgId: org.id, providerId: p.id, userId: admin.id });
    });

    test('rejects malformed, unknown and reused state', async () => {
      if (!reachable) return;
      const p = await googleProvider();
      expect(await svc.completeGoogleConnect({ state: 'nope', code: 'c' })).toEqual({ ok: false, error: 'invalid_state' });
      expect(await svc.completeGoogleConnect({ state: 'a'.repeat(64), code: 'c' })).toEqual({ ok: false, error: 'invalid_state' });

      const { authUrl } = await svc.startGoogleConnect(org.id, p.id, ctx());
      const state = new URL(authUrl).searchParams.get('state');
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: 'a', refresh_token: 'RT-1', scope: `openid email ${GMAIL_SEND_SCOPE}` }));
      expect(await svc.completeGoogleConnect({ state, code: 'code-1' })).toEqual({ ok: true });
      // One-time: the same state can't be replayed.
      expect(await svc.completeGoogleConnect({ state, code: 'code-2' })).toEqual({ ok: false, error: 'invalid_state' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('state for a user without settings.smtp is refused', async () => {
      if (!reachable) return;
      const p = await googleProvider();
      const { authUrl } = await svc.startGoogleConnect(org.id, p.id, { userId: member.id });
      const state = new URL(authUrl).searchParams.get('state');
      expect(await svc.completeGoogleConnect({ state, code: 'c' })).toEqual({ ok: false, error: 'forbidden' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('user denied consent', async () => {
      if (!reachable) return;
      const p = await googleProvider();
      const { authUrl } = await svc.startGoogleConnect(org.id, p.id, ctx());
      const state = new URL(authUrl).searchParams.get('state');
      expect(await svc.completeGoogleConnect({ state, error: 'access_denied' })).toEqual({ ok: false, error: 'access_denied' });
    });

    test('success stores the refresh token encrypted and the account email', async () => {
      if (!reachable) return;
      const p = await googleProvider();
      const { authUrl } = await svc.startGoogleConnect(org.id, p.id, ctx());
      const state = new URL(authUrl).searchParams.get('state');
      const idToken = ['e30', Buffer.from(JSON.stringify({ email: 'ops@example.com', email_verified: true })).toString('base64url'), 'sig'].join('.');
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'a', refresh_token: 'RT-SECRET', id_token: idToken, scope: `openid email ${GMAIL_SEND_SCOPE}` })
      );
      expect(await svc.completeGoogleConnect({ state, code: 'code-1' })).toEqual({ ok: true });

      const row = await prisma.emailProvider.findFirst({ where: { id: p.id, orgId: org.id } });
      expect(row.configEncrypted).not.toContain('RT-SECRET');
      expect(JSON.parse(decrypt(row.configEncrypted))).toMatchObject({ refreshToken: 'RT-SECRET', connectedEmail: 'ops@example.com' });
      const pub = await svc.get(org.id, p.id);
      expect(pub.google).toMatchObject({ connected: true, connectedEmail: 'ops@example.com' });
      expect(pub.config.refreshToken).toEqual({ set: true });
      expect(JSON.stringify(pub)).not.toContain('RT-SECRET');
      const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, resourceId: p.id, action: 'email_provider.google_connect' } });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit)).not.toContain('RT-SECRET');
    });
  });
});
