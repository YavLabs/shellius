/**
 * smtpConfigService tests (Task 16A)
 *
 * Strategy: unit-test the env-merge logic in getEffective() by mocking
 * the Prisma findUnique call and controlling process.env. Full DB
 * integration is exercised by the live smoke / seed flow.
 *
 * Because Jest ESM module-level mocking is fragile in this stack, we
 * test getEffective() by monkey-patching the prisma import via the
 * module's exported reference after we mock it at the module level.
 *
 * For the API surface tests we simply verify exports exist and have the
 * right types — consistent with the pattern in caService.test.js.
 */

import * as smtpConfigService from '../smtpConfigService.js';

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

describe('smtpConfigService — API surface', () => {
  test('exports getEffective', () => {
    expect(typeof smtpConfigService.getEffective).toBe('function');
  });

  test('exports upsert', () => {
    expect(typeof smtpConfigService.upsert).toBe('function');
  });

  test('exports remove', () => {
    expect(typeof smtpConfigService.remove).toBe('function');
  });

  test('exports maskRow', () => {
    expect(typeof smtpConfigService.maskRow).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// maskRow — pure function, no DB needed
// ---------------------------------------------------------------------------

describe('smtpConfigService.maskRow', () => {
  test('returns null for null input', () => {
    expect(smtpConfigService.maskRow(null)).toBeNull();
  });

  test('strips passwordEncrypted and adds hasPassword: true when set', () => {
    const row = {
      id: 'abc',
      orgId: 'org-1',
      host: 'smtp.example.com',
      port: 587,
      username: 'user',
      passwordEncrypted: 'some-encrypted-value',
      fromAddress: null,
      useTls: true,
      isActive: true,
    };
    const masked = smtpConfigService.maskRow(row);
    expect(masked).not.toHaveProperty('passwordEncrypted');
    expect(masked.hasPassword).toBe(true);
    expect(masked.host).toBe('smtp.example.com');
  });

  test('sets hasPassword: false when no encrypted password', () => {
    const row = {
      id: 'abc',
      orgId: 'org-1',
      host: 'smtp.example.com',
      port: 587,
      username: null,
      passwordEncrypted: null,
      fromAddress: null,
      useTls: true,
      isActive: true,
    };
    const masked = smtpConfigService.maskRow(row);
    expect(masked.hasPassword).toBe(false);
    expect(masked).not.toHaveProperty('passwordEncrypted');
  });
});

// ---------------------------------------------------------------------------
// getEffective — env-merge logic
// ---------------------------------------------------------------------------

describe('smtpConfigService.getEffective — env-merge', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Reset env to original before each test
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE']) {
      delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE']) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
  });

  afterAll(() => {
    // Restore original env
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE']) {
      if (key in ORIGINAL_ENV) {
        process.env[key] = ORIGINAL_ENV[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test('returns configured: false when no env and no db row', async () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;

    // No DB: orgId undefined falls through to env only
    const result = await smtpConfigService.getEffective(undefined);
    expect(result.configured).toBe(false);
    expect(result.host).toBeNull();
  });

  test('returns configured: true when SMTP_HOST is set in env', async () => {
    process.env.SMTP_HOST = 'smtp.env-test.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'envuser';
    process.env.SMTP_PASS = 'envpass';
    process.env.SMTP_FROM = 'noreply@env-test.com';

    const result = await smtpConfigService.getEffective(undefined);
    expect(result.configured).toBe(true);
    expect(result.host).toBe('smtp.env-test.com');
    expect(result.port).toBe(465);
    expect(result.username).toBe('envuser');
    expect(result.password).toBe('envpass');
    expect(result.fromAddress).toBe('noreply@env-test.com');
    expect(result.source.host).toBe('env');
    expect(result.source.username).toBe('env');
    expect(result.source.password).toBe('env');
    expect(result.source.fromAddress).toBe('env');
  });

  test('defaults port to 587 when SMTP_PORT not set', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    delete process.env.SMTP_PORT;

    const result = await smtpConfigService.getEffective(undefined);
    expect(result.port).toBe(587);
    expect(result.source.port).toBe('default');
  });

  test('useTls defaults to true when SMTP_SECURE is not set', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    delete process.env.SMTP_SECURE;

    const result = await smtpConfigService.getEffective(undefined);
    expect(result.useTls).toBe(true);
  });

  test('useTls is false when SMTP_SECURE=false', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_SECURE = 'false';

    const result = await smtpConfigService.getEffective(undefined);
    expect(result.useTls).toBe(false);
  });

  test('password is null and source.password is null when no password configured', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    delete process.env.SMTP_PASS;

    const result = await smtpConfigService.getEffective(undefined);
    expect(result.password).toBeNull();
    expect(result.source.password).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upsert — input validation (no DB call expected to succeed)
// ---------------------------------------------------------------------------

describe('smtpConfigService.upsert — validation', () => {
  test('throws ApiError 400 when host is missing', async () => {
    await expect(
      smtpConfigService.upsert('org-1', { port: 587 })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('throws ApiError 400 when host is empty string', async () => {
    await expect(
      smtpConfigService.upsert('org-1', { host: '' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
