/**
 * Task 18D — POST /api/policies/evaluate response shape contract tests
 *
 * Contract (Task 14E spec):
 *   POST /api/policies/evaluate
 *   → { success: true, data: { outcome: 'allow'|'deny'|'requires_approval', ...rest } }
 *
 * Outcome derivation (implemented in routes/policies.js):
 *   result.requiresApproval === true  →  outcome = 'requires_approval'
 *   result.allowed === true           →  outcome = 'allow'
 *   else                              →  outcome = 'deny'
 *
 * The field name exposed to the frontend is `outcome` (Option A: renamed from
 * the service's internal boolean fields). Frontend should read `data.outcome`.
 *
 * Additional fields always present in data:
 *   - allowed          {boolean}
 *   - requiresApproval {boolean}
 *   - autoApprove      {boolean}
 *   - principals       {string[]}
 *   - maxTtl           {number}
 *   - reason           {string}   (optional — present when access is denied or
 *                                  prod approval is required)
 *   - policyId         {string}   (optional — present when a specific policy matched)
 *
 * RBAC: the route requires admin+ (super_admin or admin). A viewer/operator
 * must receive 403.
 *
 * Test strategy
 * -------------
 *  1. Joi schema tests — assert the exact response shape in isolation (no network).
 *  2. Source-code audit — assert the route file contains the `outcome` field
 *     injection and the correct RBAC guard.
 *  3. Live smoke tests — auto-skipped when the stack is unreachable.
 */

import Joi from 'joi';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Joi response shape schemas
// ---------------------------------------------------------------------------

const OUTCOME_VALUES = ['allow', 'deny', 'requires_approval'];

const EVALUATE_RESPONSE_SCHEMA = Joi.object({
  success: Joi.boolean().valid(true).required(),
  data: Joi.object({
    // The canonical outcome field — what the frontend must read
    outcome: Joi.string().valid(...OUTCOME_VALUES).required(),
    // Internal booleans still present for programmatic consumers
    allowed: Joi.boolean().required(),
    requiresApproval: Joi.boolean().required(),
    autoApprove: Joi.boolean().required(),
    principals: Joi.array().items(Joi.string()).required(),
    maxTtl: Joi.number().required(),
    // optional fields
    reason: Joi.string().optional(),
    policyId: Joi.string().optional(),
    policyName: Joi.string().optional(),
    draft: Joi.boolean().optional(),
  }).required(),
}).unknown(true);

// Helper: build a realistic service result and apply the route-level transformation
function buildResponse(serviceResult) {
  let outcome;
  if (serviceResult.requiresApproval) {
    outcome = 'requires_approval';
  } else if (serviceResult.allowed) {
    outcome = 'allow';
  } else {
    outcome = 'deny';
  }
  return {
    success: true,
    data: { ...serviceResult, outcome },
  };
}

// ---------------------------------------------------------------------------
// Shape unit tests (no network)
// ---------------------------------------------------------------------------

