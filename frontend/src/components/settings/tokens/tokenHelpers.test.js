import { describe, expect, it } from 'vitest';
import {
  delegablePermissions,
  formatTokenExpiry,
  groupPermissionsForPicker,
  isTokenExpired,
  isTokenRevoked,
  isTokenUsable,
  summarizeScopes,
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

// Small stand-in for GET /api/roles/catalog's shape (groups + flat permissions).
const CATALOG = {
  groups: [
    { key: 'servers', label: 'Servers' },
    { key: 'keystore', label: 'Keystore' },
    { key: 'org', label: 'Organization' },
  ],
  permissions: [
    { key: 'servers.view', group: 'servers', label: 'View servers', description: 'See server inventory' },
    { key: 'servers.create', group: 'servers', label: 'Create servers', description: 'Add new servers' },
    { key: 'keystore.view', group: 'keystore', label: 'View keystore', description: 'See stored credentials' },
    { key: 'ca.rotate', group: 'org', label: 'Rotate CA', description: 'Rotate the certificate authority', delegable: false },
  ],
};

describe('delegablePermissions', () => {
  it('drops permissions explicitly marked non-delegable', () => {
    expect(delegablePermissions(CATALOG).map((p) => p.key)).toEqual(['servers.view', 'servers.create', 'keystore.view']);
  });

  it('treats a missing delegable flag as delegable (degrades to "everything" until the API adds the field)', () => {
    const catalog = { permissions: [{ key: 'a.b', group: 'g' }] };
    expect(delegablePermissions(catalog).map((p) => p.key)).toEqual(['a.b']);
  });

  it('handles an empty/missing catalog', () => {
    expect(delegablePermissions(null)).toEqual([]);
    expect(delegablePermissions({})).toEqual([]);
  });
});

describe('groupPermissionsForPicker', () => {
  it('groups delegable permissions under their catalogue group, dropping empty groups', () => {
    const groups = groupPermissionsForPicker(CATALOG);
    expect(groups.map((g) => g.key)).toEqual(['servers', 'keystore']);
    expect(groups.find((g) => g.key === 'servers').items.map((p) => p.key)).toEqual(['servers.view', 'servers.create']);
  });

  it('excludes non-delegable permissions from every group', () => {
    const groups = groupPermissionsForPicker(CATALOG);
    expect(groups.some((g) => g.items.some((p) => p.key === 'ca.rotate'))).toBe(false);
  });

  it('restricts to a grantable allow-list when given one', () => {
    const grantable = new Set(['servers.view']);
    const groups = groupPermissionsForPicker(CATALOG, { grantable });
    expect(groups.map((g) => g.key)).toEqual(['servers']);
    expect(groups[0].items.map((p) => p.key)).toEqual(['servers.view']);
  });

  it('applies a case-insensitive search across key, label and description', () => {
    expect(groupPermissionsForPicker(CATALOG, { query: 'KEYSTORE' })[0].items.map((p) => p.key)).toEqual(['keystore.view']);
    expect(groupPermissionsForPicker(CATALOG, { query: 'inventory' })[0].items.map((p) => p.key)).toEqual(['servers.view']);
    expect(groupPermissionsForPicker(CATALOG, { query: 'no-such-thing' })).toEqual([]);
  });
});

describe('summarizeScopes', () => {
  it('reads "Full access" for an empty or missing scope list', () => {
    expect(summarizeScopes([])).toBe('Full access');
    expect(summarizeScopes(undefined)).toBe('Full access');
    expect(summarizeScopes(null)).toBe('Full access');
  });

  it('lists the keys when there are few', () => {
    expect(summarizeScopes(['servers.view'])).toBe('servers.view');
    expect(summarizeScopes(['servers.view', 'keystore.view'])).toBe('servers.view, keystore.view');
  });

  it('falls back to a count once past maxKeys', () => {
    expect(summarizeScopes(['a', 'b', 'c', 'd'])).toBe('4 scopes');
    expect(summarizeScopes(['a', 'b'], { maxKeys: 1 })).toBe('2 scopes');
  });
});
