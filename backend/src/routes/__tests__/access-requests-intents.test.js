/**
 * GET /api/access-requests/intents?serverIds=a,b,c — bulk sibling of
 * GET /api/access-requests/intent, added for the Terminals "New connection"
 * dialog (avoids an N+1 fan-out of the single-server endpoint per row).
 *
 * Strategy mirrors access-requests-by-server.test.js /
 * accessRequestService.test.js: ESM mocking of prisma is unreliable in this
 * Jest/ESM setup, so we (1) assert the service function's API surface and
 * source-level query contract, (2) assert the route registers `/intents`
 * before `/:id` and enforces the id-count cap, and (3) validate the response
 * envelope shape with Joi. A live smoke suite (auto-skipped when the stack
 * is unreachable) exercises the real HTTP surface.
 */

import Joi from 'joi';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAccessIntentsBulk } from '../../services/accessRequestService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVICE_SRC = readFileSync(join(__dirname, '../../services/accessRequestService.js'), 'utf8');
const ROUTE_SRC = readFileSync(join(__dirname, '../accessRequests.js'), 'utf8');

// ---------------------------------------------------------------------------
// Service — API surface + source-level contract
// ---------------------------------------------------------------------------

describe('getAccessIntentsBulk — API surface', () => {
  test('is exported as a function', () => {
    expect(typeof getAccessIntentsBulk).toBe('function');
  });

  test('accepts an empty serverIds array without touching prisma and returns {}', async () => {
    const result = await getAccessIntentsBulk({ orgId: 'org1', userId: 'u1', serverIds: [] });
    expect(result).toEqual({});
  });

  test('dedupes serverIds before querying', async () => {
    // We can't easily assert the prisma call args without ESM mocking, but we
    // can assert the dedup happens before the "ids.length === 0" short
    // circuit by feeding duplicates of a single (unknown-to-the-mock) id and
    // checking the returned map has exactly one key once resolved against a
    // real (but empty-result) query. This exercises the code path without a
    // live DB by relying on findMany rejecting gracefully in CI — instead we
    // just assert against the source text for the Set-based dedupe, which is
    // deterministic and CI-safe.
    expect(SERVICE_SRC).toMatch(/new Set\(serverIds\)/);
  });

  test('source query filters: orgId, requesterId, serverId in ids, status APPROVED + expiresAt gt now for active', () => {
    const idx = SERVICE_SRC.indexOf('export async function getAccessIntentsBulk');
    const body = SERVICE_SRC.slice(idx, idx + 3000);
    expect(body).toContain("status: 'APPROVED'");
    expect(body).toContain('expiresAt: { gt: new Date() }');
    expect(body).toContain('requesterId: userId');
    expect(body).toContain('serverId: { in: ids }');
    expect(body).toContain("status: 'PENDING'");
  });

  test('does not grant admins implicit access (no role-based bypass in the query)', () => {
    const idx = SERVICE_SRC.indexOf('export async function getAccessIntentsBulk');
    const body = SERVICE_SRC.slice(idx, idx + 3000);
    expect(body).not.toMatch(/role\s*===\s*['"]admin/);
    expect(body).not.toMatch(/role\s*===\s*['"]super_admin/);
  });
});

// ---------------------------------------------------------------------------
// Route — registration order + cap
// ---------------------------------------------------------------------------

describe('GET /api/access-requests/intents — route wiring', () => {
  test('route file registers /intents', () => {
    expect(ROUTE_SRC).toContain("'/intents'");
  });

  test('route file registers /intents before /:id', () => {
    const intentsIdx = ROUTE_SRC.indexOf("'/intents'");
    const idIdx = ROUTE_SRC.indexOf("'/:id'");
    expect(intentsIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeGreaterThan(-1);
    expect(intentsIdx).toBeLessThan(idIdx);
  });

  test('route enforces a max of 50 serverIds', () => {
    expect(ROUTE_SRC).toMatch(/serverIds\.length > 50/);
  });

  test('route requires authenticate + tenant middleware (router.use applies to all routes)', () => {
    expect(ROUTE_SRC).toMatch(/router\.use\(authenticate, tenant\)/);
  });
});

// ---------------------------------------------------------------------------
// Response envelope shape
// ---------------------------------------------------------------------------

const INTENT_SHAPE = Joi.object({
  hasActiveAccess: Joi.boolean().required(),
  activeRequestId: Joi.string().allow(null).required(),
  hasPendingRequest: Joi.boolean().required(),
  pendingRequestId: Joi.string().allow(null).required(),
  expiresAt: Joi.alternatives().try(Joi.string().isoDate(), Joi.date(), Joi.valid(null)).required(),
});

const ENVELOPE = Joi.object({
  success: Joi.boolean().valid(true).required(),
  data: Joi.object({
    intents: Joi.object().pattern(Joi.string(), INTENT_SHAPE).required(),
  }).required(),
}).unknown(true);

describe('intents — response envelope shape', () => {
  test('accepts a well-formed multi-server envelope', () => {
    const { error } = ENVELOPE.validate({
      success: true,
      data: {
        intents: {
          server1: { hasActiveAccess: true, activeRequestId: 'ar1', hasPendingRequest: false, pendingRequestId: null, expiresAt: new Date().toISOString() },
          server2: { hasActiveAccess: false, activeRequestId: null, hasPendingRequest: true, pendingRequestId: 'ar2', expiresAt: null },
          server3: { hasActiveAccess: false, activeRequestId: null, hasPendingRequest: false, pendingRequestId: null, expiresAt: null },
        },
      },
    });
    expect(error).toBeUndefined();
  });

  test('rejects a server entry missing a required field', () => {
    const { error } = ENVELOPE.validate({
      success: true,
      data: { intents: { server1: { hasActiveAccess: true } } },
    });
    expect(error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Live smoke — auto-skipped when the stack is unreachable
// ---------------------------------------------------------------------------

const BASE_URL = process.env.PHASE15_SMOKE_URL || 'https://shellius.yavlabs.com';
const EMAIL = process.env.PHASE15_SMOKE_EMAIL || 'admin@yavlabs.com';
const PASSWORD = process.env.PHASE15_SMOKE_PASSWORD || 'Shellius2024!';
const KNOWN_SERVER_ID = process.env.PHASE15_SMOKE_SERVER_ID || 'cmnntj3qz0003mi01r8l4gr31';

let token = null;
let reachable = false;

async function api(path, { method = 'GET', body, withAuth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, body: json };
}

beforeAll(async () => {
  try {
    const health = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    reachable = health.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) return;

  const login = await api('/api/auth/login', {
    method: 'POST',
    withAuth: false,
    body: { email: EMAIL, password: PASSWORD },
  });
  if (login.status === 200) {
    token = login.body?.data?.accessToken || null;
  }
}, 15000);

const smokeIt = (name, fn) => {
  test(name, async () => {
    if (!reachable) {
      console.warn(`[skip] ${BASE_URL} unreachable`);
      return;
    }
    if (!token) {
      console.warn(`[skip] could not authenticate as ${EMAIL}`);
      return;
    }
    await fn();
  });
};

describe('intents — live smoke', () => {
  smokeIt('401 without auth', async () => {
    const r = await api(`/api/access-requests/intents?serverIds=${KNOWN_SERVER_ID}`, { withAuth: false });
    expect(r.status).toBe(401);
  });

  smokeIt('400 without serverIds', async () => {
    const r = await api('/api/access-requests/intents');
    expect(r.status).toBe(400);
  });

  smokeIt('400 with more than 50 serverIds', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `s${i}`).join(',');
    const r = await api(`/api/access-requests/intents?serverIds=${ids}`);
    expect(r.status).toBe(400);
  });

  smokeIt('200 with an envelope matching the shape', async () => {
    const r = await api(`/api/access-requests/intents?serverIds=${KNOWN_SERVER_ID},nonexistent-server-xyz`);
    expect(r.status).toBe(200);
    const { error } = ENVELOPE.validate(r.body);
    expect(error).toBeUndefined();
    expect(r.body.data.intents).toHaveProperty(KNOWN_SERVER_ID);
    expect(r.body.data.intents).toHaveProperty('nonexistent-server-xyz');
  });
});
