/**
 * postureAlertRuleSchema.test.js — what the alert-rule API accepts, and what
 * a partial update must leave alone.
 *
 * Two bugs live here, both of the "silently delivers nothing" family that
 * posture alerting has produced twice already:
 *
 *   1. `mode: 'digest'` was accepted with no job behind it, so choosing it
 *      stopped a rule emailing anybody. It is accepted again only because
 *      jobs/postureDigest.js now exists.
 *   2. The update schema was built by forking the create schema's keys to
 *      `.optional()`, which leaves every `.default(...)` in place. Joi then
 *      filled in defaults for keys the caller had not sent, so
 *      `PUT /alert-rules/:id` with `{ isActive: false }` did not pause a
 *      rule — it also reset its severities to "any", dropped `email` from its
 *      channels and zeroed its throttle. The service layer's `pick()` cannot
 *      tell a defaulted value from a supplied one, so the fix is
 *      `noDefaults: true` at validation time.
 */

import { alertRuleBodySchema, alertRuleUpdateSchema } from '../posture.js';

/** How routes/posture.js validates a create. */
const create = (body) => alertRuleBodySchema.validate(body, { abortEarly: false, stripUnknown: true });
/** How routes/posture.js validates an update (validatePartial). */
const update = (body) =>
  alertRuleUpdateSchema.validate(body, { abortEarly: false, stripUnknown: true, noDefaults: true });

describe('alert rule — create', () => {
  test('defaults to an immediate, in-app rule', () => {
    const { error, value } = create({ name: 'r' });
    expect(error).toBeUndefined();
    expect(value.mode).toBe('immediate');
    expect(value.channels).toEqual(['inapp']);
  });

  test('accepts digest mode again', () => {
    const { error, value } = create({ name: 'r', mode: 'digest' });
    expect(error).toBeUndefined();
    expect(value.mode).toBe('digest');
  });

  test('a digest rule gets a daily 08:00 cadence by default', () => {
    const { value } = create({ name: 'r', mode: 'digest' });
    expect(value.digestSchedule).toBe('daily');
    expect(value.digestHour).toBe(8);
  });

  test('accepts a weekly cadence with a day', () => {
    const { error, value } = create({
      name: 'r',
      mode: 'digest',
      digestSchedule: 'weekly',
      digestDayOfWeek: 0,
      digestHour: 17,
    });
    expect(error).toBeUndefined();
    expect(value.digestDayOfWeek).toBe(0);
    expect(value.digestHour).toBe(17);
  });

  test.each([
    ['an unknown mode', { mode: 'hourly' }],
    ['an unknown schedule', { mode: 'digest', digestSchedule: 'fortnightly' }],
    ['an hour above 23', { mode: 'digest', digestHour: 24 }],
    ['a negative hour', { mode: 'digest', digestHour: -1 }],
    ['a day above 6', { mode: 'digest', digestSchedule: 'weekly', digestDayOfWeek: 7 }],
    ['an unknown channel', { channels: ['sms'] }],
    ['an unknown severity', { severities: ['SPICY'] }],
  ])('refuses %s', (_label, patch) => {
    const { error } = create({ name: 'r', ...patch });
    expect(error).toBeDefined();
  });

  test('hour 0 is a real choice, not a missing value', () => {
    const { error, value } = create({ name: 'r', mode: 'digest', digestHour: 0 });
    expect(error).toBeUndefined();
    expect(value.digestHour).toBe(0);
  });

  test('name is required', () => {
    expect(create({}).error).toBeDefined();
  });
});

describe('alert rule — partial update', () => {
  // The headline regression: pausing a rule must only pause it.
  test('leaves every unsent field absent', () => {
    const { error, value } = update({ isActive: false });
    expect(error).toBeUndefined();
    expect(value).toEqual({ isActive: false });
    expect(value).not.toHaveProperty('channels');
    expect(value).not.toHaveProperty('mode');
    expect(value).not.toHaveProperty('severities');
    expect(value).not.toHaveProperty('throttleMinutes');
  });

  test('does not silently reset a digest rule to immediate', () => {
    const { value } = update({ name: 'renamed' });
    expect(value).not.toHaveProperty('mode');
    expect(value).not.toHaveProperty('digestSchedule');
    expect(value).not.toHaveProperty('digestHour');
  });

  test('does not silently drop the email channel', () => {
    const { value } = update({ throttleMinutes: 30 });
    expect(value).not.toHaveProperty('channels');
  });

  test('still validates the fields it is given', () => {
    expect(update({ mode: 'nonsense' }).error).toBeDefined();
    expect(update({ digestHour: 99 }).error).toBeDefined();
    expect(update({ channels: ['carrier-pigeon'] }).error).toBeDefined();
  });

  test('an empty body is refused', () => {
    expect(update({}).error).toBeDefined();
  });

  test('name stays optional on update', () => {
    expect(update({ isActive: true }).error).toBeUndefined();
  });

  test('a full update still works', () => {
    const { error, value } = update({
      name: 'r',
      mode: 'digest',
      digestSchedule: 'weekly',
      digestDayOfWeek: 3,
      digestHour: 9,
      channels: ['email', 'inapp'],
    });
    expect(error).toBeUndefined();
    expect(value.digestDayOfWeek).toBe(3);
    expect(value.channels).toEqual(['email', 'inapp']);
  });
});
