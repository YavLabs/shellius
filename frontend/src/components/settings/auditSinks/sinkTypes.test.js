import { describe, expect, it } from 'vitest';
import {
  SINK_TYPES,
  getSinkType,
  visibleFieldsFor,
  sinkStatus,
  formatLag,
  deliveryStatusBadge,
  parseHeadersInput,
  headersToText,
  parseRecipientsInput,
  recipientsToText,
} from './sinkTypes';

describe('getSinkType', () => {
  it('finds a known type', () => {
    expect(getSinkType('webhook')?.label).toBe('Webhook (HTTP POST)');
    expect(getSinkType('s3')?.streaming).toBe(true);
    expect(getSinkType('email_digest')?.streaming).toBe(false);
  });

  it('returns null for an unknown type', () => {
    expect(getSinkType('carrier_pigeon')).toBeNull();
    expect(getSinkType(undefined)).toBeNull();
  });

  it('every type has a config field list and an icon', () => {
    for (const t of SINK_TYPES) {
      expect(Array.isArray(t.fields)).toBe(true);
      expect(t.fields.length).toBeGreaterThan(0);
      expect(t.icon).toBeTruthy();
    }
  });
});

describe('visibleFieldsFor', () => {
  it('hides TLS-only syslog fields when TLS is off', () => {
    const withTls = visibleFieldsFor('syslog', { tls: true }).map((f) => f.key);
    const withoutTls = visibleFieldsFor('syslog', { tls: false }).map((f) => f.key);
    expect(withTls).toContain('rejectUnauthorized');
    expect(withTls).toContain('caCert');
    expect(withoutTls).not.toContain('rejectUnauthorized');
    expect(withoutTls).not.toContain('caCert');
    expect(withoutTls).not.toContain('clientCert');
    expect(withoutTls).not.toContain('clientKey');
    // Fields with no showIf are always present either way.
    expect(withoutTls).toContain('host');
  });

  it('returns every field for a type with no showIf gating', () => {
    expect(visibleFieldsFor('s3', {}).map((f) => f.key)).toEqual(['bucket', 'prefix']);
  });

  it('degrades to an empty list for an unknown type', () => {
    expect(visibleFieldsFor('nope', {})).toEqual([]);
  });
});

describe('sinkStatus', () => {
  it('is Disabled whenever disabledReason is set, even if isActive is stale-true', () => {
    expect(sinkStatus({ isActive: true, disabledReason: 'Stopped after 10 failures in a row' })).toEqual({
      tone: 'danger',
      label: 'Disabled',
    });
  });

  it('is Off when inactive and no failure', () => {
    expect(sinkStatus({ isActive: false, consecutiveFailures: 0 })).toEqual({ tone: 'neutral', label: 'Off' });
  });

  it('is Failing while active but retrying', () => {
    expect(sinkStatus({ isActive: true, consecutiveFailures: 3 })).toEqual({ tone: 'warning', label: 'Failing (3×)' });
  });

  it('is Active when healthy', () => {
    expect(sinkStatus({ isActive: true, consecutiveFailures: 0 })).toEqual({ tone: 'success', label: 'Active' });
  });

  it('handles a missing sink', () => {
    expect(sinkStatus(null)).toEqual({ tone: 'neutral', label: 'Unknown' });
  });
});

describe('formatLag', () => {
  it('is null when there is nothing to report', () => {
    expect(formatLag(null)).toBeNull();
    expect(formatLag(undefined)).toBeNull();
  });

  it('reads "Up to date" at zero', () => {
    expect(formatLag(0)).toBe('Up to date');
  });

  it('singularizes one entry', () => {
    expect(formatLag(1)).toBe('1 entry behind');
  });

  it('pluralizes and formats large counts', () => {
    expect(formatLag(2)).toBe('2 entries behind');
    expect(formatLag(12345)).toBe('12,345 entries behind');
  });
});

describe('deliveryStatusBadge', () => {
  it('maps ok/failed to tones', () => {
    expect(deliveryStatusBadge('ok')).toEqual({ tone: 'success', label: 'Delivered' });
    expect(deliveryStatusBadge('failed')).toEqual({ tone: 'danger', label: 'Failed' });
  });

  it('falls back for anything else', () => {
    expect(deliveryStatusBadge('weird')).toEqual({ tone: 'neutral', label: 'weird' });
    expect(deliveryStatusBadge(undefined)).toEqual({ tone: 'neutral', label: 'Unknown' });
  });
});

describe('headers json <-> text', () => {
  it('round-trips an object through the textarea', () => {
    const headers = { Authorization: 'Bearer abc', 'X-Env': 'prod' };
    const text = headersToText(headers);
    expect(parseHeadersInput(text)).toEqual({ headers, error: null });
  });

  it('treats blank input as no headers', () => {
    expect(parseHeadersInput('')).toEqual({ headers: {}, error: null });
    expect(parseHeadersInput('   ')).toEqual({ headers: {}, error: null });
  });

  it('rejects invalid JSON', () => {
    const { headers, error } = parseHeadersInput('{not json');
    expect(headers).toBeNull();
    expect(error).toMatch(/valid JSON/);
  });

  it('rejects a JSON value that is not an object', () => {
    expect(parseHeadersInput('[1,2,3]').error).toMatch(/JSON object/);
    expect(parseHeadersInput('"just a string"').error).toMatch(/JSON object/);
    expect(parseHeadersInput('null').error).toMatch(/JSON object/);
  });

  it('headersToText renders nothing for an empty object', () => {
    expect(headersToText({})).toBe('');
    expect(headersToText(null)).toBe('');
  });
});

describe('recipients text <-> array', () => {
  it('splits on commas and newlines, trims and dedupes', () => {
    expect(parseRecipientsInput('a@x.com, b@x.com\nc@x.com, a@x.com')).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('drops empty entries', () => {
    expect(parseRecipientsInput('a@x.com,,  ,\n b@x.com')).toEqual(['a@x.com', 'b@x.com']);
  });

  it('handles empty input', () => {
    expect(parseRecipientsInput('')).toEqual([]);
    expect(parseRecipientsInput(undefined)).toEqual([]);
  });

  it('recipientsToText joins with ", "', () => {
    expect(recipientsToText(['a@x.com', 'b@x.com'])).toBe('a@x.com, b@x.com');
    expect(recipientsToText([])).toBe('');
    expect(recipientsToText(undefined)).toBe('');
  });
});
