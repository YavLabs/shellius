/**
 * digestSchedule.js — when is a periodic digest next due, and what period
 * does it cover?
 *
 * Two features need this and both of them were shipped broken in exactly the
 * same way: a "digest" option that suppressed the immediate delivery and
 * deferred to a batching job nobody had written. Posture alert rules had it
 * (`mode: 'digest'`, removed in 2.0), and the `email_digest` audit sink still
 * has it — `jobs/auditExport.js` only selects `STREAMING_TYPES`, and
 * `email_digest` is `streaming: false`, so its `deliver()` is reachable only
 * from the Test button. One shared, tested scheduler is what stops a third
 * one being written the same way.
 *
 * Pure functions, no clock of their own and no I/O: `now` is always passed
 * in. Everything is UTC. Local time would mean carrying a timezone per rule
 * and reasoning about the two days a year that have 23 or 25 hours, for a
 * feature whose entire purpose is "roughly once a day" — so the UI says UTC
 * and means it.
 */

export const SCHEDULES = ['daily', 'weekly'];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Coerce stored settings into something safe to schedule on.
 *
 * Every field is defended because these arrive from a JSON config blob
 * (audit sinks) or from columns that predate the validation (posture rules
 * written while `mode: 'digest'` was still accepted). A row with nonsense in
 * it must produce a sane schedule, not an exception inside a job tick that
 * then skips every other row.
 */
export function normalizeSchedule({ schedule, hour, dayOfWeek } = {}) {
  const s = schedule === 'weekly' ? 'weekly' : 'daily';

  // `Number(null)` is 0, which is a perfectly valid hour — so coercing first
  // would turn every NULL column (i.e. every row that predates these fields)
  // into a midnight digest rather than the default. Same trap for dayOfWeek,
  // where 0 means Sunday. Reject nullish explicitly, before coercing.
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

  let h = num(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) h = 8;
  let d = num(dayOfWeek);
  // 0 = Sunday, matching Date#getUTCDay.
  if (!Number.isInteger(d) || d < 0 || d > 6) d = 1; // Monday
  return { schedule: s, hour: h, dayOfWeek: s === 'weekly' ? d : null };
}

/**
 * The most recent scheduled instant at or before `now`.
 *
 * "At or before" is deliberate: a job tick landing exactly on 08:00:00.000
 * must see 08:00 as having arrived, or a digest scheduled for the hour a
 * repeatable job happens to fire on could be skipped forever.
 *
 * @returns {Date}
 */
export function previousOccurrence(settings, now = new Date()) {
  const { schedule, hour, dayOfWeek } = normalizeSchedule(settings);
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(t)) throw new TypeError('previousOccurrence: now is not a valid date');

  // Today's occurrence, in UTC.
  const d = new Date(t);
  const todayAtHour = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0, 0);

  if (schedule === 'daily') {
    return new Date(todayAtHour <= t ? todayAtHour : todayAtHour - DAY_MS);
  }

  // Weekly: step back at most 7 days to the wanted weekday at the wanted
  // hour. Starting from today's slot and walking backwards means the
  // boundary case (today IS the day, but the hour has not arrived) lands on
  // last week rather than seven days in the future.
  for (let back = 0; back <= 7; back += 1) {
    const candidate = todayAtHour - back * DAY_MS;
    if (candidate > t) continue;
    if (new Date(candidate).getUTCDay() === dayOfWeek) return new Date(candidate);
  }
  /* istanbul ignore next — unreachable: any 8-day window contains every weekday. */
  return new Date(todayAtHour - 7 * DAY_MS);
}

/**
 * Is a digest due, and what window would it cover?
 *
 * `anchor` is the last time this digest actually ran. When it has never run,
 * the caller passes the row's `createdAt` instead — which is what makes a
 * rule created at 07:00 send its first digest at 08:00 the same day, and,
 * far more importantly, stops a newly created rule mailing out every finding
 * the organization has ever recorded.
 *
 * A long outage collapses to ONE digest, not one per missed period: the
 * window simply stretches back to the anchor. Sending a week of daily
 * digests the moment an instance comes back up is how a digest feature
 * teaches people to filter it into a folder.
 *
 * @param {object} settings  { schedule, hour, dayOfWeek }
 * @param {object} opts
 * @param {Date|string|null} opts.anchor   lastRunAt, or createdAt on first run
 * @param {Date} [opts.now]
 * @param {number} [opts.maxWindowMs]  clamp for a very old anchor
 * @returns {{ due: boolean, from: Date, to: Date, reason?: string }}
 */
export function digestDue(settings, { anchor, now = new Date(), maxWindowMs = 31 * DAY_MS } = {}) {
  const to = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(to.getTime())) throw new TypeError('digestDue: now is not a valid date');

  const prev = previousOccurrence(settings, to);

  // No anchor at all (a row predating the column) is treated as "one period
  // ago" rather than "the beginning of time".
  let from = anchor ? new Date(anchor) : new Date(prev.getTime() - DAY_MS);
  if (!Number.isFinite(from.getTime())) from = new Date(prev.getTime() - DAY_MS);

  // An anchor in the future is a clock that went backwards, or a row edited
  // by hand. Refusing to send is the safe half of that: the next tick after
  // the clock catches up will send normally.
  if (from.getTime() > to.getTime()) {
    return { due: false, from, to, reason: 'anchor is in the future' };
  }

  if (prev.getTime() <= from.getTime()) {
    return { due: false, from, to, reason: 'no scheduled occurrence since the last run' };
  }

  // Clamp an ancient anchor so a re-enabled rule reports on a sane period
  // instead of scanning years of history.
  if (to.getTime() - from.getTime() > maxWindowMs) {
    from = new Date(to.getTime() - maxWindowMs);
    return { due: true, from, to, reason: 'window clamped' };
  }

  return { due: true, from, to };
}

/** "the last day" / "the last 7 days" — for the subject line and the body. */
export function periodLabel(from, to) {
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime());
  const hours = Math.round(ms / HOUR_MS);
  if (hours <= 1) return 'the last hour';
  if (hours < 36) return `the last ${hours} hours`;
  const days = Math.round(ms / DAY_MS);
  return `the last ${days} days`;
}

export default { SCHEDULES, normalizeSchedule, previousOccurrence, digestDue, periodLabel };
