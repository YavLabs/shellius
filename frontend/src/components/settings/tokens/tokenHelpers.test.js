import { describe, expect, it } from 'vitest';
import {
  formatTokenExpiry,
  isTokenExpired,
  isTokenRevoked,
  isTokenUsable,
  tokenStatus,
  tokenStatusBadge,
  TOKEN_EXPIRY_OPTIONS,
} from './tokenHelpers';

const DAY = 86400000;
const future = (days) => new Date(Date.now() + days * DAY).toISOString();
const past = (days) => new Date(Date.now() - days * DAY).toISOString();

describe('isTokenExpired', () => {
  it('is false for a token with no expiry', () => {
    expect(isTokenExpired({})).toBe(false);
    expect(isTokenExpired({ expiresAt: null })).toBe(false);
  });

  it('is false while expiresAt is in the future', () => {
    expect(isTokenExpired({ expiresAt: future(5) })).toBe(false);
  });

  it('is true once expiresAt has passed', () => {
    expect(isTokenExpired({ expiresAt: past(1) })).toBe(true);
  });

  it('treats an unparsable date as not expired', () => {
    expect(isTokenExpired({ expiresAt: 'not-a-date' })).toBe(false);
  });
});

describe('isTokenRevoked', () => {
  it('reflects revokedAt', () => {
    expect(isTokenRevoked({})).toBe(false);
    expect(isTokenRevoked({ revokedAt: null })).toBe(false);
    expect(isTokenRevoked({ revokedAt: past(1) })).toBe(true);
  });
});

describe('tokenStatus / isTokenUsable', () => {
  it('is active with no revokedAt and no (or future) expiry', () => {
    expect(tokenStatus({})).toBe('active');
    expect(tokenStatus({ expiresAt: future(1) })).toBe('active');
    expect(isTokenUsable({ expiresAt: future(1) })).toBe(true);
  });

  it('is expired once past expiresAt', () => {
    expect(tokenStatus({ expiresAt: past(1) })).toBe('expired');
    expect(isTokenUsable({ expiresAt: past(1) })).toBe(false);
  });

  it('revoked wins over expired', () => {
    expect(tokenStatus({ expiresAt: past(1), revokedAt: past(2) })).toBe('revoked');
    expect(isTokenUsable({ expiresAt: past(1), revokedAt: past(2) })).toBe(false);
  });

  it('revoked wins even when the token has not expired yet', () => {
    expect(tokenStatus({ expiresAt: future(10), revokedAt: past(1) })).toBe('revoked');
  });
});

describe('tokenStatusBadge', () => {
  it('maps each status to a tone and label', () => {
    expect(tokenStatusBadge({})).toEqual({ tone: 'success', label: 'Active' });
    expect(tokenStatusBadge({ expiresAt: past(1) })).toEqual({ tone: 'neutral', label: 'Expired' });
    expect(tokenStatusBadge({ revokedAt: past(1) })).toEqual({ tone: 'danger', label: 'Revoked' });
  });
});

describe('formatTokenExpiry', () => {
  it('reads "Never expires" when there is no expiry', () => {
    expect(formatTokenExpiry(null)).toBe('Never expires');
    expect(formatTokenExpiry(undefined)).toBe('Never expires');
    expect(formatTokenExpiry('garbage')).toBe('Never expires');
  });

  it('counts down in days for a future expiry', () => {
    expect(formatTokenExpiry(new Date(Date.now() + 6 * 3600000).toISOString())).toBe('Expires today');
    expect(formatTokenExpiry(future(1))).toBe('Expires in 1 day');
    expect(formatTokenExpiry(future(5))).toBe('Expires in 5 days');
  });

  it('singularizes "1 day"', () => {
    expect(formatTokenExpiry(future(1))).toBe('Expires in 1 day');
    expect(formatTokenExpiry(new Date(Date.now() - 1.01 * DAY).toISOString())).toBe('Expired 1 day ago');
  });

  it('counts up for a past expiry', () => {
    expect(formatTokenExpiry(past(3))).toBe('Expired 3 days ago');
  });
});

describe('TOKEN_EXPIRY_OPTIONS', () => {
  it('offers a "never expires" choice with an empty value', () => {
    expect(TOKEN_EXPIRY_OPTIONS.some((o) => o.value === '' && /never/i.test(o.label))).toBe(true);
  });

  it('every other option is a positive integer number of days', () => {
    for (const o of TOKEN_EXPIRY_OPTIONS.filter((o) => o.value !== '')) {
      expect(Number.isInteger(Number(o.value))).toBe(true);
      expect(Number(o.value)).toBeGreaterThan(0);
    }
  });
});
