/**
 * digestSchedule — the scheduler behind both digests.
 *
 * Every assertion here is a way a digest can go wrong that has actually been
 * shipped by somebody: firing twice in one period, never firing because the
 * tick never lands exactly on the hour, mailing a year of history the moment
 * a rule is created, or mailing seven days' worth of separate digests when an
 * instance comes back from an outage.
 */

import {
  normalizeSchedule,
  previousOccurrence,
  digestDue,
  periodLabel,
} from '../digestSchedule.js';

const at = (iso) => new Date(iso);

describe('normalizeSchedule', () => {
  test('defaults to daily at 08:00 UTC', () => {
    expect(normalizeSchedule()).toEqual({ schedule: 'daily', hour: 8, dayOfWeek: null });
  });

  test('daily carries no day-of-week, whatever was stored', () => {
    expect(normalizeSchedule({ schedule: 'daily', dayOfWeek: 3 })).toEqual({
      schedule: 'daily',
      hour: 8,
      dayOfWeek: null,
    });
  });

  test('weekly defaults to Monday', () => {
    expect(normalizeSchedule({ schedule: 'weekly' })).toEqual({
      schedule: 'weekly',
      hour: 8,
      dayOfWeek: 1,
    });
  });

  test('an unknown schedule falls back to daily rather than throwing', () => {
    expect(normalizeSchedule({ schedule: 'hourly' }).schedule).toBe('daily');
    expect(normalizeSchedule({ schedule: null }).schedule).toBe('daily');
  });

  // A job tick must never die on one malformed row; every one of these used
  // to be reachable from a hand-edited JSON config blob.
  test.each([
    ['out of range high', 24],
    ['out of range low', -1],
    ['fractional', 7.5],
    ['a string', 'noon'],
    ['NaN', NaN],
    ['null', null],
    ['undefined', undefined],
  ])('a bad hour (%s) falls back to 8', (_label, hour) => {
    expect(normalizeSchedule({ hour }).hour).toBe(8);
  });

  test('hour 0 is honoured and not mistaken for missing', () => {
    expect(normalizeSchedule({ hour: 0 }).hour).toBe(0);
  });

  test('day 0 (Sunday) is honoured and not mistaken for missing', () => {
    expect(normalizeSchedule({ schedule: 'weekly', dayOfWeek: 0 }).dayOfWeek).toBe(0);
  });

  test.each([[-1], [7], [1.5], ['Monday'], [NaN]])('a bad dayOfWeek (%p) falls back to Monday', (dayOfWeek) => {
    expect(normalizeSchedule({ schedule: 'weekly', dayOfWeek }).dayOfWeek).toBe(1);
  });
});

describe('previousOccurrence — daily', () => {
  const daily = { schedule: 'daily', hour: 8 };

  test('after the hour, it is today', () => {
    expect(previousOccurrence(daily, at('2026-03-10T09:30:00Z')).toISOString()).toBe('2026-03-10T08:00:00.000Z');
  });

  test('before the hour, it is yesterday', () => {
    expect(previousOccurrence(daily, at('2026-03-10T07:59:59Z')).toISOString()).toBe('2026-03-09T08:00:00.000Z');
  });

  // The boundary that decides whether a digest scheduled for 08:00 is ever
  // sent by a job that happens to tick exactly on the hour.
  test('exactly on the hour counts as arrived', () => {
    expect(previousOccurrence(daily, at('2026-03-10T08:00:00.000Z')).toISOString()).toBe('2026-03-10T08:00:00.000Z');
  });

  test('one millisecond before the hour has not arrived', () => {
    expect(previousOccurrence(daily, at('2026-03-10T07:59:59.999Z')).toISOString()).toBe('2026-03-09T08:00:00.000Z');
  });

  test('midnight schedules work', () => {
    const midnight = { schedule: 'daily', hour: 0 };
    expect(previousOccurrence(midnight, at('2026-03-10T00:00:00Z')).toISOString()).toBe('2026-03-10T00:00:00.000Z');
    expect(previousOccurrence(midnight, at('2026-03-09T23:59:59Z')).toISOString()).toBe('2026-03-09T00:00:00.000Z');
  });

  test('crosses a month boundary', () => {
    expect(previousOccurrence(daily, at('2026-04-01T07:00:00Z')).toISOString()).toBe('2026-03-31T08:00:00.000Z');
  });

  test('crosses a year boundary', () => {
    expect(previousOccurrence(daily, at('2026-01-01T02:00:00Z')).toISOString()).toBe('2025-12-31T08:00:00.000Z');
  });

  test('handles 29 February in a leap year', () => {
    expect(previousOccurrence(daily, at('2028-03-01T07:00:00Z')).toISOString()).toBe('2028-02-29T08:00:00.000Z');
  });

  // Everything is UTC on purpose; a host in a +13 timezone must not shift the
  // schedule by a day.
  test('is computed in UTC, not host local time', () => {
    const result = previousOccurrence(daily, at('2026-06-15T10:00:00Z'));
    expect(result.getUTCHours()).toBe(8);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
  });

  test('a non-Date now is accepted', () => {
    expect(previousOccurrence(daily, '2026-03-10T09:00:00Z').toISOString()).toBe('2026-03-10T08:00:00.000Z');
  });

  test('an invalid now throws rather than returning a bogus date', () => {
    expect(() => previousOccurrence(daily, 'not a date')).toThrow(TypeError);
  });
});

