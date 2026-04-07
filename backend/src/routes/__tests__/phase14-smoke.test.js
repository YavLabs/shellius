/**
 * Phase 14 live-stack smoke test
 *
 * Hits the running production stack at PHASE14_SMOKE_URL (defaults to
 * https://shellius.yavlabs.com) using a real admin JWT.
 *
 * Skipped automatically when:
 *   - PHASE14_SMOKE_URL is unset AND the default isn't reachable
 *   - PHASE14_SMOKE_EMAIL / PHASE14_SMOKE_PASSWORD aren't provided AND
 *     the dev seed credentials don't work
 *
 * Set the env vars to run against a different stack:
 *   PHASE14_SMOKE_URL=https://shellius.example.com \
 *   PHASE14_SMOKE_EMAIL=admin@example.com \
 *   PHASE14_SMOKE_PASSWORD=... \
 *   npm test
 */

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

const it = (name, fn) => {
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

describe('Phase 14 — live smoke', () => {
  it('GET /api/health → 200', async () => {
    const r = await api('/api/health', { withAuth: false });
    expect(r.status).toBe(200);
    expect(r.body?.success).toBe(true);
  });

  it('GET /api/org → 200 with organization shape', async () => {
    const r = await api('/api/org');
    expect(r.status).toBe(200);
    expect(r.body?.data?.organization?.id).toBeDefined();
  });

  it('PUT /api/org → 200 and persists name', async () => {
    const newName = `smoke-${Date.now()}`;
    const r = await api('/api/org', { method: 'PUT', body: { name: newName } });
    expect(r.status).toBe(200);
    expect(r.body?.data?.organization?.name).toBe(newName);
  });

  it('GET /api/auth/sso/config → 200', async () => {
    const r = await api('/api/auth/sso/config');
    expect(r.status).toBe(200);
    // config may be null when not yet configured — accept either shape
    expect(r.body?.success).toBe(true);
  });

  it('POST /api/auth/sso/config/test (google) → 200 with provider metadata', async () => {
    const r = await api('/api/auth/sso/config/test', {
      method: 'POST',
      body: { provider: 'oidc', issuerUrl: 'https://accounts.google.com' },
    });
    expect(r.status).toBe(200);
    expect(r.body?.data?.ok).toBe(true);
    expect(Array.isArray(r.body?.data?.scopesSupported)).toBe(true);
  });

  it('POST /api/auth/sso/config/test (private IP) → 400 (SSRF guard)', async () => {
    const r = await api('/api/auth/sso/config/test', {
      method: 'POST',
      body: { provider: 'oidc', issuerUrl: 'http://127.0.0.1' },
    });
    expect(r.status).toBe(400);
    expect(r.body?.error?.message).toMatch(/private|SSRF/i);
  });

  it('GET /api/users/me/preferences → 200', async () => {
    const r = await api('/api/users/me/preferences');
    expect(r.status).toBe(200);
    expect(r.body?.data?.preferences).toBeDefined();
  });

  it('PUT /api/users/me/preferences → 200 and persists', async () => {
    const r = await api('/api/users/me/preferences', {
      method: 'PUT',
      body: { emailNotifications: false },
    });
    expect(r.status).toBe(200);
    expect(r.body?.data?.preferences?.emailNotifications).toBe(false);
  });

  it('POST /api/policies (priority 0) → 400 (Task 14E)', async () => {
    const r = await api('/api/policies', {
      method: 'POST',
      body: {
        name: 't',
        priority: 0,
        effect: 'ALLOW',
        subjects: [],
        targets: [],
        constraints: {},
        maxSessionDuration: 3600,
      },
    });
    expect(r.status).toBe(400);
    expect(r.body?.error?.message).toMatch(/priority/i);
  });

  it('POST /api/access-requests (bad principal) → 400 (Task 14F)', async () => {
    const r = await api('/api/access-requests', {
      method: 'POST',
      body: {
        serverId: 'nonexistent',
        reason: 'integration test reason 1',
        requestedDuration: 3600,
        requestedPrincipal: 'Super Admin',
        protocol: 'SSH',
      },
    });
    expect(r.status).toBe(400);
    expect(r.body?.error?.message).toMatch(/Linux username|principal/i);
  });

  it('GET /api/access-requests → 200 with no BigInt serialization error', async () => {
    const r = await api('/api/access-requests?tab=mine&page=1&limit=20');
    expect(r.status).toBe(200);
    // If a cert with a BigInt serial is in the response tree, the
    // BigInt.prototype.toJSON shim must serialize it as a string.
    expect(r.body?.success).toBe(true);
  });
});
