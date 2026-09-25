#!/usr/bin/env node
/**
 * e2e-saml.mjs
 *
 * End-to-end test of SAML 2.0 Web Browser SSO against a REAL identity
 * provider — Keycloak — doing real XML signing on its own clock, with its own
 * metadata and its own assertions. Nothing here fabricates an assertion: the
 * signer is not our code, which is the entire point. The committed fixture
 * corpus (services/__tests__/samlProviderConfig.test.js and friends) proves
 * the refusal paths against crafted documents; this proves the HAPPY path
 * against a real one, and then proves the refusals still hold when the
 * document being refused is a genuine, correctly-signed Keycloak assertion.
 *
 * No browser is involved. Keycloak's login page is an ordinary HTML form and
 * its SAML response is an auto-submitting HTML form, so plain HTTP plus a
 * cookie jar is enough to drive the whole round trip.
 *
 * ## What it asserts
 *
 *   1. SP-initiated sign-in SUCCEEDS and the user is JIT-provisioned
 *   2. replaying that exact POST is REFUSED
 *   3. a tampered assertion (an attribute altered after signing) is REFUSED
 *   4. an assertion minted for a DIFFERENT SP by the same honest IdP is
 *      REFUSED (audience)
 *   5. an EXPIRED assertion is REFUSED
 *   6. an unsolicited (IdP-initiated) POST is REFUSED while
 *      samlAllowIdpInitiated is false
 *   7. IdP-initiated sign-in SUCCEEDS once the org opts in
 *   8. replaying THAT response is refused with `saml_replay` specifically —
 *      the single-use claim on the assertion ID, isolated. This is the most
 *      important assertion in the file: for an IdP-initiated response there
 *      is no RelayState and no InResponseTo, so the assertion-ID claim in
 *      Redis is the ONLY thing standing between "used once" and "usable
 *      until it expires".
 *
 * Every check is exit-code bearing: any failure sets a non-zero exit code.
 *
 * ## Prerequisites
 *
 *   docker compose -f docker-compose.dev.yml --profile saml up -d keycloak
 *   backend running (npm run dev) with Postgres + Redis up
 *
 * ## Idempotency and cleanup — it is BOTH
 *
 *   - Keycloak: the test realm is deleted (if present) and recreated on every
 *     run, so a half-finished run leaves nothing that can poison the next.
 *     The realm is left behind afterwards so a failure can be inspected in
 *     the admin console; the next run wipes it.
 *   - Shellius: the SAML provider and the JIT-provisioned user it creates are
 *     deleted at the end, and any leftovers from a previous run are deleted
 *     at the start. Set E2E_SAML_KEEP=1 to keep them.
 *
 * ## A note on where the assertion is POSTed
 *
 * `samlService` derives the canonical ACS URL from `config.publicBaseUrl`,
 * which in dev is the Vite origin (http://localhost:5173) because that is
 * what a browser talks to. That URL is what Keycloak is configured with and
 * what ends up in `Destination`, `Recipient` and the SP EntityID. The script
 * POSTs the assertion to the same PATH on BASE_URL (the API origin) — exactly
 * what a reverse proxy does — so the run does not depend on Vite being up.
 * This weakens nothing: `assertDestination` compares `Destination` against
 * the canonical ACS URL, never against the URL the request arrived on.
 *
 * Usage: npm run test:e2e:saml
 * Env:   BASE_URL           (default http://127.0.0.1:3001)
 *        KEYCLOAK_URL       (default http://127.0.0.1:8081)
 *        KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD (default admin/admin — the
 *          throwaway credentials in docker-compose.dev.yml)
 *        ADMIN_EMAIL / ADMIN_PASSWORD — a Shellius super admin. Falls back to
 *          SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD from backend/.env.
 *        E2E_SAML_KEEP=1    leave the Shellius provider + JIT user in place
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser } from '@xmldom/xmldom';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// backend/.env carries SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD, which is the
// admin this dev install actually has. Read it so the script needs no
// arguments; never print anything out of it.
loadDotEnv(path.join(HERE, '..', '.env'));

const BASE_URL = stripSlash(process.env.BASE_URL || 'http://127.0.0.1:3001');
const KC = stripSlash(process.env.KEYCLOAK_URL || 'http://127.0.0.1:8081');
const KC_ADMIN = process.env.KEYCLOAK_ADMIN || 'admin';
const KC_ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SEED_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD;

const REALM = process.env.E2E_SAML_REALM || 'shellius-e2e';
const PROVIDER_NAME = 'E2E Keycloak SAML';
const IDP_USER = 'e2e-saml-user';
const IDP_USER_PASSWORD = 'e2e-Keycloak-Pass-2026';
const IDP_USER_EMAIL = 'e2e-saml-user@e2e.shellius.test';
const IDP_USER_FIRST = 'Eevee';
const IDP_USER_LAST = 'Tester';
const SSO_URL_NAME = 'shellius-e2e';
const OTHER_SP_ENTITY_ID = 'urn:shellius:e2e:another-service-provider';
const OTHER_SSO_URL_NAME = 'shellius-e2e-other';
const KEEP = process.env.E2E_SAML_KEEP === '1';

const EMAIL_NAMEID_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(name, detail) {
  passCount += 1;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, err) {
  failCount += 1;
  const msg = err?.message || String(err);
  failures.push({ name, msg });
  console.error(`  ✗ ${name}`);
  console.error(`    ${msg}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    ok(name, typeof detail === 'string' ? detail : undefined);
  } catch (err) {
    fail(name, err);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function stripSlash(u) {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal .env reader — no dotenv dependency, no overwriting of real env. */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

