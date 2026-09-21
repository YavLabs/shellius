import { endOfDayInclusive } from '../dateRange.js';

describe('endOfDayInclusive', () => {
  it('a bare day means the end of that day, so the day itself is included', () => {
    expect(endOfDayInclusive('2026-09-21').toISOString()).toBe('2026-09-21T23:59:59.999Z');
  });
  it('a full timestamp is taken as given', () => {
    expect(endOfDayInclusive('2026-09-21T10:00:00.000Z').toISOString()).toBe('2026-09-21T10:00:00.000Z');
  });
  it('nothing, or garbage, is no bound at all', () => {
    expect(endOfDayInclusive('')).toBeNull();
    expect(endOfDayInclusive('nope')).toBeNull();
  });
});
