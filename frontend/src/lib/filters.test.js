import { describe, expect, it } from 'vitest';
import { appliedFilterCount, appliedFilters, clearedFilterValues, isFilterSet } from './filters';

const defs = [
  { key: 'severity', label: 'Severity' },
  { key: 'environment', label: 'Environment' },
  { key: 'customerId', label: 'Customer' },
];

describe('isFilterSet', () => {
  it('treats an unset select as unset', () => {
    // '' is what every "All severities" option carries, so it must not count
    // — a chip reading "3 filters applied" on an untouched list is worse
    // than no chip.
    expect(isFilterSet('')).toBe(false);
    expect(isFilterSet(undefined)).toBe(false);
    expect(isFilterSet(null)).toBe(false);
    expect(isFilterSet(false)).toBe(false);
  });

  it('counts a real value, including ones that look falsy', () => {
    expect(isFilterSet('HIGH')).toBe(true);
    expect(isFilterSet(0)).toBe(true);
    expect(isFilterSet('false')).toBe(true); // the string a select carries
  });
});

describe('appliedFilters', () => {
  it('returns the set ones, in declaration order', () => {
    const applied = appliedFilters(defs, { customerId: 'c1', severity: 'HIGH', environment: '' });
    expect(applied.map((d) => d.key)).toEqual(['severity', 'customerId']);
  });

  it('ignores values for keys nobody declared', () => {
    // A stale URL param must not inflate the count for a filter the list
    // does not even offer.
    expect(appliedFilterCount(defs, { severity: 'HIGH', bogus: 'x' })).toBe(1);
  });

  it('is empty for an untouched list', () => {
    expect(appliedFilterCount(defs, {})).toBe(0);
    expect(appliedFilterCount([], { severity: 'HIGH' })).toBe(0);
  });
});

describe('clearedFilterValues', () => {
  it('resets every declared key to empty, not to missing', () => {
    // Pages spread this into their own state; a missing key would read as
    // "leave it alone" and the filter would survive "Clear all".
    expect(clearedFilterValues(defs)).toEqual({ severity: '', environment: '', customerId: '' });
  });

  it('touches nothing the list did not declare', () => {
    expect(Object.keys(clearedFilterValues([{ key: 'a' }]))).toEqual(['a']);
  });
});
