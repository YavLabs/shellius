import { describe, it, expect } from 'vitest';
import {
  groupPlan,
  targetsByCredentialSource,
  needsSuppliedCredentials,
  credentialSourceLabel,
  selectableHosts,
  defaultSelection,
  reinstallReason,
} from './installPlan';

const plan = {
  targets: [
    { id: 'a', credentialSource: 'server', credential: { id: 'c1', name: 'Bastion key' } },
    { id: 'b', credentialSource: 'certificate' },
    { id: 'c', credentialSource: 'supplied' },
  ],
  skipped: [
    { id: 'd', reason: 'no_credentials' },
    { id: 'e', reason: 'windows' },
    { id: 'f', reason: 'rdp_only' },
    { id: 'g', reason: 'inactive' },
    { id: 'h', reason: 'collector_installed', stale: false, installable: true },
    { id: 'i', reason: 'collector_installed', stale: true, needsReinstall: true, installable: true },
    { id: 'j', reason: 'collector_installed', degraded: true, needsReinstall: true, installable: true },
    { id: 'k', reason: 'collector_installed', rejected: true, needsReinstall: true, installable: false },
  ],
};

const rowsOf = (key) => groupPlan(plan).find((g) => g.key === key).rows.map((r) => r.id);

describe('groupPlan', () => {
  it('puts every host in exactly one group', () => {
    const all = groupPlan(plan).flatMap((g) => g.rows.map((r) => r.id));
    expect(all.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']);
    expect(new Set(all).size).toBe(all.length);
  });

  it('lets every group a host can be re-run from be selected — never the unreachable ones', () => {
    expect(groupPlan(plan).filter((g) => g.selectable).map((g) => g.key)).toEqual([
      'ready',
      'needs_reinstall',
      'installed',
    ]);
  });

  // The whole point: "Install on all of them" used to include hosts the
  // planner would immediately refuse, so the count you clicked was never
  // the count that ran.
  it('never offers a host that cannot run the collector as installable', () => {
    expect(rowsOf('ready')).toEqual(['a', 'b', 'c']);
    expect(rowsOf('not_applicable').sort()).toEqual(['e', 'f', 'g']);
  });

  // The bug: a DEGRADED host was listed as "Already done — reporting", with
  // no way to re-run on it short of a global toggle.
  it('puts degraded, refused and stale collectors in "needs a reinstall", apart from healthy ones', () => {
    expect(rowsOf('needs_reinstall')).toEqual(['i', 'j', 'k']);
    expect(rowsOf('installed')).toEqual(['h']);
  });

  it('keeps "needs credentials" apart from "cannot run it"', () => {
    expect(rowsOf('needs_credentials')).toEqual(['d']);
  });

  it('survives an empty or missing plan', () => {
    expect(groupPlan(null).every((g) => g.rows.length === 0)).toBe(true);
    expect(groupPlan({}).every((g) => g.rows.length === 0)).toBe(true);
  });
});

describe('targetsByCredentialSource', () => {
  it('groups in a stable order and drops empty groups', () => {
    expect(targetsByCredentialSource(plan.targets).map((g) => g.key)).toEqual([
      'server',
      'certificate',
      'supplied',
    ]);
    expect(targetsByCredentialSource([{ id: 'b', credentialSource: 'certificate' }]).map((g) => g.key)).toEqual(
      ['certificate']
    );
  });
});

describe('needsSuppliedCredentials', () => {
  // A bootstrapped fleet needs nothing typed. Asking for a password anyway
  // is what made the wizard look like it could not be used.
  it('is false when every host carries its own way in', () => {
    expect(
      needsSuppliedCredentials([
        { credentialSource: 'server' },
        { credentialSource: 'certificate' },
      ])
    ).toBe(false);
  });

  it('is true as soon as one host has nothing of its own', () => {
    expect(needsSuppliedCredentials([{ credentialSource: 'supplied' }])).toBe(true);
  });
});

describe('credentialSourceLabel', () => {
  it('names the identity when there is one', () => {
    expect(credentialSourceLabel(plan.targets[0])).toBe('Saved identity: Bastion key');
  });
  it('falls back to the plain label', () => {
    expect(credentialSourceLabel(plan.targets[1])).toBe('Certificate');
  });
  it('returns null for a host with no source', () => {
    expect(credentialSourceLabel({ credentialSource: null })).toBeNull();
  });
});

describe('selection', () => {
  it('offers ready hosts and every reachable installed host', () => {
    expect(selectableHosts(plan).map((h) => h.id)).toEqual(['a', 'b', 'c', 'h', 'i', 'j']);
  });

  it('pre-selects what needs doing — never a healthy host, never an unreachable one', () => {
    expect(defaultSelection(plan)).toEqual(['a', 'b', 'c', 'i', 'j']);
  });

  it('names why an installed host needs a reinstall', () => {
    expect(reinstallReason({ rejected: true })).toBe('Reports refused');
    expect(reinstallReason({ collectorState: 'degraded' })).toBe('Degraded');
    expect(reinstallReason({ stale: true })).toBe('Stopped reporting');
    expect(reinstallReason({ outdated: true })).toBe('Update available');
    expect(reinstallReason({})).toBeNull();
  });
});
