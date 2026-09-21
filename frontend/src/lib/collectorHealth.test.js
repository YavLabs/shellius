import { describe, it, expect } from 'vitest';
import { explainDegraded, isOlderVersion, collectorStateOf } from './collectorHealth';

describe('explainDegraded', () => {
  it('turns the sudo failure into an explanation and a fix that a reinstall addresses', () => {
    const { items, reinstallHelps } = explainDegraded([
      "could not run 'ss' with the privilege needed to see other users' sockets (sudo grant missing or ss not on sudoers path): sudo: The \"no new privileges\" flag is set",
      "listener owners limited to the collector's own user",
    ]);
    expect(items).toHaveLength(1); // the second is a consequence of the first
    expect(items[0].title).toMatch(/sudo grant is not working/);
    expect(items[0].reinstallFixes).toBe(true);
    expect(reinstallHelps).toBe(true);
  });

  it('does not promise that a reinstall fixes a firewall it cannot read', () => {
    const { items, reinstallHelps } = explainDegraded([
      "iptables INPUT has rules this collector cannot evaluate (jumps to chain 'INPUT_custom') — reachability of ports behind them is not verified",
    ]);
    expect(items[0].reinstallFixes).toBe(false);
    expect(reinstallHelps).toBe(false);
  });

  it('marks notes that are not problems as informational', () => {
    const r = explainDegraded(['container id could not be resolved to a name/image (no Docker socket access)']);
    expect(r.onlyInformational).toBe(true);
  });

  it('keeps an unknown reason, verbatim, rather than dropping it', () => {
    const { items } = explainDegraded(['something new went wrong']);
    expect(items[0].explain).toBe('something new went wrong');
  });

  it('copes with nothing', () => {
    expect(explainDegraded([]).items).toEqual([]);
    expect(explainDegraded(undefined).items).toEqual([]);
  });
});

describe('isOlderVersion', () => {
  it('compares dotted versions numerically', () => {
    expect(isOlderVersion('1.0.0', '1.1.0')).toBe(true);
    expect(isOlderVersion('1.1.0', '1.1.0')).toBe(false);
    expect(isOlderVersion('1.10.0', '1.9.0')).toBe(false);
  });
  it('treats an unknown version as older, and no latest as nothing to compare', () => {
    expect(isOlderVersion(null, '1.1.0')).toBe(true);
    expect(isOlderVersion('1.0.0', null)).toBe(false);
  });
});

describe('collectorStateOf', () => {
  it('prefers the API state and derives one for older APIs', () => {
    expect(collectorStateOf({ state: 'rejected' }, null)).toBe('rejected');
    expect(collectorStateOf({ installed: false }, null)).toBe('not_installed');
    expect(collectorStateOf({ installed: true, stale: true }, {})).toBe('stale');
    expect(collectorStateOf({ installed: true }, { collectorOk: false })).toBe('degraded');
    expect(collectorStateOf({ installed: true }, { collectorOk: true })).toBe('reporting');
  });
});

describe('HOST_CHECK_COMMANDS', () => {
  it('never blocks on the one-shot service, and reads the report script by its tag', async () => {
    const { HOST_CHECK_COMMANDS } = await import('./collectorHealth');
    const run = HOST_CHECK_COMMANDS.find((c) => c.command.includes('systemctl start')).command;
    expect(run).toContain('--no-block');
    expect(run).toContain('journalctl -t shellius-posture');
  });
  it('reproduces the service faithfully — its user and its sandbox, never root', async () => {
    const { HOST_CHECK_COMMANDS } = await import('./collectorHealth');
    const faithful = HOST_CHECK_COMMANDS.find((c) => c.command.includes('systemd-run')).command;
    expect(faithful).toContain('User=shellius-posture');
    expect(faithful).toContain('ProtectSystem=full');
  });
});
