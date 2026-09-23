import { describe, expect, it } from 'vitest';
import {
  ADAPTER_TYPES,
  getAdapterType,
  valuesFromConfig,
  missingRequiredFields,
  ACTION_OPTIONS,
  actionHelp,
  SAFETY_LIMIT_FIELDS,
  isArmed,
  dryRunLabel,
  modeBadge,
  activeBadge,
  runStatusBadge,
  showIdentityCaveat,
  identityCaveatMessage,
  findingReasonLabel,
  findingStatusBadge,
  sinceLabel,
} from './adapterTypes';

describe('getAdapterType', () => {
  it('finds a known adapter', () => {
    expect(getAdapterType('entra')?.label).toBe('Microsoft Entra ID');
    expect(getAdapterType('okta')?.label).toBe('Okta');
    expect(getAdapterType('google')?.label).toBe('Google Workspace');
    expect(getAdapterType('github')?.label).toBe('GitHub');
  });

  it('returns null for an unknown or missing type', () => {
    expect(getAdapterType('ldap')).toBeNull();
    expect(getAdapterType(undefined)).toBeNull();
  });

  it('every adapter has at least one required secret field and an icon', () => {
    for (const a of ADAPTER_TYPES) {
      expect(Array.isArray(a.fields)).toBe(true);
      expect(a.fields.some((f) => f.secret)).toBe(true);
      expect(a.icon).toBeTruthy();
      expect(a.help).toBeTruthy();
    }
  });

  it('google requires adminEmail (the impersonation caveat) as well as the service account', () => {
    const google = getAdapterType('google');
    const keys = google.fields.map((f) => f.key);
    expect(keys).toEqual(['clientEmail', 'adminEmail', 'privateKey', 'customer']);
    expect(google.fields.find((f) => f.key === 'adminEmail').required).toBe(true);
    expect(google.fields.find((f) => f.key === 'privateKey').kind).toBe('textarea');
    expect(google.fields.find((f) => f.key === 'customer').required).toBeFalsy();
  });
});

describe('valuesFromConfig', () => {
  it('never populates a secret field back into the form', () => {
    const def = getAdapterType('okta');
    const values = valuesFromConfig(def, { domain: 'acme.okta.com', apiToken: { set: true } });
    expect(values).toEqual({ domain: 'acme.okta.com', apiToken: '' });
  });

  it('defaults missing non-secret fields to an empty string', () => {
    const def = getAdapterType('github');
    expect(valuesFromConfig(def, {})).toEqual({ org: '', token: '' });
  });

  it('degrades to an empty object for an unknown adapter', () => {
    expect(valuesFromConfig(null, {})).toEqual({});
  });
});

describe('missingRequiredFields', () => {
  const def = getAdapterType('entra');

  it('lists every required field left blank on create', () => {
    const missing = missingRequiredFields(def, { tenantId: '', clientId: '', clientSecret: '' }, { isEdit: false });
    expect(missing.map((f) => f.key)).toEqual(['tenantId', 'clientId', 'clientSecret']);
  });

  it('is satisfied once every required field has a value', () => {
    const missing = missingRequiredFields(
      def,
      { tenantId: 't', clientId: 'c', clientSecret: 's' },
      { isEdit: false }
    );
    expect(missing).toEqual([]);
  });

  it('treats an already-stored secret as present on edit even though its form value is blank', () => {
    const missing = missingRequiredFields(
      def,
      { tenantId: 't', clientId: 'c', clientSecret: '' },
      { isEdit: true, storedConfig: { clientSecret: { set: true } } }
    );
    expect(missing).toEqual([]);
  });

  it('still requires the secret on edit if none was ever stored', () => {
    const missing = missingRequiredFields(
      def,
      { tenantId: 't', clientId: 'c', clientSecret: '' },
      { isEdit: true, storedConfig: { clientSecret: { set: false } } }
    );
    expect(missing.map((f) => f.key)).toEqual(['clientSecret']);
  });
});

describe('ACTION_OPTIONS / actionHelp', () => {
  it('has exactly flag and suspend', () => {
    expect(ACTION_OPTIONS.map((o) => o.value)).toEqual(['flag', 'suspend']);
  });

  it('returns the matching help text', () => {
    expect(actionHelp('flag')).toMatch(/Never suspends/);
    expect(actionHelp('suspend')).toMatch(/safety limits/);
    expect(actionHelp('nonsense')).toBe('');
  });
});

describe('SAFETY_LIMIT_FIELDS', () => {
  it('documents all three brakes with a one-line explanation each', () => {
    expect(SAFETY_LIMIT_FIELDS.map((f) => f.key)).toEqual(['maxSuspendPercent', 'maxSuspendCount', 'graceHours']);
    for (const f of SAFETY_LIMIT_FIELDS) {
      expect(f.help.length).toBeGreaterThan(10);
    }
  });
});

describe('isArmed', () => {
  it('is armed only when dry run is explicitly off and action is suspend', () => {
    expect(isArmed({ dryRun: false, action: 'suspend' })).toBe(true);
  });

  it('is not armed while dry run is on', () => {
    expect(isArmed({ dryRun: true, action: 'suspend' })).toBe(false);
  });

  it('is not armed when only flagging, even with dry run off', () => {
    expect(isArmed({ dryRun: false, action: 'flag' })).toBe(false);
  });

  it('treats a missing/undefined dryRun as not-yet-armed (safe default)', () => {
    expect(isArmed({ action: 'suspend' })).toBe(false);
    expect(isArmed()).toBe(false);
  });
});

