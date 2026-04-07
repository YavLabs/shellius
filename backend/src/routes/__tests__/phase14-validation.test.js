/**
 * Phase 14 route-level validation tests
 *
 * Covers the Joi schemas added in Phase 14:
 *  - Task 14E: policy `priority >= 1`
 *  - Task 14F: access-request `requestedPrincipal` POSIX-ish pattern
 *
 * These tests load the route's Joi schema (re-defined here to mirror the
 * source) and assert it accepts/rejects the right inputs. The schemas are
 * also exercised end-to-end against the live stack by phase14-smoke.test.js.
 */

import Joi from 'joi';

// ---------------------------------------------------------------------------
// Mirror of the schemas to lock in their behavior. If the source schema
// drifts, update both — this acts as the regression net.
// ---------------------------------------------------------------------------

const POLICY_PRIORITY_SCHEMA = Joi.object({
  priority: Joi.number().integer().min(1).required(),
});

const PRINCIPAL_SCHEMA = Joi.object({
  requestedPrincipal: Joi.string()
    .pattern(/^[a-z_][a-z0-9_-]{0,31}$/)
    .required(),
});

describe('policy priority Joi guard (Task 14E)', () => {
  test('rejects priority 0', () => {
    const { error } = POLICY_PRIORITY_SCHEMA.validate({ priority: 0 });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/greater than or equal to 1/);
  });

  test('rejects negative priority', () => {
    const { error } = POLICY_PRIORITY_SCHEMA.validate({ priority: -5 });
    expect(error).toBeDefined();
  });

  test('accepts priority 1', () => {
    const { error } = POLICY_PRIORITY_SCHEMA.validate({ priority: 1 });
    expect(error).toBeUndefined();
  });

  test('accepts priority 1000', () => {
    const { error } = POLICY_PRIORITY_SCHEMA.validate({ priority: 1000 });
    expect(error).toBeUndefined();
  });

  test('rejects fractional priority', () => {
    const { error } = POLICY_PRIORITY_SCHEMA.validate({ priority: 1.5 });
    expect(error).toBeDefined();
  });
});

describe('access-request requestedPrincipal Joi guard (Task 14F)', () => {
  test('rejects display name "Super Admin"', () => {
    const { error } = PRINCIPAL_SCHEMA.validate({ requestedPrincipal: 'Super Admin' });
    expect(error).toBeDefined();
  });

  test('rejects mixed case "JohnDoe"', () => {
    const { error } = PRINCIPAL_SCHEMA.validate({ requestedPrincipal: 'JohnDoe' });
    expect(error).toBeDefined();
  });

  test('rejects digit-leading "1foo"', () => {
    const { error } = PRINCIPAL_SCHEMA.validate({ requestedPrincipal: '1foo' });
    expect(error).toBeDefined();
  });

  test('rejects 33-char username', () => {
    const { error } = PRINCIPAL_SCHEMA.validate({ requestedPrincipal: 'a'.repeat(33) });
    expect(error).toBeDefined();
  });

  test('accepts "yavadmin"', () => {
    const { error } = PRINCIPAL_SCHEMA.validate({ requestedPrincipal: 'yavadmin' });
    expect(error).toBeUndefined();
  });

  test('accepts "ec2-user"', () => {
    const { error } = PRINCIPAL_SCHEMA.validate({ requestedPrincipal: 'ec2-user' });
    expect(error).toBeUndefined();
  });

  test('accepts leading underscore "_svc"', () => {
    const { error } = PRINCIPAL_SCHEMA.validate({ requestedPrincipal: '_svc' });
    expect(error).toBeUndefined();
  });

  test('accepts 32-char username (boundary)', () => {
    const { error } = PRINCIPAL_SCHEMA.validate({ requestedPrincipal: 'a'.repeat(32) });
    expect(error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Verify the source schemas still match these locked patterns. If somebody
// loosens them, this test fails loudly.
// ---------------------------------------------------------------------------

describe('source schema drift guard', () => {
  test('access-request route uses the POSIX principal regex', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../accessRequests.js', import.meta.url),
      'utf8'
    );
    expect(src).toContain('^[a-z_][a-z0-9_-]{0,31}$');
  });

  test('policies route enforces priority min 1', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../policies.js', import.meta.url),
      'utf8'
    );
    // Joi.number().integer().min(1) for priority — accept any whitespace
    expect(src).toMatch(/priority[^,]*\.min\(1\)/);
  });
});