describe('previousOccurrence — weekly', () => {
  // 2026-03-10 is a Tuesday.
  const mondays = { schedule: 'weekly', hour: 8, dayOfWeek: 1 };

  test('finds the most recent matching weekday', () => {
    expect(previousOccurrence(mondays, at('2026-03-10T09:00:00Z')).toISOString()).toBe('2026-03-09T08:00:00.000Z');
  });

  test('on the day but before the hour, it is last week', () => {
    expect(previousOccurrence(mondays, at('2026-03-09T07:00:00Z')).toISOString()).toBe('2026-03-02T08:00:00.000Z');
  });

  test('on the day exactly at the hour, it is today', () => {
    expect(previousOccurrence(mondays, at('2026-03-09T08:00:00Z')).toISOString()).toBe('2026-03-09T08:00:00.000Z');
  });

  test('six days later still resolves to the same occurrence', () => {
    expect(previousOccurrence(mondays, at('2026-03-15T23:59:00Z')).toISOString()).toBe('2026-03-09T08:00:00.000Z');
  });

  test('Sunday (day 0) is reachable', () => {
    const sundays = { schedule: 'weekly', hour: 8, dayOfWeek: 0 };
    expect(previousOccurrence(sundays, at('2026-03-10T09:00:00Z')).toISOString()).toBe('2026-03-08T08:00:00.000Z');
  });

  test('every weekday resolves to a date with that weekday', () => {
    for (let dow = 0; dow <= 6; dow += 1) {
      const got = previousOccurrence({ schedule: 'weekly', hour: 8, dayOfWeek: dow }, at('2026-03-10T09:00:00Z'));
      expect(got.getUTCDay()).toBe(dow);
      expect(got.getTime()).toBeLessThanOrEqual(at('2026-03-10T09:00:00Z').getTime());
    }
  });

  test('never returns an instant in the future', () => {
    for (let dow = 0; dow <= 6; dow += 1) {
      for (let h = 0; h <= 23; h += 1) {
        const now = at('2026-03-10T12:34:56Z');
        const got = previousOccurrence({ schedule: 'weekly', hour: h, dayOfWeek: dow }, now);
        expect(got.getTime()).toBeLessThanOrEqual(now.getTime());
        // and never more than a week back
        expect(now.getTime() - got.getTime()).toBeLessThan(8 * 24 * 60 * 60 * 1000);
      }
    }
  });
});

