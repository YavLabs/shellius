import { describe, expect, it } from 'vitest';
import {
  SEVERITIES,
  CHAT_VARIANTS,
  getVariant,
  variantsForPlatform,
  variantFor,
  severityRank,
  severityLabel,
  severityTone,
  chatDestinationStatus,
  isBackingOff,
  chatDeliveryStatusBadge,
  customerScopeSummary,
  CUSTOMER_SCOPE_WARNING,
  defaultEventKeys,
  eventsSummary,
} from './chatTypes';

describe('CHAT_VARIANTS', () => {
  it('every variant has fields, an icon, and a platform', () => {
    for (const v of CHAT_VARIANTS) {
      expect(Array.isArray(v.fields)).toBe(true);
      expect(v.fields.length).toBeGreaterThan(0);
      expect(v.icon).toBeTruthy();
      expect(v.platform).toBeTruthy();
    }
  });

  it('only slack_app can act or DM', () => {
    for (const v of CHAT_VARIANTS) {
      if (v.key === 'slack_app') {
        expect(v.canAct).toBe(true);
        expect(v.supportsDirectMessages).toBe(true);
      } else {
        expect(v.canAct).toBe(false);
        expect(v.supportsDirectMessages).toBe(false);
      }
    }
  });

  it('states the platform limit for the one-way platforms, not "missing feature"', () => {
    const googleChat = getVariant('google_chat');
    const teams = getVariant('teams');
    expect(googleChat.actionNote).toMatch(/platform limit/i);
    expect(teams.actionNote).toMatch(/platform limit/i);
  });

  it('treats the URL as a secret on slack, google_chat and teams, but not on webhook', () => {
    const secretFieldKeys = (v) => v.fields.filter((f) => f.secret).map((f) => f.key);
    expect(secretFieldKeys(getVariant('slack_webhook'))).toEqual(['url']);
    expect(secretFieldKeys(getVariant('google_chat'))).toEqual(['url']);
    expect(secretFieldKeys(getVariant('teams'))).toEqual(['url']);
    const webhookFields = getVariant('webhook').fields;
    expect(webhookFields.find((f) => f.key === 'url').secret).toBeFalsy();
    expect(webhookFields.find((f) => f.key === 'signingSecret').secret).toBe(true);
  });
});

describe('getVariant / variantsForPlatform / variantFor', () => {
  it('finds a known variant by key', () => {
    expect(getVariant('slack_app')?.label).toBe('Slack — App (bot token)');
  });

  it('returns null for an unknown key', () => {
    expect(getVariant('carrier_pigeon')).toBeNull();
  });

  it('slack has two variants, everything else has one', () => {
    expect(variantsForPlatform('slack').map((v) => v.key).sort()).toEqual(['slack_app', 'slack_webhook']);
    expect(variantsForPlatform('teams').map((v) => v.key)).toEqual(['teams']);
    expect(variantsForPlatform('webhook').map((v) => v.key)).toEqual(['webhook']);
  });

  it('variantFor matches platform + mode', () => {
    expect(variantFor('slack', 'app')?.key).toBe('slack_app');
    expect(variantFor('slack', 'webhook')?.key).toBe('slack_webhook');
    expect(variantFor('teams', null)?.key).toBe('teams');
    expect(variantFor('teams')?.key).toBe('teams');
  });

  it('variantFor falls back to the platform default rather than null on an unknown mode', () => {
    expect(variantFor('teams', 'app')?.key).toBe('teams');
  });

  it('variantFor returns null for an unknown platform', () => {
    expect(variantFor('carrier_pigeon', null)).toBeNull();
  });
});

describe('severity ordering', () => {
  it('is worst-last, matching the backend', () => {
    expect(SEVERITIES).toEqual(['info', 'notice', 'warning', 'critical']);
  });

  it('severityRank orders low to high', () => {
    expect(severityRank('info')).toBeLessThan(severityRank('notice'));
    expect(severityRank('notice')).toBeLessThan(severityRank('warning'));
    expect(severityRank('warning')).toBeLessThan(severityRank('critical'));
  });

  it('severityRank degrades to 0 for an unknown value', () => {
    expect(severityRank('made-up')).toBe(0);
    expect(severityRank(undefined)).toBe(0);
  });

  it('severityLabel capitalizes', () => {
    expect(severityLabel('critical')).toBe('Critical');
    expect(severityLabel('')).toBe('');
  });

  it('severityTone maps critical to danger and unknown to neutral', () => {
    expect(severityTone('critical')).toBe('danger');
    expect(severityTone('warning')).toBe('warning');
    expect(severityTone('notice')).toBe('info');
    expect(severityTone('info')).toBe('neutral');
    expect(severityTone('nope')).toBe('neutral');
  });
});

