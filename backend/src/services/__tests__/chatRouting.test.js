/**
 * Which destinations an event reaches.
 *
 * A chat channel is a shared, permanent, multi-reader destination, and it has
 * no scope of its own. Everything below is about the consequences of that:
 * an event must not reach a channel belonging to a different customer, must
 * not reach one filtered to a different environment, and — for the six
 * payloads that are bearer credentials — must not reach chat at all.
 *
 * These are pure routing tests. `matches()` is a function of a destination, an
 * event and the event's subject, so it needs no database.
 */

import { matches } from '../notify/chatDestinationService.js';
import {
  getEvent,
  CHAT_SAFE_EVENT_KEYS,
  CHAT_DEFAULT_EVENT_KEYS,
  NOTIFICATION_EVENTS,
} from '../../config/notificationEvents.js';

const destination = (over = {}) => ({
  isActive: true,
  events: [],
  environments: [],
  customerIds: [],
  minSeverity: null,
  ...over,
});

const SUBMITTED = getEvent('access_request.submitted');
const APPROVED = getEvent('access_request.approved');
const BREAK_GLASS = getEvent('break_glass.invoked');
const DIRECTORY = getEvent('directory_sync.alert');

describe('chat routing', () => {
  test('an inactive destination receives nothing', () => {
    expect(matches(destination({ isActive: false }), SUBMITTED, {})).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  test('an unconfigured destination gets the default events, not every event', () => {
    const d = destination();
    expect(matches(d, SUBMITTED, {})).toBe(true);
    // Somebody's own access being approved is not channel material; it is
    // still selectable, just not implied by leaving the list empty.
    expect(matches(d, APPROVED, {})).toBe(false);
  });

  test('an explicit list is honoured exactly', () => {
    const d = destination({ events: ['access_request.approved'] });
    expect(matches(d, APPROVED, {})).toBe(true);
    expect(matches(d, SUBMITTED, {})).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Severity
  // -------------------------------------------------------------------------

  test('a severity floor drops quieter events', () => {
    const d = destination({ events: CHAT_SAFE_EVENT_KEYS, minSeverity: 'warning' });
    expect(matches(d, BREAK_GLASS, {})).toBe(true); // critical
    expect(matches(d, APPROVED, {})).toBe(false); // info
  });

  // -------------------------------------------------------------------------
  // Environment
  // -------------------------------------------------------------------------

  test('an environment filter keeps a production channel to production', () => {
    const d = destination({ environments: ['prod'] });
    expect(matches(d, SUBMITTED, { environment: 'prod' })).toBe(true);
    expect(matches(d, SUBMITTED, { environment: 'dev' })).toBe(false);
  });

  test('an event with no environment does not satisfy an environment filter', () => {
    // A directory sync concerns no server. Letting it through a "prod only"
    // filter would make the filter mean nothing.
    const d = destination({ environments: ['prod'] });
    expect(matches(d, DIRECTORY, {})).toBe(false);
    expect(matches(destination(), DIRECTORY, {})).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Customer scope — the tenancy rule
  // -------------------------------------------------------------------------

  test('a destination with no customers set receives nothing belonging to a customer', () => {
    // Deny by default, deliberately against the "empty means all" convention
    // used for events. An MSP with one Slack channel must not have every
    // customer's servers, requesters and reasons announced in it.
    const d = destination();
    expect(matches(d, SUBMITTED, { customerId: 'cust_a' })).toBe(false);
    expect(matches(d, SUBMITTED, {})).toBe(true);
  });

  test('a destination receives only its own customers', () => {
    const d = destination({ customerIds: ['cust_a'] });
    expect(matches(d, SUBMITTED, { customerId: 'cust_a' })).toBe(true);
    expect(matches(d, SUBMITTED, { customerId: 'cust_b' })).toBe(false);
  });

  test('customer scope is checked even when every other filter is open', () => {
    const d = destination({ events: CHAT_SAFE_EVENT_KEYS, environments: [], minSeverity: null });
    expect(matches(d, BREAK_GLASS, { customerId: 'cust_b' })).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The catalogue's own guarantees
  // -------------------------------------------------------------------------

  test('nothing carrying a bearer credential is chat-deliverable', () => {
    // These six are the payloads that grant an action as one named person:
    // invite, password reset, email verification, the approval link, the SSO
    // link approval and the MFA code. None of them writes an in-app
    // notification, so none should ever appear in this catalogue at all.
    const forbidden = ['invite', 'password_reset', 'email_verify', 'mfa', 'sso_link', 'approval_token'];
    for (const key of CHAT_SAFE_EVENT_KEYS) {
      for (const f of forbidden) expect(key).not.toContain(f);
    }
  });

  test('every event names a real NotificationType and a known severity', () => {
    const types = new Set([
      'ACCESS_REQUEST_SUBMITTED',
      'ACCESS_REQUEST_APPROVED',
      'ACCESS_REQUEST_DENIED',
      'ACCESS_REQUEST_EXPIRING',
      'ACCESS_REQUEST_EXPIRED',
      'ACCESS_REQUEST_REVOKED',
      'BREAK_GLASS_INVOKED',
      'POSTURE_FINDING',
      'DIRECTORY_SYNC',
    ]);
    for (const e of NOTIFICATION_EVENTS) {
      expect(types.has(e.type)).toBe(true);
      expect(['info', 'notice', 'warning', 'critical']).toContain(e.severity);
    }
  });

  test('the loud events are on by default and the personal ones are not', () => {
    expect(CHAT_DEFAULT_EVENT_KEYS).toEqual(
      expect.arrayContaining(['break_glass.invoked', 'access_request.submitted', 'access_request.prod_bypass'])
    );
    expect(CHAT_DEFAULT_EVENT_KEYS).not.toContain('access_request.expiring');
  });
});