describe('digestDue', () => {
  const daily = { schedule: 'daily', hour: 8 };

  test('due when a scheduled hour has passed since the last run', () => {
    const r = digestDue(daily, { anchor: at('2026-03-09T08:00:00Z'), now: at('2026-03-10T08:05:00Z') });
    expect(r.due).toBe(true);
    expect(r.from.toISOString()).toBe('2026-03-09T08:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-03-10T08:05:00.000Z');
  });

  test('not due twice in the same period', () => {
    const r = digestDue(daily, { anchor: at('2026-03-10T08:05:00Z'), now: at('2026-03-10T23:00:00Z') });
    expect(r.due).toBe(false);
    expect(r.reason).toMatch(/no scheduled occurrence/);
  });

  // The tick interval is much shorter than the period, so "not due" is the
  // overwhelmingly common answer and must be cheap and correct.
  test('stays undue across many ticks within one period', () => {
    const anchor = at('2026-03-10T08:00:00Z');
    for (let m = 5; m < 24 * 60; m += 15) {
      const now = new Date(anchor.getTime() + m * 60 * 1000);
      if (now.getTime() >= at('2026-03-11T08:00:00Z').getTime()) break;
      expect(digestDue(daily, { anchor, now }).due).toBe(false);
    }
  });

  test('becomes due again at the next occurrence', () => {
    const anchor = at('2026-03-10T08:00:00Z');
    expect(digestDue(daily, { anchor, now: at('2026-03-11T07:59:00Z') }).due).toBe(false);
    expect(digestDue(daily, { anchor, now: at('2026-03-11T08:00:00Z') }).due).toBe(true);
  });

  // A rule created at 07:00 for an 08:00 digest should send at 08:00 the
  // same day, covering only its own lifetime.
  test('a fresh rule sends its first digest at the next occurrence, covering only its own life', () => {
    const createdAt = at('2026-03-10T07:00:00Z');
    expect(digestDue(daily, { anchor: createdAt, now: at('2026-03-10T07:30:00Z') }).due).toBe(false);
    const r = digestDue(daily, { anchor: createdAt, now: at('2026-03-10T08:01:00Z') });
    expect(r.due).toBe(true);
    expect(r.from.toISOString()).toBe(createdAt.toISOString());
  });

  // The failure this prevents: a digest rule created today mailing every
  // finding the org has ever recorded.
  test('a rule created after today\'s occurrence does not backfill', () => {
    const createdAt = at('2026-03-10T09:00:00Z');
    expect(digestDue(daily, { anchor: createdAt, now: at('2026-03-10T23:59:00Z') }).due).toBe(false);
  });

  // An outage must produce one digest covering the gap, not one per day.
  test('a long outage collapses to a single digest', () => {
    const anchor = at('2026-03-01T08:00:00Z');
    const r = digestDue(daily, { anchor, now: at('2026-03-08T09:00:00Z') });
    expect(r.due).toBe(true);
    expect(r.from.toISOString()).toBe(anchor.toISOString());
    expect(r.to.toISOString()).toBe('2026-03-08T09:00:00.000Z');
  });

  test('an ancient anchor is clamped instead of scanning years', () => {
    const r = digestDue(daily, { anchor: at('2020-01-01T00:00:00Z'), now: at('2026-03-10T09:00:00Z') });
    expect(r.due).toBe(true);
    expect(r.reason).toBe('window clamped');
    expect(r.to.getTime() - r.from.getTime()).toBe(31 * 24 * 60 * 60 * 1000);
  });

  test('the clamp is configurable', () => {
    const r = digestDue(daily, {
      anchor: at('2020-01-01T00:00:00Z'),
      now: at('2026-03-10T09:00:00Z'),
      maxWindowMs: 2 * 24 * 60 * 60 * 1000,
    });
    expect(r.to.getTime() - r.from.getTime()).toBe(2 * 24 * 60 * 60 * 1000);
  });

  // A clock that jumped backwards must not produce a negative window.
  test('an anchor in the future is refused, not inverted', () => {
    const r = digestDue(daily, { anchor: at('2026-03-20T00:00:00Z'), now: at('2026-03-10T09:00:00Z') });
    expect(r.due).toBe(false);
    expect(r.reason).toMatch(/future/);
  });

  test('a missing anchor assumes one period, not the beginning of time', () => {
    const r = digestDue(daily, { anchor: null, now: at('2026-03-10T09:00:00Z') });
    expect(r.due).toBe(true);
    expect(r.to.getTime() - r.from.getTime()).toBeLessThanOrEqual(2 * 24 * 60 * 60 * 1000);
  });

  test('an unparseable anchor is treated as missing rather than throwing', () => {
    const r = digestDue(daily, { anchor: 'yesterday-ish', now: at('2026-03-10T09:00:00Z') });
    expect(r.due).toBe(true);
    expect(Number.isFinite(r.from.getTime())).toBe(true);
  });

  test('an anchor given as a string works', () => {
    const r = digestDue(daily, { anchor: '2026-03-09T08:00:00Z', now: at('2026-03-10T09:00:00Z') });
    expect(r.due).toBe(true);
  });

  test('an invalid now throws rather than scheduling on NaN', () => {
    expect(() => digestDue(daily, { anchor: null, now: 'nope' })).toThrow(TypeError);
  });

  test('the window never inverts, for any anchor/now pair', () => {
    const anchors = ['2026-03-01T00:00:00Z', '2026-03-10T07:00:00Z', '2026-03-10T09:00:00Z', null];
    const nows = ['2026-03-10T00:00:00Z', '2026-03-10T08:00:00Z', '2026-03-10T23:59:59Z'];
    for (const a of anchors) {
      for (const n of nows) {
        const r = digestDue(daily, { anchor: a ? at(a) : null, now: at(n) });
        if (r.due) expect(r.to.getTime()).toBeGreaterThanOrEqual(r.from.getTime());
      }
    }
  });

  test('weekly is due only once a week', () => {
    const weekly = { schedule: 'weekly', hour: 8, dayOfWeek: 1 };
    const anchor = at('2026-03-09T08:00:00Z'); // that Monday
    expect(digestDue(weekly, { anchor, now: at('2026-03-10T08:00:00Z') }).due).toBe(false);
    expect(digestDue(weekly, { anchor, now: at('2026-03-15T23:00:00Z') }).due).toBe(false);
    expect(digestDue(weekly, { anchor, now: at('2026-03-16T08:00:00Z') }).due).toBe(true);
  });

  test('a malformed schedule still produces a usable decision', () => {
    const r = digestDue({ schedule: 'fortnightly', hour: 99 }, {
      anchor: at('2026-03-09T00:00:00Z'),
      now: at('2026-03-10T09:00:00Z'),
    });
    expect(typeof r.due).toBe('boolean');
  });
});

describe('periodLabel', () => {
  test('describes a day', () => {
    expect(periodLabel(at('2026-03-09T08:00:00Z'), at('2026-03-10T08:00:00Z'))).toBe('the last 24 hours');
  });

  test('describes a week', () => {
    expect(periodLabel(at('2026-03-03T08:00:00Z'), at('2026-03-10T08:00:00Z'))).toBe('the last 7 days');
  });

  test('describes a short window', () => {
    expect(periodLabel(at('2026-03-10T07:00:00Z'), at('2026-03-10T08:00:00Z'))).toBe('the last hour');
  });

  test('never produces a negative period', () => {
    expect(periodLabel(at('2026-03-10T08:00:00Z'), at('2026-03-09T08:00:00Z'))).toBe('the last hour');
  });
});
