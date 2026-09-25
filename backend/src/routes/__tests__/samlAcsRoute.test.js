/**
 * The SAML ACS endpoint's wiring, which is easy to get subtly wrong and hard
 * to notice:
 *
 *   - it must NOT be behind `authenticate` (the identity provider has no
 *     Shellius session and never will);
 *   - it must parse `application/x-www-form-urlencoded`, not JSON;
 *   - it must be mounted BEFORE app.js's global `express.urlencoded()`, or an
 *     assertion over 100KB is refused with a 413 before any of the validation
 *     code runs — a failure that would only ever show up for the customers
 *     with the most group memberships, in production, at sign-in.
 *
 * The router is mounted on a bare Express app in the same order app.js uses,
 * rather than importing app.js, because importing app.js starts the BullMQ
 * job runners (see `startAllJobs()` at the bottom of it) and a test process
 * would never exit. The one thing that cannot be checked that way — that
 * app.js really does mount it first — is asserted against app.js's source,
 * since the ordering IS the invariant.
 *
 * Tests that would need to load a provider row are gated on a reachable
 * database, matching the rest of this suite.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import request from 'supertest';
import express from 'express';
import samlAcsRouter from '../samlAcs.js';
import errorHandler from '../../middleware/errorHandler.js';
import { dbReachable } from '../../services/__tests__/testDbHelper.js';

const APP_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js');

function buildApp() {
  const app = express();
  // Exactly app.js's order: the SAML router and its own parser first, the
  // global parsers after.
  app.use('/api/auth/sso/saml', samlAcsRouter);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(errorHandler);
  return app;
}

const ACS = '/api/auth/sso/saml/acs/prov_does_not_exist';
let app;
let hasDb = false;

beforeAll(async () => {
  app = buildApp();
  hasDb = await dbReachable();
  if (!hasDb) {
    console.warn('[partial] SAML ACS route tests — DATABASE_URL unreachable, provider-lookup cases skipped');
  }
});

describe('mount order in app.js', () => {
  test('the SAML router is mounted before the global body parsers', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const saml = src.indexOf("app.use('/api/auth/sso/saml', samlAcsRouter)");
    const json = src.indexOf('app.use(express.json())');
    const urlencoded = src.indexOf('app.use(express.urlencoded(');
    expect(saml).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(-1);
    expect(urlencoded).toBeGreaterThan(-1);
    expect(saml).toBeLessThan(json);
    expect(saml).toBeLessThan(urlencoded);
  });

  test('it is mounted before the general SSO router, which owns /:orgSlug', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    expect(src.indexOf("app.use('/api/auth/sso/saml', samlAcsRouter)")).toBeLessThan(
      src.indexOf("app.use('/api/auth/sso', ssoRouter)")
    );
  });
});

describe('POST /api/auth/sso/saml/acs/:providerId', () => {
  test('is reachable with no session at all — never a 401', async () => {
    const res = await request(app).post(ACS).type('form').send({ RelayState: 'x' });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(302);
  });

  test('a POST with no SAMLResponse is refused as a redirect the browser can follow', async () => {
    const res = await request(app).post(ACS).type('form').send({ RelayState: 'x' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=saml_invalid');
  });

  test('a JSON body is not a substitute — the field is never found', async () => {
    // The ACS parser is urlencoded-only, deliberately. Anything else lands
    // with an empty body and is refused.
    const res = await request(app).post(ACS).send({ SAMLResponse: 'x' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=saml_invalid');
  });

  test("accepts a form body far larger than express's global 100kb default", async () => {
    // This is the mount-order test with real bytes. If the router were below
    // the global parsers, this would be a 413.
    if (!hasDb) return;
    const big = 'A'.repeat(300 * 1024);
    const res = await request(app).post(ACS).type('form').send({ SAMLResponse: big });
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(302);
    // Got past the parser and into the handler, which then found no such
    // provider — the correct outcome for an id that does not exist.
    expect(res.headers.location).toContain('error=sso_not_configured');
  });

  test("a body over the router's own 1MB cap is refused without reaching the provider lookup", async () => {
    // Left to the global errorHandler this is a 500: that handler only
    // honours `statusCode` on an ApiError, and a body-parser error is
    // neither that nor a Prisma error. The router handles it itself, and as a
    // redirect, because the client here is a browser mid-form-POST with
    // nowhere to render a JSON envelope.
    const huge = 'A'.repeat(2 * 1024 * 1024);
    const res = await request(app).post(ACS).type('form').send({ SAMLResponse: huge });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=saml_too_large');
  });

  test('an unknown provider id produces a generic refusal that reveals nothing', async () => {
    if (!hasDb) return;
    const res = await request(app).post(ACS).type('form').send({ SAMLResponse: 'not-base64-xml' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=sso_not_configured');
    expect(res.text).not.toContain('prov_does_not_exist');
  });
});

describe('GET /api/auth/sso/saml/metadata/:providerId', () => {
  test('404s for anything that is not a SAML provider, with no detail', async () => {
    if (!hasDb) return;
    const res = await request(app).get('/api/auth/sso/saml/metadata/prov_does_not_exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  test('needs no session — it is fetched by the IdP, which has none', async () => {
    if (!hasDb) return;
    const res = await request(app).get('/api/auth/sso/saml/metadata/prov_does_not_exist');
    expect(res.status).not.toBe(401);
  });
});
