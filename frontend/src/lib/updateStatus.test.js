import { describe, expect, it } from 'vitest';
import { summarizeUpdateStatus, updateCommand } from './updateStatus';

describe('summarizeUpdateStatus', () => {
  it('shows a neutral placeholder while loading', () => {
    expect(summarizeUpdateStatus(null)).toEqual({ label: 'Checking…', tone: 'neutral', note: null });
  });

  it('presents disabled checks calmly — a supported config, not an error', () => {
    expect(
      summarizeUpdateStatus({ enabled: false, disabledReason: 'Update checks are turned off on this install' })
    ).toEqual({
      label: 'Checks are turned off',
      tone: 'neutral',
      note: 'Update checks are turned off on this install',
    });
  });

  it('flags an available update', () => {
    expect(
      summarizeUpdateStatus({ enabled: true, updateAvailable: true, latestVersion: '2.2.0', currentVersion: '2.1.0' })
    ).toEqual({ label: 'Update available: 2.2.0', tone: 'info', note: null });
  });

  it('reports up to date when no newer version exists', () => {
    expect(
      summarizeUpdateStatus({ enabled: true, updateAvailable: false, latestVersion: '2.1.0', currentVersion: '2.1.0' })
    ).toEqual({ label: 'Up to date', tone: 'success', note: null });
  });

  it('shows a muted note (not an alert) when the check failed but a stale result exists', () => {
    expect(
      summarizeUpdateStatus({
        enabled: true,
        updateAvailable: false,
        latestVersion: '2.1.0',
        error: 'Could not check for updates (timeout); showing the last known result',
      })
    ).toEqual({
      label: 'Up to date (last known)',
      tone: 'warning',
      note: 'Could not check for updates (timeout); showing the last known result',
    });
  });

  it('handles a failed check with no prior result at all', () => {
    expect(
      summarizeUpdateStatus({ enabled: true, updateAvailable: false, latestVersion: null, error: 'Could not check for updates: timeout' })
    ).toEqual({
      label: 'Could not check for updates',
      tone: 'warning',
      note: 'Could not check for updates: timeout',
    });
  });
});

describe('updateCommand', () => {
  it('builds the host command from the latest version', () => {
    expect(updateCommand('2.2.0')).toBe('./update-shellius.sh v2.2.0');
  });
});
