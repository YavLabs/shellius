/**
 * /api/settings/email — route-level tests: permission gate, secrets masked in
 * GET, validation, test endpoint with `to` (defaulting to the caller), and
 * the Google callback redirect on a bad state. Live DB + Redis (the test
 * endpoint is rate limited); auto-skips when either is unreachable.
 */

import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';
import prisma from '../../config/db.js';
import emailProvidersRouter from '../emailProviders.js';
import errorHandler from '../../middleware/errorHandler.js';
import { generateAccessToken } from '../../utils/jwt.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from '../../services/__tests__/testDbHelper.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings/email', emailProvidersRouter);
  app.use(errorHandler);
  return app;
}

async function redisReachable() {
  try {
    const { default: redis } = await import('../../config/redis.js');
    await Promise.race([redis.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
    return true;
  } catch {
    return false;
  }
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body ?? {}) };
}

describe('/api/settings/email (live DB)', () => {
  const app = buildApp();
  const realFetch = global.fetch;
  let reachable = false;
  let org;
  let admin;
  let member;
  let adminToken;
  let memberToken;

  beforeAll(async () => {
    reachable = (await dbReachable()) && (await redisReachable());
    if (!reachable) {
      console.warn('[skip] email-providers routes: no live DB/Redis');
      return;
    }
    org = await createTestOrg();
    admin = await createTestUser(org.id, { role: 'super_admin', email: `admin-${Date.now()}@example.com`, name: 'Ada Admin' });
    member = await createTestUser(org.id, { role: 'member' });
    adminToken = generateAccessToken({ userId: admin.id, orgId: org.id });
    memberToken = generateAccessToken({ userId: member.id, orgId: org.id });
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  afterAll(async () => {
    if (!reachable) return;
    await cleanupOrg(org.id);
    const { default: redis } = await import('../../config/redis.js');
    redis.disconnect();
  });

  const auth = (t) => ({ Authorization: `Bearer ${t}` });

  test('requires settings.smtp', async () => {
    if (!reachable) return;
    await request(app).get('/api/settings/email/providers').expect(401);
    const res = await request(app).get('/api/settings/email/providers').set(auth(memberToken)).expect(403);
    expect(res.body.success).toBe(false);
  });

  test('create + list mask secrets; meta exposes only booleans', async () => {
    if (!reachable) return;
    const created = await request(app)
      .post('/api/settings/email/providers')
      .set(auth(adminToken))
      .send({ name: 'Postmark', type: 'postmark', fromAddress: 'noreply@example.com', config: { serverToken: 'PM-ROUTE-SECRET' } })
      .expect(201);
    expect(created.body.data.provider.config.serverToken).toEqual({ set: true });

    const res = await request(app).get('/api/settings/email/providers').set(auth(adminToken)).expect(200);
    expect(res.body.success).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('PM-ROUTE-SECRET');
    expect(typeof res.body.meta.envSmtpConfigured).toBe('boolean');
    expect(res.body.meta).not.toHaveProperty('smtpHost');

    const one = await request(app).get(`/api/settings/email/providers/${created.body.data.provider.id}`).set(auth(adminToken)).expect(200);
    expect(JSON.stringify(one.body)).not.toContain('PM-ROUTE-SECRET');
  });

  test('validation: unknown type, bad from address, CRLF in name', async () => {
    if (!reachable) return;
    const post = (body) => request(app).post('/api/settings/email/providers').set(auth(adminToken)).send(body);
    await post({ name: 'x', type: 'carrier-pigeon', config: {} }).expect(400);
    await post({ name: 'x', type: 'resend', fromAddress: 'not-an-email', config: { apiKey: 'k' } }).expect(400);
    await post({ name: 'x\r\nBcc: evil@x.io', type: 'resend', fromAddress: 'a@example.com', config: { apiKey: 'k' } }).expect(400);
  });

  test('POST /:id/test sends to `to`, defaults to the caller, rejects bad addresses', async () => {
    if (!reachable) return;
    const created = await request(app)
      .post('/api/settings/email/providers')
      .set(auth(adminToken))
      .send({ name: 'Resend', type: 'resend', fromAddress: 'noreply@example.com', config: { apiKey: 're_k' } })
      .expect(201);
    const id = created.body.data.provider.id;

    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { id: 'r1' }));
    const toGiven = await request(app).post(`/api/settings/email/providers/${id}/test`).set(auth(adminToken)).send({ to: 'qa@example.org' }).expect(200);
    expect(toGiven.body.data).toMatchObject({ ok: true, sentTo: 'qa@example.org' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).to).toEqual(['qa@example.org']);

    const toSelf = await request(app).post(`/api/settings/email/providers/${id}/test`).set(auth(adminToken)).send({}).expect(200);
    expect(toSelf.body.data.sentTo).toBe(admin.email);

    await request(app).post(`/api/settings/email/providers/${id}/test`).set(auth(adminToken)).send({ to: 'nope' }).expect(400);

    global.fetch = jest.fn().mockResolvedValue(jsonResponse(401, { message: 'API key is invalid' }));
    const failed = await request(app).post(`/api/settings/email/providers/${id}/test`).set(auth(adminToken)).send({ to: 'qa@example.org' }).expect(200);
    expect(failed.body.data).toMatchObject({ ok: false, error: 'Resend error (HTTP 401): API key is invalid' });
    expect(failed.body.data.provider.lastTestOk).toBe(false);

    const audits = await prisma.auditLog.count({ where: { orgId: org.id, resourceId: id, action: 'email_provider.tested' } });
    expect(audits).toBe(3);
  });

  test('activate / delete flow', async () => {
    if (!reachable) return;
    const mk = (name) =>
      request(app)
        .post('/api/settings/email/providers')
        .set(auth(adminToken))
        .send({ name, type: 'resend', fromAddress: 'noreply@example.com', config: { apiKey: 'k' } })
        .expect(201);
    const a = (await mk('A')).body.data.provider;
    const b = (await mk('B')).body.data.provider;
    await request(app).post(`/api/settings/email/providers/${a.id}/activate`).set(auth(adminToken)).expect(200);
    await request(app).post(`/api/settings/email/providers/${b.id}/activate`).set(auth(adminToken)).expect(200);
    const list = await request(app).get('/api/settings/email/providers').set(auth(adminToken)).expect(200);
    expect(list.body.data.providers.filter((p) => p.isActive).map((p) => p.id)).toEqual([b.id]);
    expect(list.body.meta.activeProviderId).toBe(b.id);

    const del = await request(app).delete(`/api/settings/email/providers/${b.id}`).set(auth(adminToken)).expect(200);
    expect(del.body.data).toEqual({ deleted: true, wasActive: true });
  });

  test('Google callback with a bad state redirects back with an error', async () => {
    if (!reachable) return;
    const res = await request(app).get('/api/settings/email/google/callback?state=bogus&code=x').expect(302);
    expect(res.headers.location).toMatch(/\/settings\?tab=email&error=invalid_state$/);
  });
});
