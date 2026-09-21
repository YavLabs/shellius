import { describe, it, expect } from 'vitest';
import { groupListeners, bindNote } from './listenerGroups';

const row = (over) => ({ id: Math.random().toString(36).slice(2), proto: 'tcp', port: 22, ownerKind: 'systemd', ownerName: 'ssh.service', pid: 800, reachability: 'INTERNET', bind: '0.0.0.0', ...over });

describe('groupListeners', () => {
  // What looked like "duplicates after a reinstall" in the ports table.
  it('shows a dual-stack socket as one row with both binds, IPv4 first', () => {
    const out = groupListeners([row({ bind: '::' }), row({ bind: '0.0.0.0' })]);
    expect(out).toHaveLength(1);
    expect(out[0].binds).toEqual(['0.0.0.0', '::']);
    expect(out[0].bind).toBe('0.0.0.0, ::');
    expect(out[0].ids).toHaveLength(2);
  });

  it('keeps the worst reachability of the group', () => {
    const out = groupListeners([row({ bind: '127.0.0.1', reachability: 'LOOPBACK' }), row({ bind: '0.0.0.0', reachability: 'INTERNET' })]);
    expect(out[0].reachability).toBe('INTERNET');
  });

  it('never merges different owners, protocols or ports', () => {
    const out = groupListeners([
      row({}),
      row({ proto: 'udp' }),
      row({ port: 2222 }),
      row({ ownerName: 'other.service', pid: 900 }),
    ]);
    expect(out).toHaveLength(4);
  });
});

describe('bindNote', () => {
  it('describes the common shapes', () => {
    expect(bindNote(['0.0.0.0', '::'])).toBe('all interfaces, IPv4 + IPv6');
    expect(bindNote(['127.0.0.53', '127.0.0.54'])).toBe('loopback only');
    expect(bindNote(['10.0.0.5'])).toBeNull();
  });
});