// ---------------------------------------------------------------------------
// HTTP: a cookie jar and a rate-limit-aware fetch
// ---------------------------------------------------------------------------

/** Host-scoped cookie jar. Paths and flags are ignored on purpose: this is a
 *  test client driving one IdP, not a browser enforcing a security boundary. */
class CookieJar {
  constructor() {
    this.byHost = new Map();
  }

  store(url, setCookieHeaders) {
    if (!setCookieHeaders?.length) return;
    const host = new URL(url).host;
    if (!this.byHost.has(host)) this.byHost.set(host, new Map());
    const jar = this.byHost.get(host);
    for (const raw of setCookieHeaders) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /expires=thu, 01 jan 1970/i.test(raw)) jar.delete(name);
      else jar.set(name, value);
    }
  }

  header(url) {
    const jar = this.byHost.get(new URL(url).host);
    if (!jar || jar.size === 0) return null;
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function setCookies(res) {
  // Node 20's Headers has getSetCookie(); fall back to the raw header.
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/**
 * One request, no automatic redirects, cookies in and out, and a hard stop on
 * the express `authLimiter` (10/min on the ACS and on /api/auth/login). The
 * limiter is a real control we are not going to disable for a test, so the
 * script waits it out instead — `RateLimit-Reset` says how long.
 */
async function http(url, { method = 'GET', headers = {}, body, jar, retries = 3 } = {}) {
  const h = { ...headers };
  if (jar) {
    const cookie = jar.header(url);
    if (cookie) h.Cookie = cookie;
  }
  const res = await fetch(url, { method, headers: h, body, redirect: 'manual' });
  if (jar) jar.store(url, setCookies(res));

  if (res.status === 429 && retries > 0) {
    const reset = Number(res.headers.get('ratelimit-reset') || res.headers.get('retry-after') || 60);
    const waitMs = (Number.isFinite(reset) ? Math.min(reset, 120) : 60) * 1000 + 1000;
    console.log(`    … rate limited, waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
    return http(url, { method, headers, body, jar, retries: retries - 1 });
  }

  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
}

function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.set(k, v);
  return p.toString();
}

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };

// ---------------------------------------------------------------------------
// Shellius API
// ---------------------------------------------------------------------------

async function api(method, pathname, { token, body } = {}) {
  const res = await http(`${BASE_URL}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    /* not json */
  }
  return { status: res.status, json };
}

async function shelliusLogin() {
  const { status, json } = await api('POST', '/api/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (status !== 200 || !json?.success) {
    throw new Error(`Shellius admin login failed: ${status} ${JSON.stringify(json)}`);
  }
  if (!json.data.accessToken) {
    throw new Error('Shellius admin login returned an MFA challenge; this script needs an admin without MFA');
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// Keycloak Admin REST API
// ---------------------------------------------------------------------------

async function waitForKeycloak(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const res = await http(`${KC}/realms/master/.well-known/openid-configuration`);
      if (res.status === 200) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    await sleep(2000);
  }
  throw new Error(`Keycloak at ${KC} was not ready in ${timeoutMs / 1000}s (${lastErr}). ` +
    'Start it with: docker compose -f docker-compose.dev.yml --profile saml up -d keycloak');
}

async function kcAdminToken() {
  const res = await http(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: form({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: KC_ADMIN,
      password: KC_ADMIN_PASSWORD,
    }),
  });
  if (res.status !== 200) throw new Error(`Keycloak admin token request failed: HTTP ${res.status}`);
  const token = JSON.parse(res.text).access_token;
  if (!token) throw new Error('Keycloak admin token response had no access_token');
  return token;
}

async function kcAdmin(token, method, pathname, body) {
  const res = await http(`${KC}/admin${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function kcAdminJson(token, method, pathname, body) {
  const res = await kcAdmin(token, method, pathname, body);
  if (res.status >= 400) {
    throw new Error(`Keycloak ${method} ${pathname} failed: HTTP ${res.status} ${res.text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML / XML scraping
// ---------------------------------------------------------------------------

function htmlUnescape(s) {
  return s
    .replace(/&#x3D;/gi, '=')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x2B;/gi, '+')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function hiddenInput(html, name) {
  const re = new RegExp(`<input[^>]*name=["']${name}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  if (!tag) return null;
  const v = /value=["']([\s\S]*?)["']/i.exec(tag);
  return v ? htmlUnescape(v[1]) : null;
}

function formAction(html) {
  const m = /<form[^>]*\baction=["']([^"']+)["']/i.exec(html);
  return m ? htmlUnescape(m[1]) : null;
}

const parseXml = (xml) => new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError() {} } })
  .parseFromString(xml, 'text/xml');

const MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';
const ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';

/** Pull the IdP facts out of Keycloak's published realm descriptor. Nothing
 *  is hardcoded: entry point, EntityID and the signing certificate all come
 *  from the document the IdP publishes. */
function readIdpDescriptor(xml) {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (!root) throw new Error('realm descriptor is not XML');
  const entityId = root.getAttribute('entityID');

  let entryPoint = null;
  const ssoNodes = doc.getElementsByTagNameNS(MD_NS, 'SingleSignOnService');
  for (let i = 0; i < ssoNodes.length; i += 1) {
    const binding = ssoNodes[i].getAttribute('Binding');
    const location = ssoNodes[i].getAttribute('Location');
    if (binding === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect') entryPoint = location;
    else if (!entryPoint) entryPoint = location;
  }

  // Prefer a KeyDescriptor explicitly marked use="signing"; Keycloak emits a
  // single unmarked descriptor used for both, so fall back to the first.
  let cert = null;
  const keyDescriptors = doc.getElementsByTagNameNS(MD_NS, 'KeyDescriptor');
  for (let i = 0; i < keyDescriptors.length; i += 1) {
    const use = keyDescriptors[i].getAttribute('use');
    const x509 = keyDescriptors[i].getElementsByTagNameNS(DS_NS, 'X509Certificate')[0];
    if (!x509) continue;
    const body = (x509.textContent || '').replace(/\s+/g, '');
    if (use === 'signing') { cert = body; break; }
    if (!cert) cert = body;
  }

  if (!entityId) throw new Error('realm descriptor has no entityID');
  if (!entryPoint) throw new Error('realm descriptor has no SingleSignOnService');
  if (!cert) throw new Error('realm descriptor has no signing certificate');
  return { entityId, entryPoint, certificate: cert };
}

/** Facts from a decoded SAMLResponse, for the script's own bookkeeping. */
function readResponseFacts(xml) {
  const doc = parseXml(xml);
  const assertion = doc.getElementsByTagNameNS(ASSERTION_NS, 'Assertion')[0] || null;
  const conditions = assertion?.getElementsByTagNameNS(ASSERTION_NS, 'Conditions')[0] || null;
  const audience = assertion?.getElementsByTagNameNS(ASSERTION_NS, 'Audience')[0] || null;
  const nameId = assertion?.getElementsByTagNameNS(ASSERTION_NS, 'NameID')[0] || null;
  return {
    destination: doc.documentElement?.getAttribute('Destination') || null,
    inResponseTo: doc.documentElement?.getAttribute('InResponseTo') || null,
    assertionId: assertion?.getAttribute('ID') || null,
    notOnOrAfter: conditions?.getAttribute('NotOnOrAfter') || null,
    audience: audience?.textContent || null,
    nameId: nameId?.textContent || null,
    nameIdFormat: nameId?.getAttribute('Format') || null,
  };
}

const decodeResponse = (b64) => Buffer.from(b64, 'base64').toString('utf8');
const encodeResponse = (xml) => Buffer.from(xml, 'utf8').toString('base64');

/**
 * Change exactly one base64 character inside the first `<tag>` that appears
 * after the `<Assertion>` element — so a tamper lands where it is meant to
 * land, instead of wherever the middle of the document happens to be.
 * Namespace prefixes are whatever the IdP chose, hence the loose match.
 */
function flipCharIn(xml, tag, after = 'assertion') {
  const from = after === 'assertion' ? xml.search(/<(?:[\w.-]+:)?Assertion[\s>]/) : 0;
  assert(from >= 0, 'no <Assertion> element in the response');
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'g');
  re.lastIndex = from;
  const m = re.exec(xml);
  assert(m, `no <${tag}> found inside the assertion`);
  const body = m[1];
  const at = body.search(/[A-Za-z0-9+/]/);
  assert(at >= 0, `<${tag}> had no base64 content to change`);
  const swapped = body[at] === 'A' ? 'B' : 'A';
  const start = m.index + m[0].indexOf(body);
  return xml.slice(0, start + at) + swapped + xml.slice(start + at + 1);
}

// ---------------------------------------------------------------------------
// The flows
// ---------------------------------------------------------------------------

/**
 * Walk an HTTP exchange until Keycloak hands back a form carrying a
 * SAMLResponse — following redirects and submitting the login form once if it
 * is presented. This is precisely what a browser does, minus the rendering.
 */
async function followToSamlResponse(startRes, jar, { credentials = null } = {}) {
  let res = startRes;
  let loggedIn = false;

  for (let hop = 0; hop < 12; hop += 1) {
    if (res.status >= 300 && res.status < 400 && res.location) {
      res = await http(new URL(res.location, KC).toString(), { jar });
      continue;
    }
    if (res.status !== 200) {
      throw new Error(`unexpected HTTP ${res.status} from the IdP: ${res.text.slice(0, 200)}`);
    }

    const samlResponse = hiddenInput(res.text, 'SAMLResponse');
    if (samlResponse) {
      return {
        samlResponse,
        relayState: hiddenInput(res.text, 'RelayState'),
        action: formAction(res.text),
      };
    }

    // Not the auto-post form: it must be the login page.
    const action = formAction(res.text);
    if (!action) throw new Error(`IdP returned a page with no form and no SAMLResponse: ${res.text.slice(0, 200)}`);
    if (loggedIn) throw new Error('IdP presented a second form after login — credentials rejected?');
    if (!credentials) throw new Error('IdP asked for a login but no credentials were supplied for this step');

    res = await http(new URL(action, KC).toString(), {
      method: 'POST',
      headers: FORM_HEADERS,
      jar,
      body: form({ username: credentials.username, password: credentials.password, credentialId: '' }),
    });
    loggedIn = true;
  }
  throw new Error('too many redirects while driving the IdP');
}

/** Read the `#code=` / `#error=` fragment off an ACS redirect. */
function readCallbackFragment(location) {
  if (!location) return { error: 'no-location' };
  const hash = location.includes('#') ? location.slice(location.indexOf('#') + 1) : '';
  const params = new URLSearchParams(hash);
  return {
    url: location,
    code: params.get('code'),
    error: params.get('error'),
    isLinkPage: location.includes('/sso/link'),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('ADMIN_EMAIL/ADMIN_PASSWORD (or SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD in backend/.env) are required');
  }

  console.log(`[e2e-saml] BASE_URL=${BASE_URL}  KEYCLOAK_URL=${KC}  realm=${REALM}`);

  // -- 0. both sides up ----------------------------------------------------
  await waitForKeycloak();
  console.log('[e2e-saml] Keycloak is up');

  const admin = await shelliusLogin();
  const token = admin.accessToken;
  console.log(`[e2e-saml] signed in to Shellius as ${admin.user.email} (org ${admin.user.orgId})`);

  const statusRes = await api('GET', '/api/auth/sso/public-status');
  const orgSlug = statusRes.json?.data?.orgSlug;
  assert(orgSlug, 'could not resolve the public org slug');

  const kcToken = await kcAdminToken();

  // -- 1. a clean realm ----------------------------------------------------
  const existingRealm = await kcAdmin(kcToken, 'GET', `/realms/${REALM}`);
  if (existingRealm.status === 200) {
    await kcAdminJson(kcToken, 'DELETE', `/realms/${REALM}`);
    console.log(`[e2e-saml] removed the previous '${REALM}' realm`);
  }
  await kcAdminJson(kcToken, 'POST', '/realms', {
    realm: REALM,
    enabled: true,
    sslRequired: 'none',
    loginTheme: 'keycloak',
  });
  await kcAdminJson(kcToken, 'POST', `/realms/${REALM}/users`, {
    username: IDP_USER,
    email: IDP_USER_EMAIL,
    firstName: IDP_USER_FIRST,
    lastName: IDP_USER_LAST,
    enabled: true,
    emailVerified: true,
    credentials: [{ type: 'password', value: IDP_USER_PASSWORD, temporary: false }],
  });
  console.log(`[e2e-saml] created realm '${REALM}' and user '${IDP_USER}'`);

  // -- 2. the IdP's own metadata ------------------------------------------
  const descriptorRes = await http(`${KC}/realms/${REALM}/protocol/saml/descriptor`);
  assert(descriptorRes.status === 200, `realm descriptor fetch failed: HTTP ${descriptorRes.status}`);
  const idp = readIdpDescriptor(descriptorRes.text);
  console.log(`[e2e-saml] IdP EntityID ${idp.entityId}`);
  console.log(`[e2e-saml] IdP SSO URL   ${idp.entryPoint}`);
  console.log(`[e2e-saml] IdP signing certificate read from the descriptor (${idp.certificate.length} base64 chars)`);

  // -- 3. the Shellius provider -------------------------------------------
  //
  // ORDERING, explicitly: the SP EntityID and the ACS URL are DERIVED from
  // the provider's id (samlService.metadataUrlFor / acsUrlFor), so the
  // provider must exist before Keycloak's client can be configured. But the
  // create endpoint requires the IdP's entry point, EntityID and certificate
  // up front. Both constraints are satisfiable because the realm descriptor
  // exists as soon as the realm does and does not depend on any client:
  //   realm -> descriptor -> Shellius provider -> ids -> Keycloak client.
  const existing = await api('GET', '/api/auth/sso/providers', { token });
  for (const p of existing.json?.data?.providers || []) {
    if (p.name === PROVIDER_NAME) {
      await api('DELETE', `/api/auth/sso/providers/${p.id}?force=true`, { token });
      console.log(`[e2e-saml] removed a leftover '${PROVIDER_NAME}' provider from a previous run`);
    }
  }

  const created = await api('POST', '/api/auth/sso/providers', {
    token,
    body: {
      name: PROVIDER_NAME,
      presetId: 'saml',
      samlIdpEntryPoint: idp.entryPoint,
      samlIdpEntityId: idp.entityId,
      samlIdpCertificate: idp.certificate,
      samlIdentifierFormat: EMAIL_NAMEID_FORMAT,
      samlAllowIdpInitiated: false,
      samlClockSkewSec: 60,
      defaultRole: 'member',
      autoProvision: true,
      allowedDomains: [],
      requireVerifiedEmail: true,
      isActive: true,
    },
  });
  assert(created.status === 201 && created.json?.success,
    `provider create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const provider = created.json.data.provider;
  const providerId = provider.id;
  const spEntityId = provider.samlSpEntityId;
  const acsUrl = provider.samlAcsUrl;
  const acsPath = new URL(acsUrl).pathname;
  console.log(`[e2e-saml] Shellius provider ${providerId}`);
  console.log(`[e2e-saml]   SP EntityID ${spEntityId}`);
  console.log(`[e2e-saml]   ACS URL     ${acsUrl}  (posted to ${BASE_URL}${acsPath})`);

  const patchProvider = async (body) => {
    const r = await api('PATCH', `/api/auth/sso/providers/${providerId}`, { token, body });
    assert(r.status === 200 && r.json?.success, `provider update failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.data.provider;
  };

  // -- 4. the Keycloak clients --------------------------------------------
  const samlClientAttributes = (consumerUrl, ssoName) => ({
    'saml.assertion.signature': 'true',
    'saml.server.signature': 'true',
    'saml.client.signature': 'false',
    'saml.signature.algorithm': 'RSA_SHA256',
    'saml.authnstatement': 'true',
    saml_name_id_format: 'email',
    saml_force_name_id_format: 'true',
    saml_assertion_consumer_url_post: consumerUrl,
    saml_idp_initiated_sso_url_name: ssoName,
  });

  const samlMappers = [
    ['email', 'saml-user-property-mapper', 'email'],
    ['firstName', 'saml-user-property-mapper', 'firstName'],
    ['lastName', 'saml-user-property-mapper', 'lastName'],
  ].map(([name, mapper, attr]) => ({
    name,
    protocol: 'saml',
    protocolMapper: mapper,
    config: {
      'user.attribute': attr,
      'friendly.name': attr,
      'attribute.name': attr,
      'attribute.nameformat': 'Basic',
    },
  }));

  await kcAdminJson(kcToken, 'POST', `/realms/${REALM}/clients`, {
    clientId: spEntityId,
    name: 'Shellius (e2e)',
    protocol: 'saml',
    enabled: true,
    frontchannelLogout: false,
    redirectUris: [acsUrl, `${BASE_URL}${acsPath}`],
    attributes: samlClientAttributes(acsUrl, SSO_URL_NAME),
    protocolMappers: samlMappers,
  });

  // A SECOND service provider at the same IdP, pointed at OUR ACS URL on
  // purpose. Its assertions are perfectly valid and signed by the same honest
  // IdP — they simply name a different audience. Without the audience check
  // one of them would be a valid login here.
  await kcAdminJson(kcToken, 'POST', `/realms/${REALM}/clients`, {
    clientId: OTHER_SP_ENTITY_ID,
    name: 'A different service provider (e2e)',
    protocol: 'saml',
    enabled: true,
    frontchannelLogout: false,
    redirectUris: [acsUrl, `${BASE_URL}${acsPath}`],
    attributes: samlClientAttributes(acsUrl, OTHER_SSO_URL_NAME),
    protocolMappers: samlMappers,
  });
  console.log('[e2e-saml] created both Keycloak SAML clients');

  const clientUuid = async (clientId) => {
    const list = await kcAdminJson(kcToken, 'GET', `/realms/${REALM}/clients?clientId=${encodeURIComponent(clientId)}`);
    assert(list?.length, `Keycloak client ${clientId} not found`);
    return list[0].id;
  };

  // -- helpers that drive one round trip ----------------------------------

  /** SP-initiated: Shellius -> Keycloak -> a signed response for us. */
  async function spInitiated() {
    const jar = new CookieJar();
    const start = await http(`${BASE_URL}/api/auth/sso/${orgSlug}?provider=${encodeURIComponent(providerId)}`, { jar });
    assert(start.status === 302, `login start did not redirect: HTTP ${start.status}`);
    assert(start.location && start.location.startsWith(idp.entryPoint),
      `login start redirected somewhere unexpected: ${start.location}`);
    const first = await http(start.location, { jar });
    return followToSamlResponse(first, jar, {
      credentials: { username: IDP_USER, password: IDP_USER_PASSWORD },
    });
  }

  /** IdP-initiated (unsolicited): no AuthnRequest, no RelayState. */
  async function idpInitiated(ssoName) {
    const jar = new CookieJar();
    const first = await http(`${KC}/realms/${REALM}/protocol/saml/clients/${ssoName}`, { jar });
    return followToSamlResponse(first, jar, {
      credentials: { username: IDP_USER, password: IDP_USER_PASSWORD },
    });
  }

  async function postAcs({ samlResponse, relayState }) {
    const res = await http(`${BASE_URL}${acsPath}`, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: form({ SAMLResponse: samlResponse, ...(relayState ? { RelayState: relayState } : {}) }),
    });
    assert(res.status === 302, `ACS did not redirect: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    return readCallbackFragment(res.location);
  }

  /** Assert a POST is refused, and refused with the code we expect. */
  async function expectRefusal(payload, expectedCodes) {
    const out = await postAcs(payload);
    assert(!out.code, `the assertion was ACCEPTED (redirected with a sign-in code) — expected ${expectedCodes.join('/')}`);
    assert(!out.isLinkPage, `refusal expected, got the account-linking page: ${out.url}`);
    assert(expectedCodes.includes(out.error),
      `expected error ${expectedCodes.join('/')}, got '${out.error}' (${out.url})`);
    return out.error;
  }

  // =======================================================================
  // 1. The happy path
  // =======================================================================
  let firstPost = null;
  let provisionedUserId = null;

  await step('SP-initiated sign-in against a real Keycloak assertion SUCCEEDS', async () => {
    const payload = await spInitiated();
    const facts = readResponseFacts(decodeResponse(payload.samlResponse));
    assert(payload.relayState, 'Keycloak did not echo our RelayState');
    assert(facts.inResponseTo, 'the response carried no InResponseTo');
    assert(facts.destination === acsUrl, `Destination was ${facts.destination}, expected ${acsUrl}`);
    assert(facts.audience === spEntityId, `Audience was ${facts.audience}, expected ${spEntityId}`);
    assert(facts.nameIdFormat === EMAIL_NAMEID_FORMAT, `NameID format was ${facts.nameIdFormat}`);
    assert(payload.action === acsUrl, `Keycloak posted to ${payload.action}, expected ${acsUrl}`);

    firstPost = payload;
    const out = await postAcs(payload);
    assert(!out.error, `sign-in was refused with '${out.error}'`);
    assert(out.code, `no one-time code in the ACS redirect: ${out.url}`);

    const exchanged = await api('POST', '/api/auth/sso/exchange', { body: { code: out.code } });
    assert(exchanged.status === 200 && exchanged.json?.success,
      `exchange failed: ${exchanged.status} ${JSON.stringify(exchanged.json)}`);
    const user = exchanged.json.data.user;
    assert(user, 'exchange returned no user');
    assert(user.email === IDP_USER_EMAIL, `provisioned user email was ${user.email}`);
    provisionedUserId = user.id;
    return `JIT-provisioned ${user.email} as ${user.role}, assertion ${facts.assertionId}`;
  });

  // =======================================================================
  // 2. Replaying that exact POST
  // =======================================================================
  await step('replaying the exact same POST is REFUSED', async () => {
    assert(firstPost, 'no successful sign-in to replay');
    const code = await expectRefusal(firstPost, ['state_mismatch', 'saml_replay', 'saml_request_mismatch']);
    return `refused with '${code}' (RelayState is single-use, so this refusal lands before the assertion is even parsed)`;
  });

  // =======================================================================
  // 3. A tampered assertion
  // =======================================================================
  await step('an assertion altered after signing is REFUSED (saml_bad_signature)', async () => {
    const payload = await spInitiated();
    const xml = decodeResponse(payload.samlResponse);
    assert(xml.includes(IDP_USER_EMAIL), 'could not find the user email in the assertion to tamper with');
    // Change the identity the assertion asserts, leaving the signature alone:
    // the canonical attacker move, and what the digest is there to catch.
    const tampered = xml.split(IDP_USER_EMAIL).join('attacker@e2e.shellius.test');
    const code = await expectRefusal(
      { samlResponse: encodeResponse(tampered), relayState: payload.relayState },
      ['saml_bad_signature', 'saml_invalid']
    );
    assert(code === 'saml_bad_signature', `expected saml_bad_signature, got ${code}`);
    return 'identity swapped after signing, digest check caught it';
  });

  await step("flipping a byte in the assertion's SignatureValue is REFUSED", async () => {
    const payload = await spInitiated();
    const xml = decodeResponse(payload.samlResponse);
    const mutated = flipCharIn(xml, 'SignatureValue', 'assertion');
    const code = await expectRefusal(
      { samlResponse: encodeResponse(mutated), relayState: payload.relayState },
      ['saml_bad_signature', 'saml_invalid']
    );
    assert(code === 'saml_bad_signature', `expected saml_bad_signature, got ${code}`);
    return 'one base64 character changed in the signature itself';
  });

  /**
   * The inverse, and the reason a blind "flip a byte somewhere in the base64"
   * test is meaningless here: most of a Keycloak response is NOT covered by
   * the assertion's signature, and the biggest such region is the
   * `<ds:KeyInfo>` certificate the document carries to vouch for itself.
   *
   * Corrupting it changes nothing that matters, because Shellius verifies
   * against the certificate the org configured and NEVER against the one in
   * the document — a document that vouches for itself proves nothing. So the
   * correct outcome is that the sign-in still succeeds, and that is what this
   * asserts. If it ever starts failing, something has begun trusting KeyInfo.
   */
  await step("corrupting the certificate in the assertion's own KeyInfo changes NOTHING", async () => {
    const payload = await spInitiated();
    const xml = decodeResponse(payload.samlResponse);
    const mutated = flipCharIn(xml, 'X509Certificate', 'assertion');
    const out = await postAcs({ samlResponse: encodeResponse(mutated), relayState: payload.relayState });
    assert(!out.error, `sign-in was refused with '${out.error}' — KeyInfo must not be a trust anchor either way`);
    assert(out.code, `no one-time code in the ACS redirect: ${out.url}`);
    return 'signature still verified against the CONFIGURED certificate; the embedded one is ignored';
  });

  // =======================================================================
  // 4. Expired
  // =======================================================================
  await step('an EXPIRED assertion is REFUSED (saml_expired)', async () => {
    const uuid = await clientUuid(spEntityId);
    const rep = await kcAdminJson(kcToken, 'GET', `/realms/${REALM}/clients/${uuid}`);
    const restore = { ...rep.attributes };
    try {
      // Shorten the assertion lifespan AT THE IDP rather than sleeping out a
      // default one, and drop our tolerated clock skew to zero for this check
      // so a 1-second assertion is actually expired a second later. Neither
      // weakens the check under test: skew is a supported setting and the
      // expiry being enforced is Keycloak's own NotOnOrAfter.
      await kcAdminJson(kcToken, 'PUT', `/realms/${REALM}/clients/${uuid}`, {
        ...rep,
        attributes: { ...rep.attributes, 'saml.assertion.lifespan': '1' },
      });
      await patchProvider({ samlClockSkewSec: 0 });

      const payload = await spInitiated();
      const facts = readResponseFacts(decodeResponse(payload.samlResponse));
      assert(facts.notOnOrAfter, 'assertion had no Conditions/@NotOnOrAfter');
      const expiresIn = Date.parse(facts.notOnOrAfter) - Date.now();
      assert(expiresIn < 120000, `assertion is valid for ${Math.round(expiresIn / 1000)}s — too long to wait out`);
      const waitMs = Math.max(0, expiresIn) + 2000;
      console.log(`    … assertion expires at ${facts.notOnOrAfter}; waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);

      const code = await expectRefusal(payload, ['saml_expired']);
      return `NotOnOrAfter ${facts.notOnOrAfter}, refused with '${code}'`;
    } finally {
      await kcAdminJson(kcToken, 'PUT', `/realms/${REALM}/clients/${uuid}`, { ...rep, attributes: restore });
      await patchProvider({ samlClockSkewSec: 60 });
    }
  });

  // =======================================================================
  // 5. Unsolicited POST while IdP-initiated is off
  // =======================================================================
  let unsolicited = null;
  await step('an unsolicited POST is REFUSED while samlAllowIdpInitiated is false', async () => {
    unsolicited = await idpInitiated(SSO_URL_NAME);
    const facts = readResponseFacts(decodeResponse(unsolicited.samlResponse));
    assert(!facts.inResponseTo, 'Keycloak put an InResponseTo on an unsolicited response');
    assert(!unsolicited.relayState, `unsolicited response carried a RelayState: ${unsolicited.relayState}`);
    const code = await expectRefusal({ samlResponse: unsolicited.samlResponse }, ['saml_idp_initiated_disabled']);
    return `genuinely unsolicited (no InResponseTo), refused with '${code}'`;
  });

  // =======================================================================
  // 6 + 7. Opt in to IdP-initiated: the single-use claim, isolated
  // =======================================================================
  await patchProvider({ samlAllowIdpInitiated: true });
  console.log('[e2e-saml] samlAllowIdpInitiated -> true (to isolate the assertion-ID single-use claim)');
  try {
    let idpPayload = null;

    await step('IdP-initiated sign-in SUCCEEDS once the org opts in', async () => {
      idpPayload = await idpInitiated(SSO_URL_NAME);
      const out = await postAcs({ samlResponse: idpPayload.samlResponse });
      assert(!out.error, `sign-in was refused with '${out.error}'`);
      assert(out.code, `no one-time code in the ACS redirect: ${out.url}`);
      const facts = readResponseFacts(decodeResponse(idpPayload.samlResponse));
      return `assertion ${facts.assertionId} accepted with no RelayState and no InResponseTo`;
    });

    await step('*** replaying that same response is REFUSED with saml_replay ***', async () => {
      assert(idpPayload, 'no IdP-initiated response to replay');
      // Nothing else can refuse this one: no RelayState to burn, no
      // InResponseTo to mismatch, a signature that verifies, an audience that
      // matches and a window that has not closed. If the atomic single-use
      // claim on the assertion ID is not working, this POST succeeds.
      const code = await expectRefusal({ samlResponse: idpPayload.samlResponse }, ['saml_replay']);
      return `refused with '${code}' — the single-use claim is the only control that could have done it`;
    });

    await step("an assertion for a DIFFERENT SP is REFUSED (saml_audience_mismatch)", async () => {
      const other = await idpInitiated(OTHER_SSO_URL_NAME);
      const facts = readResponseFacts(decodeResponse(other.samlResponse));
      assert(facts.audience === OTHER_SP_ENTITY_ID,
        `expected audience ${OTHER_SP_ENTITY_ID}, got ${facts.audience}`);
      assert(facts.destination === acsUrl,
        `the foreign assertion must be aimed at OUR ACS for this to test the audience check, got ${facts.destination}`);
      const code = await expectRefusal({ samlResponse: other.samlResponse }, ['saml_audience_mismatch']);
      return `valid signature from the same IdP, Audience=${facts.audience}, refused with '${code}'`;
    });
  } finally {
    await patchProvider({ samlAllowIdpInitiated: false });
    console.log('[e2e-saml] samlAllowIdpInitiated -> false');
  }

  // =======================================================================
  // Cleanup
  // =======================================================================
  if (!KEEP) {
    await api('DELETE', `/api/auth/sso/providers/${providerId}?force=true`, { token });
    if (provisionedUserId) {
      const del = await api('DELETE', `/api/users/${provisionedUserId}`, { token });
      if (del.status !== 200) console.warn(`[e2e-saml] could not delete the JIT user (${del.status})`);
    }
    console.log('[e2e-saml] removed the Shellius provider and the JIT-provisioned user');
  } else {
    console.log(`[e2e-saml] E2E_SAML_KEEP=1 — provider ${providerId} left in place`);
  }
  console.log(`[e2e-saml] the '${REALM}' Keycloak realm is left running; the next run recreates it`);

  console.log('');
  console.log(`[e2e-saml] ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.error('[e2e-saml] FAILURES:');
    for (const f of failures) console.error(`  - ${f.name}: ${f.msg}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[e2e-saml] fatal error:', err);
  process.exitCode = 1;
});