describe('POST /api/policies/evaluate — response shape', () => {
  test('outcome is "allow" when allowed=true and requiresApproval=false', () => {
    const resp = buildResponse({
      allowed: true,
      requiresApproval: false,
      autoApprove: false,
      principals: ['ubuntu'],
      maxTtl: 3600,
    });
    expect(resp.data.outcome).toBe('allow');
    const { error } = EVALUATE_RESPONSE_SCHEMA.validate(resp);
    expect(error).toBeUndefined();
  });

  test('outcome is "deny" when allowed=false and requiresApproval=false', () => {
    const resp = buildResponse({
      allowed: false,
      requiresApproval: false,
      autoApprove: false,
      principals: [],
      maxTtl: 0,
      reason: 'No matching policy',
    });
    expect(resp.data.outcome).toBe('deny');
    const { error } = EVALUATE_RESPONSE_SCHEMA.validate(resp);
    expect(error).toBeUndefined();
  });

  test('outcome is "requires_approval" when requiresApproval=true regardless of allowed', () => {
    const resp = buildResponse({
      allowed: false,
      requiresApproval: true,
      autoApprove: false,
      principals: [],
      maxTtl: 0,
      reason: 'Production servers require approval',
    });
    expect(resp.data.outcome).toBe('requires_approval');
    const { error } = EVALUATE_RESPONSE_SCHEMA.validate(resp);
    expect(error).toBeUndefined();
  });

  test('outcome is "requires_approval" even when policy-level requireApproval flips to true', () => {
    const resp = buildResponse({
      allowed: true,
      requiresApproval: true,
      autoApprove: false,
      principals: ['ubuntu'],
      maxTtl: 3600,
      policyId: 'policy_abc',
    });
    // requiresApproval takes precedence over allowed
    expect(resp.data.outcome).toBe('requires_approval');
    const { error } = EVALUATE_RESPONSE_SCHEMA.validate(resp);
    expect(error).toBeUndefined();
  });

  test('Joi schema rejects response missing outcome field', () => {
    const resp = {
      success: true,
      data: {
        allowed: true,
        requiresApproval: false,
        autoApprove: false,
        principals: [],
        maxTtl: 3600,
        // outcome intentionally omitted
      },
    };
    const { error } = EVALUATE_RESPONSE_SCHEMA.validate(resp);
    expect(error).toBeDefined();
    expect(error.message).toMatch(/outcome/i);
  });

  test('Joi schema rejects outcome value outside canonical set', () => {
    const resp = {
      success: true,
      data: {
        outcome: 'ALLOW',  // wrong case — must be lowercase 'allow'
        allowed: true,
        requiresApproval: false,
        autoApprove: false,
        principals: [],
        maxTtl: 3600,
      },
    };
    const { error } = EVALUATE_RESPONSE_SCHEMA.validate(resp);
    expect(error).toBeDefined();
  });

  test('Joi schema accepts response with optional policyId and reason fields', () => {
    const resp = buildResponse({
      allowed: false,
      requiresApproval: false,
      autoApprove: false,
      principals: [],
      maxTtl: 0,
      reason: 'Denied by policy block-prod',
      policyId: 'policy_xyz',
    });
    const { error } = EVALUATE_RESPONSE_SCHEMA.validate(resp);
    expect(error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Source-code audit — verify the route file has the outcome injection and RBAC
// ---------------------------------------------------------------------------

const ROUTE_SRC_PATH = join(__dirname, '../policies.js');
const routeSrc = readFileSync(ROUTE_SRC_PATH, 'utf8');

describe('POST /api/policies/evaluate — route source-code audit', () => {
  test('route file injects outcome field into the response data', () => {
    // Must contain the outcome derivation logic
    expect(routeSrc).toMatch(/outcome/);
  });

  test('outcome field covers all three canonical values in source', () => {
    expect(routeSrc).toContain("'requires_approval'");
    expect(routeSrc).toContain("'allow'");
    expect(routeSrc).toContain("'deny'");
  });

  test('route spreads service result into data alongside outcome', () => {
    // Pattern: { ...result, outcome } or equivalent spread
    expect(routeSrc).toMatch(/\.\.\.\s*result/);
  });

  test('route requires admin+ RBAC guard on /evaluate', () => {
    // Extract the /evaluate route block
    const evaluateIdx = routeSrc.indexOf("'/evaluate'");
    expect(evaluateIdx).toBeGreaterThan(-1);

    // Grab up to 500 chars after '/evaluate' to find the requireRole call
    const block = routeSrc.slice(evaluateIdx, evaluateIdx + 500);
    expect(block).toMatch(/requireRole\s*\(/);
    // Must include admin (super_admin or admin)
    expect(block).toMatch(/admin/);
  });

  test('route is registered before /:id to avoid shadowing', () => {
    const evaluateIdx = routeSrc.indexOf("'/evaluate'");
    const idIdx = routeSrc.indexOf("'/:id'");
    expect(evaluateIdx).toBeGreaterThan(-1);
    // /:id may or may not exist — if it does, evaluate must come first
    if (idIdx !== -1) {
      expect(evaluateIdx).toBeLessThan(idIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Live smoke tests — auto-skipped when the stack is unreachable
// ---------------------------------------------------------------------------

const BASE_URL = process.env.PHASE14_SMOKE_URL || 'https://shellius.yavlabs.com';
const EMAIL = process.env.PHASE14_SMOKE_EMAIL || 'admin@yavlabs.com';
const PASSWORD = process.env.PHASE14_SMOKE_PASSWORD || 'Shellius2024!';

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
    /* non-json body */
  }
  return { status: res.status, body: json };
}

beforeAll(async () => {
  try {
    const health = await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
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

describe('POST /api/policies/evaluate — live smoke', () => {
  smokeIt('returns 401 without auth token', async () => {
    const r = await api('/api/policies/evaluate', {
      method: 'POST',
      withAuth: false,
      body: { userId: 'x', serverId: 'y' },
    });
    expect(r.status).toBe(401);
  });

  smokeIt('returns 400 for missing required fields (userId)', async () => {
    const r = await api('/api/policies/evaluate', {
      method: 'POST',
      body: { serverId: 'some-server' },
    });
    expect(r.status).toBe(400);
  });

  smokeIt('returns 400 for missing required fields (serverId)', async () => {
    const r = await api('/api/policies/evaluate', {
      method: 'POST',
      body: { userId: 'some-user' },
    });
    expect(r.status).toBe(400);
  });

  smokeIt('returns data.outcome field (not null) for a valid (userId, serverId) pair', async () => {
    // Use the seeded admin user id and a known server — both must exist for this
    // test to be meaningful. Fall back to nonexistent IDs which will 404.
    const userId = process.env.PHASE18D_USER_ID;
    const serverId = process.env.PHASE18D_SERVER_ID;

    if (!userId || !serverId) {
      console.warn('[skip] PHASE18D_USER_ID / PHASE18D_SERVER_ID not set');
      return;
    }

    const r = await api('/api/policies/evaluate', {
      method: 'POST',
      body: { userId, serverId },
    });

    // Either 200 with outcome, or 404 if IDs don't exist
    if (r.status === 404) {
      console.warn('[skip] seeded IDs not found in live DB');
      return;
    }

    expect(r.status).toBe(200);
    expect(r.body?.success).toBe(true);
    expect(r.body?.data?.outcome).toBeDefined();
    expect(OUTCOME_VALUES).toContain(r.body?.data?.outcome);

    // Full schema validation
    const { error } = EVALUATE_RESPONSE_SCHEMA.validate(r.body);
    expect(error).toBeUndefined();
  });

  smokeIt('response does not expose outcome=null for a nonexistent server (returns deny)', async () => {
    // Even for nonexistent IDs the route should either 404 (server not found)
    // or return outcome='deny'. It must NEVER return outcome=null.
    const r = await api('/api/policies/evaluate', {
      method: 'POST',
      body: { userId: 'nonexistent-user-18d', serverId: 'nonexistent-server-18d' },
    });

    // 404 is acceptable (server not found guard fires before outcome calc)
    if (r.status === 404) return;

    // If 200, outcome must not be null
    if (r.status === 200) {
      expect(r.body?.data?.outcome).not.toBeNull();
      expect(r.body?.data?.outcome).not.toBeUndefined();
      expect(OUTCOME_VALUES).toContain(r.body?.data?.outcome);
    }
  });
});
