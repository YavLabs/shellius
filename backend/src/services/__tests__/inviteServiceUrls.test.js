/**
 * Links to app pages (invite / reset / verify / approve) must use the
 * configured app URL — never request headers (reset-link poisoning).
 */
import config from '../../config/index.js';
import { buildTokenUrl, getPublicBaseUrl, TOKEN_TYPES } from '../inviteService.js';

describe('inviteService link base', () => {
  const forged = { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' }, protocol: 'https', get: () => 'evil.example' };

  test('uses config.publicBaseUrl and ignores request headers', () => {
    expect(getPublicBaseUrl(forged)).toBe(config.publicBaseUrl);
    const url = buildTokenUrl(TOKEN_TYPES.PASSWORD_RESET, 'a'.repeat(64), forged);
    expect(url.startsWith(`${config.publicBaseUrl}/password-reset/`)).toBe(true);
    expect(url).not.toContain('evil.example');
  });

  test('paths per token type', () => {
    expect(buildTokenUrl(TOKEN_TYPES.INVITE, 'x')).toBe(`${config.publicBaseUrl}/invite/x`);
    expect(buildTokenUrl(TOKEN_TYPES.ACCESS_APPROVAL, 'x')).toBe(`${config.publicBaseUrl}/approve/x`);
  });
});