describe('dryRunLabel', () => {
  it('uses the exact dry-run copy', () => {
    expect(dryRunLabel({ dryRun: true, action: 'suspend' })).toBe('Dry run — reports only, changes nothing');
  });

  it('warns plainly once armed', () => {
    expect(dryRunLabel({ dryRun: false, action: 'suspend' })).toMatch(/suspended automatically/);
  });

  it('is reassuring for a live flag-only config', () => {
    expect(dryRunLabel({ dryRun: false, action: 'flag' })).toMatch(/no accounts are suspended/);
  });
});

describe('modeBadge / activeBadge', () => {
  it('modeBadge reflects dry run, armed and flag-only', () => {
    expect(modeBadge(null)).toEqual({ tone: 'neutral', label: 'Not configured' });
    expect(modeBadge({ dryRun: true, action: 'suspend' })).toEqual({ tone: 'info', label: 'Dry run' });
    expect(modeBadge({ dryRun: false, action: 'suspend' })).toEqual({ tone: 'warning', label: 'Armed' });
    expect(modeBadge({ dryRun: false, action: 'flag' })).toEqual({ tone: 'neutral', label: 'Flag only' });
  });

  it('activeBadge reflects isActive', () => {
    expect(activeBadge(null)).toEqual({ tone: 'neutral', label: 'Not configured' });
    expect(activeBadge({ isActive: true })).toEqual({ tone: 'success', label: 'Active' });
    expect(activeBadge({ isActive: false })).toEqual({ tone: 'neutral', label: 'Off' });
  });
});

describe('runStatusBadge', () => {
  it('styles aborted as a warning, never as a failure', () => {
    expect(runStatusBadge('aborted')).toEqual({ tone: 'warning', label: 'Aborted' });
  });

  it('styles failed as danger', () => {
    expect(runStatusBadge('failed')).toEqual({ tone: 'danger', label: 'Failed' });
  });

  it('styles ok as success and running as info', () => {
    expect(runStatusBadge('ok')).toEqual({ tone: 'success', label: 'Ok' });
    expect(runStatusBadge('running')).toEqual({ tone: 'info', label: 'Running' });
  });

  it('falls back for anything else', () => {
    expect(runStatusBadge('weird')).toEqual({ tone: 'neutral', label: 'weird' });
    expect(runStatusBadge(undefined)).toEqual({ tone: 'neutral', label: 'Unknown' });
  });
});

describe('showIdentityCaveat', () => {
  it('is true when some identities are unknown', () => {
    expect(showIdentityCaveat({ unknownIdentities: 3, matchedByExternalId: 10, matchedByEmail: 0 })).toBe(true);
  });

  it('is true when nothing matched by external id but email matching picked up the slack', () => {
    expect(showIdentityCaveat({ unknownIdentities: 0, matchedByExternalId: 0, matchedByEmail: 12 })).toBe(true);
  });

  it('is false for a clean external-id match with nothing unknown', () => {
    expect(showIdentityCaveat({ unknownIdentities: 0, matchedByExternalId: 20, matchedByEmail: 0 })).toBe(false);
  });

  it('handles a missing run', () => {
    expect(showIdentityCaveat(null)).toBe(false);
  });
});

describe('identityCaveatMessage', () => {
  it('adds the Entra-specific sub/oid explanation only for entra', () => {
    expect(identityCaveatMessage('entra')).toMatch(/oid claim/);
    expect(identityCaveatMessage('okta')).not.toMatch(/oid claim/);
  });

  it('always explains that unknown accounts were skipped, not judged missing', () => {
    expect(identityCaveatMessage('github')).toMatch(/not judged either way/);
  });
});

describe('findingReasonLabel / findingStatusBadge', () => {
  it('labels missing and disabled reasons', () => {
    expect(findingReasonLabel('missing')).toBe('Missing from directory');
    expect(findingReasonLabel('disabled')).toBe('Disabled in directory');
    expect(findingReasonLabel('weird')).toBe('weird');
  });

  // These four are the whole of DirectorySyncFinding.status. Anything else
  // falling through to "Unknown" means the backend grew a value the UI has
  // not been told about.
  it('badges every finding status the backend can write', () => {
    expect(findingStatusBadge('open')).toEqual({ tone: 'warning', label: 'Open' });
    expect(findingStatusBadge('resolved')).toEqual({ tone: 'success', label: 'Resolved' });
    expect(findingStatusBadge('acted')).toEqual({ tone: 'danger', label: 'Deprovisioned' });
    expect(findingStatusBadge('ignored')).toEqual({ tone: 'neutral', label: 'Left alone' });
  });
});

describe('sinceLabel', () => {
  it('formats a date as "since D Mon"', () => {
    expect(sinceLabel('2026-03-14T00:00:00.000Z')).toMatch(/^since \d{1,2} Mar$/);
  });

  it('returns null for a missing or invalid date', () => {
    expect(sinceLabel(null)).toBeNull();
    expect(sinceLabel(undefined)).toBeNull();
    expect(sinceLabel('not-a-date')).toBeNull();
  });
});
