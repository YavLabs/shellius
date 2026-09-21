import { describe, expect, it } from 'vitest';
import {
  serverPrimaryLabel,
  serverSecondaryLabel,
  serverSearchString,
  serverInlineLabel,
} from './serverLabel';

describe('serverLabel', () => {
  it('prefers displayName as the primary label, falling back to hostname then a caller fallback', () => {
    expect(serverPrimaryLabel({ displayName: 'db-primary', hostname: '10.0.0.5' })).toBe('db-primary');
    expect(serverPrimaryLabel({ hostname: '10.0.0.5' })).toBe('10.0.0.5');
    expect(serverPrimaryLabel(null, 'unknown')).toBe('unknown');
    expect(serverPrimaryLabel({})).toBe('-');
  });

  it('shows the hostname/IP as secondary only when it adds information', () => {
    expect(serverSecondaryLabel({ displayName: 'db-primary', hostname: '10.0.0.5' })).toBe('10.0.0.5');
    // No displayName — hostname IS the primary label, so no secondary text.
    expect(serverSecondaryLabel({ hostname: '10.0.0.5' })).toBe('');
    expect(serverSecondaryLabel({ displayName: 'db-primary', ipAddress: '10.0.0.9' })).toBe('10.0.0.9');
    expect(serverSecondaryLabel(null)).toBe('');
  });

  it('builds a search string covering name, hostname, IP and environment', () => {
    const s = serverSearchString({ displayName: 'db-primary', hostname: 'db1.internal', environment: 'prod' });
    expect(s).toContain('db-primary');
    expect(s).toContain('db1.internal');
    expect(s).toContain('prod');
    expect(serverSearchString(null)).toBe('');
  });

  it('inlines "primary (secondary)" for single-line contexts', () => {
    expect(serverInlineLabel({ displayName: 'db-primary', hostname: '10.0.0.5' })).toBe('db-primary (10.0.0.5)');
    expect(serverInlineLabel({ hostname: '10.0.0.5' })).toBe('10.0.0.5');
  });
});
