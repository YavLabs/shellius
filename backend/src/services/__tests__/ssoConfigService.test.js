/**
 * ssoConfigService API surface + SSRF guard tests (Task 14B)
 *
 * Pattern: API surface + targeted unit checks of the SSRF helper. Full
 * upsert/encryption integration is covered by the live smoke.
 */

import * as ssoConfigService from '../ssoConfigService.js';

describe('ssoConfigService — API surface', () => {
  test('exports expected functions', () => {
    expect(typeof ssoConfigService.get).toBe('function');
    expect(typeof ssoConfigService.upsert).toBe('function');
    expect(typeof ssoConfigService.test).toBe('function');
  });
});

describe('ssoConfigService — SSRF guard', () => {
  // The test() function should reject private/loopback issuer URLs without
  // making any outbound HTTP request. Reason codes are checked indirectly
  // via the error message.

  test('rejects 127.0.0.1', async () => {
    await expect(
      ssoConfigService.test('any-org', {
        provider: 'oidc',
        issuerUrl: 'http://127.0.0.1',
      })
    ).rejects.toThrow(/private|SSRF|loopback/i);
  });

  test('rejects 10.x private range', async () => {
    await expect(
      ssoConfigService.test('any-org', {
        provider: 'oidc',
        issuerUrl: 'http://10.0.0.1',
      })
    ).rejects.toThrow(/private|SSRF/i);
  });

  test('rejects 192.168.x private range', async () => {
    await expect(
      ssoConfigService.test('any-org', {
        provider: 'oidc',
        issuerUrl: 'http://192.168.1.1',
      })
    ).rejects.toThrow(/private|SSRF/i);
  });

  test('rejects link-local 169.254.x', async () => {
    await expect(
      ssoConfigService.test('any-org', {
        provider: 'oidc',
        issuerUrl: 'http://169.254.169.254',
      })
    ).rejects.toThrow(/private|SSRF|link/i);
  });

  test('rejects ::1 IPv6 loopback', async () => {
    await expect(
      ssoConfigService.test('any-org', {
        provider: 'oidc',
        issuerUrl: 'http://[::1]',
      })
    ).rejects.toThrow(/private|SSRF|loopback/i);
  });
});