describe('chatDestinationStatus', () => {
  it('is Disabled whenever disabledReason is set, even if isActive is stale-true', () => {
    expect(chatDestinationStatus({ isActive: true, disabledReason: 'Switched off after 10 consecutive failures' })).toEqual({
      tone: 'danger',
      label: 'Disabled',
    });
  });

  it('is Off when inactive and no failure', () => {
    expect(chatDestinationStatus({ isActive: false, consecutiveFailures: 0 })).toEqual({ tone: 'neutral', label: 'Off' });
  });

  it('is Failing while active but retrying', () => {
    expect(chatDestinationStatus({ isActive: true, consecutiveFailures: 4 })).toEqual({ tone: 'warning', label: 'Failing (4×)' });
  });

  it('is Active when healthy', () => {
    expect(chatDestinationStatus({ isActive: true, consecutiveFailures: 0 })).toEqual({ tone: 'success', label: 'Active' });
  });

  it('handles a missing destination', () => {
    expect(chatDestinationStatus(null)).toEqual({ tone: 'neutral', label: 'Unknown' });
  });
});

describe('isBackingOff', () => {
  it('is true only while backoffUntil is in the future', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(isBackingOff({ backoffUntil: '2026-01-01T00:00:01Z' }, now)).toBe(true);
    expect(isBackingOff({ backoffUntil: '2025-12-31T23:59:59Z' }, now)).toBe(false);
    expect(isBackingOff({ backoffUntil: null }, now)).toBe(false);
    expect(isBackingOff({}, now)).toBe(false);
  });
});

describe('chatDeliveryStatusBadge', () => {
  it('maps every backend status to a tone', () => {
    expect(chatDeliveryStatusBadge('delivered')).toEqual({ tone: 'success', label: 'Delivered' });
    expect(chatDeliveryStatusBadge('failed')).toEqual({ tone: 'danger', label: 'Failed' });
    expect(chatDeliveryStatusBadge('queued')).toEqual({ tone: 'info', label: 'Queued' });
    expect(chatDeliveryStatusBadge('dropped')).toEqual({ tone: 'neutral', label: 'Dropped' });
  });

  it('falls back for anything else', () => {
    expect(chatDeliveryStatusBadge('weird')).toEqual({ tone: 'neutral', label: 'weird' });
    expect(chatDeliveryStatusBadge(undefined)).toEqual({ tone: 'neutral', label: 'Unknown' });
  });
});

describe('customerScopeSummary', () => {
  it('is explicit that empty means org-wide only, not everything', () => {
    expect(customerScopeSummary([])).toBe('No customers selected — only org-wide events (nothing tied to a customer) are sent');
    expect(customerScopeSummary(undefined)).toBe('No customers selected — only org-wide events (nothing tied to a customer) are sent');
  });

  it('counts selected customers, singular and plural', () => {
    expect(customerScopeSummary(['c1'])).toBe('1 customer selected');
    expect(customerScopeSummary(['c1', 'c2'])).toBe('2 customers selected');
  });

  it('the standalone warning names both the deny-by-default rule and the events field it inverts', () => {
    expect(CUSTOMER_SCOPE_WARNING).toMatch(/opposite of Events/i);
    expect(CUSTOMER_SCOPE_WARNING).toMatch(/explicitly/i);
  });
});

describe('events default / empty handling', () => {
  const events = [
    { key: 'a', label: 'Event A', chatDefault: true },
    { key: 'b', label: 'Event B', chatDefault: false },
    { key: 'c', label: 'Event C', chatDefault: true },
  ];

  it('defaultEventKeys returns only chatDefault events', () => {
    expect(defaultEventKeys(events)).toEqual(['a', 'c']);
  });

  it('defaultEventKeys handles an empty catalogue', () => {
    expect(defaultEventKeys([])).toEqual([]);
    expect(defaultEventKeys(undefined)).toEqual([]);
  });

  it('an empty selection resolves to the defaults, not everything and not nothing', () => {
    const summary = eventsSummary([], events);
    expect(summary.usingDefaults).toBe(true);
    expect(summary.keys).toEqual(['a', 'c']);
    expect(summary.text).toBe('Using the defaults: Event A, Event C');
  });

  it('a non-empty selection is reported as-is', () => {
    const summary = eventsSummary(['b'], events);
    expect(summary.usingDefaults).toBe(false);
    expect(summary.keys).toEqual(['b']);
    expect(summary.text).toBe('1 event selected');
  });

  it('pluralizes the count', () => {
    expect(eventsSummary(['a', 'b'], events).text).toBe('2 events selected');
  });
});
