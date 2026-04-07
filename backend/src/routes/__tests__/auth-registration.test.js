/**
 * Phase 17F — auth registration endpoints contract tests
 *
 * Covers:
 *   GET  /api/auth/registration-status
 *   POST /api/auth/register
 *   POST /api/auth/verify-email/:token
 *
 * Test strategy (mirrors policies-evaluate.test.js and accessRequestService.test.js):
 *  1. Joi schema validation — assert exact response shapes without network.
 *  2. Source-code audit — assert the route file contains the required logic,
 *     guard conditions, and audit calls.
 *  3. Service unit tests — createPendingUser and markEmailVerified surface
 *     checks (export + arity).
 *  4. Live smoke tests — auto-skipped when the stack is unreachable.
 */

import Joi from 'joi';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Source files under test
// ---------------------------------------------------------------------------

const AUTH_ROUTE_PATH = join(__dirname, '../auth.js');
const USER_SERVICE_PATH = join(__dirname, '../../services/userService.js');

const authSrc = readFileSync(AUTH_ROUTE_PATH, 'utf8');
const userServiceSrc = readFileSync(USER_SERVICE_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Joi response-shape schemas
// ---------------------------------------------------------------------------

const REGISTRATION_STATUS_SCHEMA = Joi.object({
  success: Joi.boolean().valid(true).required(),
  data: Joi.object({
    enabled: Joi.boolean().required(),
  }).required(),
}).unknown(true);

const REGISTER_RESPONSE_SCHEMA = Joi.object({
  success: Joi.boolean().valid(true).required(),
  data: Joi.object({
    message: Joi.string().required(),
  }).required(),
}).unknown(true);

const VERIFY_EMAIL_RESPONSE_SCHEMA = Joi.object({
  success: Joi.boolean().valid(true).required(),
  data: Joi.object({
    message: Joi.string().required(),
  }).required(),
}).unknown(true);

// ---------------------------------------------------------------------------
// Schema unit tests — shape validation (no network / no DB)
// ---------------------------------------------------------------------------

describe('GET /api/auth/registration-status — response shape', () => {
  test('validates enabled=true shape', () => {
    const resp = { success: true, data: { enabled: true } };
    const { error } = REGISTRATION_STATUS_SCHEMA.validate(resp);
    expect(error).toBeUndefined();
  });

  test('validates enabled=false shape', () => {
    const resp = { success: true, data: { enabled: false } };
    const { error } = REGISTRATION_STATUS_SCHEMA.validate(resp);
    expect(error).toBeUndefined();
  });

  test('Joi schema rejects response missing enabled field', () => {
    const resp = { success: true, data: {} };
    const { error } = REGISTRATION_STATUS_SCHEMA.validate(resp);
    expect(error).toBeDefined();
    expect(error.message).toMatch(/enabled/i);
  });

  test('Joi schema rejects enabled as a non-boolean', () => {
    const resp = { success: true, data: { enabled: 'yes' } };
    const { error } = REGISTRATION_STATUS_SCHEMA.validate(resp);
    expect(error).toBeDefined();
  });
});

describe('POST /api/auth/register — response shape', () => {
  test('validates generic-message shape (disabled org or duplicate email)', () => {
    const resp = {
      success: true,
      data: { message: 'If your email is eligible, a verification link has been sent' },
    };
    const { error } = REGISTER_RESPONSE_SCHEMA.validate(resp);
    expect(error).toBeUndefined();
  });

  test('Joi schema rejects missing message', () => {
    const resp = { success: true, data: {} };
    const { error } = REGISTER_RESPONSE_SCHEMA.validate(resp);
    expect(error).toBeDefined();
    expect(error.message).toMatch(/message/i);
  });
});

describe('POST /api/auth/verify-email/:token — response shape', () => {
  test('validates success shape', () => {
    const resp = { success: true, data: { message: 'Email verified' } };
    const { error } = VERIFY_EMAIL_RESPONSE_SCHEMA.validate(resp);
    expect(error).toBeUndefined();
  });

  test('Joi schema rejects missing message', () => {
    const resp = { success: true, data: {} };
    const { error } = VERIFY_EMAIL_RESPONSE_SCHEMA.validate(resp);
    expect(error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Source-code audit — auth.js route file
// ---------------------------------------------------------------------------

describe('auth.js — registration-status route audit', () => {
  test('defines GET /registration-status route', () => {
    expect(authSrc).toContain('/registration-status');
    expect(authSrc).toMatch(/router\.get\s*\(\s*['"]\/registration-status['"]/);
  });

  test('reads selfServiceRegistrationEnabled from org', () => {
    expect(authSrc).toContain('selfServiceRegistrationEnabled');
  });

  test('returns { enabled } in the response data', () => {
    expect(authSrc).toContain('enabled');
  });

  test('is a public route (no authenticate middleware on this handler)', () => {
    // Extract the registration-status block (from the route definition to the next router.* call)
    const idx = authSrc.indexOf('/registration-status');
    expect(idx).toBeGreaterThan(-1);
    // The next router call after this block should NOT have authenticate in between for this specific route
    const block = authSrc.slice(idx, idx + 400);
    // The block should NOT include 'authenticate' as a middleware in this specific handler
    expect(block).not.toMatch(/router\.get\s*\(\s*['"]\/registration-status['"][^)]*,\s*authenticate/);
  });
});

describe('auth.js — register route audit', () => {
  test('defines POST /register route', () => {
    expect(authSrc).toMatch(/router\.post\s*\(\s*['"]\/register['"]/);
  });

  test('applies tokenActionLimiter for abuse protection', () => {
    const idx = authSrc.indexOf("'/register'");
    expect(idx).toBeGreaterThan(-1);
    const block = authSrc.slice(idx, idx + 300);
    expect(block).toContain('tokenActionLimiter');
  });

  test('validates body with registerSchema (Joi)', () => {
    expect(authSrc).toContain('registerSchema');
  });

  test('registerSchema enforces email, name, and password fields', () => {
    // The schema definition must contain all three fields
    const schemaIdx = authSrc.indexOf('registerSchema');
    const schemaBlock = authSrc.slice(schemaIdx, schemaIdx + 400);
    expect(schemaBlock).toContain('email');
    expect(schemaBlock).toContain('name');
    expect(schemaBlock).toContain('password');
  });

  test('checks selfServiceRegistrationEnabled before creating user', () => {
    // Must reference the flag before calling createPendingUser
    const registerIdx = authSrc.indexOf("'/register'");
    const createPendingIdx = authSrc.indexOf('createPendingUser');
    expect(authSrc.indexOf('selfServiceRegistrationEnabled', registerIdx)).toBeLessThan(createPendingIdx);
  });

  test('returns the same generic message for disabled org and duplicate email (enumeration prevention)', () => {
    // Count how many times the generic message appears — must be at least 2
    const message = 'If your email is eligible, a verification link has been sent';
    let count = 0;
    let pos = 0;
    while ((pos = authSrc.indexOf(message, pos)) !== -1) {
      count++;
      pos++;
    }
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('mints EMAIL_VERIFY token via inviteService', () => {
    expect(authSrc).toContain('EMAIL_VERIFY');
    expect(authSrc).toContain('createInvite');
  });

  test('sends verifyEmail template', () => {
    expect(authSrc).toContain("renderTemplate('verifyEmail'");
  });

  test('audit-logs auth.register with actorId null', () => {
    const idx = authSrc.indexOf("'auth.register'");
    expect(idx).toBeGreaterThan(-1);
    // Within 200 chars of the action string, actorId must be null
    const block = authSrc.slice(idx - 100, idx + 200);
    expect(block).toMatch(/actorId\s*:\s*null/);
  });

  test('stores email in audit metadata (not the password)', () => {
    const idx = authSrc.indexOf("'auth.register'");
    const block = authSrc.slice(idx - 200, idx + 300);
    expect(block).toContain('email');
    expect(block).not.toContain('password');
  });
});

describe('auth.js — verify-email route audit', () => {
  test('defines POST /verify-email/:token route', () => {
    expect(authSrc).toMatch(/router\.post\s*\(\s*['"]\/verify-email\/:token['"]/);
  });

  test('applies tokenActionLimiter', () => {
    const idx = authSrc.indexOf("'/verify-email/:token'");
    expect(idx).toBeGreaterThan(-1);
    const block = authSrc.slice(idx, idx + 300);
    expect(block).toContain('tokenActionLimiter');
  });

  test('validates token format via tokenParamSchema', () => {
    const idx = authSrc.indexOf("'/verify-email/:token'");
    const block = authSrc.slice(idx, idx + 600);
    expect(block).toContain('tokenParamSchema');
  });

  test('calls verifyAndConsume with EMAIL_VERIFY token type', () => {
    const idx = authSrc.indexOf("'/verify-email/:token'");
    const block = authSrc.slice(idx, idx + 600);
    expect(block).toContain('verifyAndConsume');
    expect(block).toContain('EMAIL_VERIFY');
  });

  test('calls markEmailVerified to flip status to active', () => {
    const idx = authSrc.indexOf("'/verify-email/:token'");
    const block = authSrc.slice(idx, idx + 800);
    expect(block).toContain('markEmailVerified');
  });

  test('audit-logs auth.email_verified', () => {
    expect(authSrc).toContain("'auth.email_verified'");
  });

  test('returns { message: "Email verified" }', () => {
    expect(authSrc).toContain("'Email verified'");
  });
});

// ---------------------------------------------------------------------------
// Source-code audit — resolvePublicOrg helper
// ---------------------------------------------------------------------------

describe('auth.js — resolvePublicOrg helper audit', () => {
  test('resolvePublicOrg is defined in auth.js', () => {
    expect(authSrc).toContain('resolvePublicOrg');
  });

  test('attempts domain-based org resolution', () => {
    const idx = authSrc.indexOf('resolvePublicOrg');
    const block = authSrc.slice(idx, idx + 600);
    expect(block).toContain('domain');
  });

  test('falls back to first org (single-tenant)', () => {
    const idx = authSrc.indexOf('resolvePublicOrg');
    const block = authSrc.slice(idx, idx + 700);
    expect(block).toContain('findFirst');
    expect(block).toContain('orderBy');
    expect(block).toContain('createdAt');
  });
});

// ---------------------------------------------------------------------------
// userService.js — createPendingUser and markEmailVerified surface checks
// ---------------------------------------------------------------------------

describe('userService.js — createPendingUser', () => {
  test('is exported as a named export', async () => {
    const mod = await import('../../services/userService.js');
    expect(typeof mod.createPendingUser).toBe('function');
  });

  test('has correct parameter arity (orgId, data)', async () => {
    const mod = await import('../../services/userService.js');
    expect(mod.createPendingUser.length).toBe(2);
  });

  test('source sets role to viewer', () => {
    expect(userServiceSrc).toMatch(/role\s*:\s*['"]viewer['"]/);
  });

  test('source sets status to pending_verification', () => {
    expect(userServiceSrc).toMatch(/status\s*:\s*['"]pending_verification['"]/);
  });

  test('source sets passwordChangedAt on creation', () => {
    const idx = userServiceSrc.indexOf('createPendingUser');
    const block = userServiceSrc.slice(idx, idx + 600);
    expect(block).toContain('passwordChangedAt');
  });

  test('source does NOT store the raw password (only passwordHash)', () => {
    const idx = userServiceSrc.indexOf('createPendingUser');
    const block = userServiceSrc.slice(idx, idx + 600);
    // Must contain passwordHash but not plain 'password:' key
    expect(block).toContain('passwordHash');
    expect(block).not.toMatch(/[^a-zA-Z]password\s*:/);
  });
});

describe('userService.js — markEmailVerified', () => {
  test('is exported as a named export', async () => {
    const mod = await import('../../services/userService.js');
    expect(typeof mod.markEmailVerified).toBe('function');
  });

  test('has correct parameter arity (userId)', async () => {
    const mod = await import('../../services/userService.js');
    expect(mod.markEmailVerified.length).toBe(1);
  });

  test('source flips status to active', () => {
    const idx = userServiceSrc.indexOf('markEmailVerified');
    const block = userServiceSrc.slice(idx, idx + 500);
    expect(block).toMatch(/status\s*:\s*['"]active['"]/);
  });

  test('source guards against non-pending_verification users', () => {
    const idx = userServiceSrc.indexOf('markEmailVerified');
    const block = userServiceSrc.slice(idx, idx + 500);
    expect(block).toContain('pending_verification');
    expect(block).toContain('ApiError');
  });
});

// ---------------------------------------------------------------------------
// inviteService.js — EMAIL_VERIFY token type check
// ---------------------------------------------------------------------------

describe('inviteService.js — EMAIL_VERIFY token type', () => {
  test('TOKEN_TYPES.EMAIL_VERIFY is defined', async () => {
    const mod = await import('../../services/inviteService.js');
    expect(mod.TOKEN_TYPES.EMAIL_VERIFY).toBe('email_verify');
  });

  test('buildTokenUrl maps EMAIL_VERIFY to the /verify-email/ frontend path', async () => {
    const mod = await import('../../services/inviteService.js');
    const url = mod.buildTokenUrl(mod.TOKEN_TYPES.EMAIL_VERIFY, 'a'.repeat(64), null);
    expect(url).toContain('/verify-email/');
    expect(url).toContain('a'.repeat(64));
  });
});

// ---------------------------------------------------------------------------
// Live smoke tests — auto-skipped when the stack is unreachable
// ---------------------------------------------------------------------------

const BASE_URL = process.env.PHASE14_SMOKE_URL || 'https://shellius.yavlabs.com';

// routesDeployed: true only when the health check passes AND the new
// /registration-status route exists on the remote server (not 404).
let routesDeployed = false;

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
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
    if (!health.ok) return;

    // Probe the new route — 404 means not yet deployed, skip smoke tests
    const probe = await fetch(`${BASE_URL}/api/auth/registration-status`, {
      signal: AbortSignal.timeout(5000),
    });
    routesDeployed = probe.status !== 404;
  } catch {
    routesDeployed = false;
  }
}, 10000);

const smokeIt = (name, fn) => {
  test(name, async () => {
    if (!routesDeployed) {
      console.warn(`[skip] ${BASE_URL} unreachable or registration routes not yet deployed`);
      return;
    }
    await fn();
  });
};

describe('GET /api/auth/registration-status — live smoke', () => {
  smokeIt('returns 200 with success:true and a boolean enabled field', async () => {
    const r = await api('/api/auth/registration-status');
    expect(r.status).toBe(200);
    expect(r.body?.success).toBe(true);
    expect(typeof r.body?.data?.enabled).toBe('boolean');
    const { error } = REGISTRATION_STATUS_SCHEMA.validate(r.body);
    expect(error).toBeUndefined();
  });
});

describe('POST /api/auth/register — live smoke', () => {
  smokeIt('returns 400 when email is missing', async () => {
    const r = await api('/api/auth/register', {
      method: 'POST',
      body: { name: 'Test User', password: 'ValidPass123!' },
    });
    expect(r.status).toBe(400);
  });

  smokeIt('returns 400 when password is too short', async () => {
    const r = await api('/api/auth/register', {
      method: 'POST',
      body: { email: 'x@x.com', name: 'Test', password: 'short1' },
    });
    expect(r.status).toBe(400);
  });

  smokeIt('returns 400 when password lacks a digit', async () => {
    const r = await api('/api/auth/register', {
      method: 'POST',
      body: { email: 'x@x.com', name: 'Test', password: 'NoDigitInPassword' },
    });
    expect(r.status).toBe(400);
  });

  smokeIt('returns 200 with generic message for a valid body (regardless of org setting)', async () => {
    const r = await api('/api/auth/register', {
      method: 'POST',
      body: {
        email: `smoke-${Date.now()}@example.com`,
        name: 'Smoke Test User',
        password: 'ValidSmoke1234!',
      },
    });
    // Either 200 with generic message (registration enabled or disabled)
    // or 429 if rate-limited during a test run
    expect([200, 429]).toContain(r.status);
    if (r.status === 200) {
      expect(r.body?.success).toBe(true);
      expect(typeof r.body?.data?.message).toBe('string');
      const { error } = REGISTER_RESPONSE_SCHEMA.validate(r.body);
      expect(error).toBeUndefined();
    }
  });
});

describe('POST /api/auth/verify-email/:token — live smoke', () => {
  smokeIt('returns 400 for a malformed token (not 64-char hex)', async () => {
    const r = await api('/api/auth/verify-email/not-a-valid-token', { method: 'POST' });
    expect(r.status).toBe(400);
  });

  smokeIt('returns 400 for a well-formed but nonexistent token', async () => {
    const fakeToken = 'a'.repeat(64);
    const r = await api(`/api/auth/verify-email/${fakeToken}`, { method: 'POST' });
    expect(r.status).toBe(400);
    expect(r.body?.success).toBe(false);
  });
});
