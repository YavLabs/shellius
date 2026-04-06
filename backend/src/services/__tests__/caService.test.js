/**
 * caService smoke tests
 *
 * Strategy: no Jest ESM mocking (jest.unstable_mockModule with file:// URLs is
 * broken in this Jest + Node ESM combination). Instead we verify:
 *   1. The module loads and exports the expected API surface.
 *   2. Input-validation guards (400/404) work without any DB or ssh-keygen call.
 *
 * Full integration tests (generateCaKeyPair, signCertificate against the real DB
 * and real ssh-keygen) are covered manually via the npm run db:seed flow or a
 * future dedicated integration test suite that runs with a test DB transaction.
 *
 * TODO: add full integration tests once a Jest-compatible ESM mock solution is
 * established (e.g. switch to Vitest which has native ESM support) or once an
 * isolated test-DB approach is wired up.
 */

import {
  generateCaKeyPair,
  signCertificate,
  revokeCertificate,
  rotateCaKeyPair,
  getPublicKey,
  getFingerprint,
} from '../caService.js';

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

describe('caService — module exports', () => {
  test('exports all six required functions', () => {
    expect(typeof generateCaKeyPair).toBe('function');
    expect(typeof signCertificate).toBe('function');
    expect(typeof revokeCertificate).toBe('function');
    expect(typeof rotateCaKeyPair).toBe('function');
    expect(typeof getPublicKey).toBe('function');
    expect(typeof getFingerprint).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Input validation guards (no DB / ssh-keygen needed — reject before any I/O)
// ---------------------------------------------------------------------------

describe('generateCaKeyPair — validation', () => {
  test('throws 400 when orgId is null', async () => {
    await expect(generateCaKeyPair(null, 'primary')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('throws 400 when name is empty string', async () => {
    await expect(generateCaKeyPair('org-1', '')).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('signCertificate — validation', () => {
  const base = {
    orgId: 'org-1',
    publicKey: 'ssh-ed25519 AAAA...',
    principals: ['alice'],
    validitySeconds: 3600,
    keyId: 'alice@shellius',
  };

  test('throws 400 when orgId is missing', async () => {
    await expect(signCertificate({ ...base, orgId: '' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('throws 400 when publicKey is empty', async () => {
    await expect(signCertificate({ ...base, publicKey: '' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('throws 400 when principals is empty array', async () => {
    await expect(signCertificate({ ...base, principals: [] })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('throws 400 when validitySeconds is zero', async () => {
    await expect(signCertificate({ ...base, validitySeconds: 0 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('throws 400 when keyId is missing', async () => {
    await expect(signCertificate({ ...base, keyId: '' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('revokeCertificate — validation', () => {
  test('throws 400 when certId is null', async () => {
    await expect(revokeCertificate(null, 'user-1')).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('rotateCaKeyPair — validation', () => {
  test('throws 400 when orgId is empty', async () => {
    await expect(rotateCaKeyPair('', 'name')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('throws 400 when name is empty', async () => {
    await expect(rotateCaKeyPair('org-1', '')).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('getPublicKey — validation', () => {
  test('throws 400 when orgId is empty', async () => {
    await expect(getPublicKey('')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('getFingerprint — validation', () => {
  test('throws 400 when orgId is empty', async () => {
    await expect(getFingerprint('')).rejects.toMatchObject({ statusCode: 400 });
  });
});
