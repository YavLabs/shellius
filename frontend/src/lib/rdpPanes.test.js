import { describe, it, expect } from 'vitest';
import {
  RDP,
  isRdpTab,
  findRdpConflict,
  tabCapabilities,
  isWorkspaceShortcut,
  guacStatus,
  tabStateForStatus,
  guacErrorText,
  isEvictionError,
  nextDisplaySize,
  fitScale,
  GUAC_STATE,
  CTRL_ALT_DEL_KEYSYMS,
} from './rdpPanes';

const rdpTab = (over = {}) => ({
  id: 't1',
  protocol: RDP,
  state: 'live',
  serverId: 'srv-1',
  username: 'Administrator',
  ...over,
});

describe('isRdpTab', () => {
  it('is true only for tabs tagged RDP', () => {
    expect(isRdpTab(rdpTab())).toBe(true);
    expect(isRdpTab({ protocol: 'SSH' })).toBe(false);
    expect(isRdpTab({})).toBe(false);
    expect(isRdpTab(null)).toBe(false);
  });
});

describe('findRdpConflict — Windows allows one interactive session per user', () => {
  it('finds a live pane on the same server and account', () => {
    const tabs = [rdpTab()];
    expect(findRdpConflict(tabs, { serverId: 'srv-1', username: 'Administrator' })?.id).toBe('t1');
  });

  it('matches case-insensitively (Windows accounts are case-insensitive)', () => {
    const tabs = [rdpTab({ username: 'ADMINISTRATOR' })];
    expect(findRdpConflict(tabs, { serverId: 'srv-1', username: 'administrator' })?.id).toBe('t1');
  });

  it('allows two panes on the same server as two known, different accounts', () => {
    const tabs = [rdpTab({ username: 'alice' })];
    expect(findRdpConflict(tabs, { serverId: 'srv-1', username: 'bob' })).toBeNull();
  });

  it('treats an unknown account on either side as a possible collision', () => {
    expect(findRdpConflict([rdpTab({ username: undefined })], { serverId: 'srv-1', username: 'bob' })?.id).toBe('t1');
    expect(findRdpConflict([rdpTab({ username: 'alice' })], { serverId: 'srv-1' })?.id).toBe('t1');
    expect(findRdpConflict([rdpTab({ username: '  ' })], { serverId: 'srv-1' })?.id).toBe('t1');
  });

  it('ignores other servers, SSH tabs and finished panes', () => {
    expect(findRdpConflict([rdpTab({ serverId: 'srv-2' })], { serverId: 'srv-1' })).toBeNull();
    expect(findRdpConflict([{ ...rdpTab(), protocol: 'SSH' }], { serverId: 'srv-1' })).toBeNull();
    for (const state of ['ended', 'error', 'lost']) {
      expect(findRdpConflict([rdpTab({ state })], { serverId: 'srv-1' })).toBeNull();
    }
  });

  it('counts a pane that is still connecting or reconnecting', () => {
    for (const state of ['connecting', 'reconnecting']) {
      expect(findRdpConflict([rdpTab({ state })], { serverId: 'srv-1' })?.id).toBe('t1');
    }
  });

  it('can exclude the tab being reconnected in place', () => {
    const tabs = [rdpTab()];
    expect(findRdpConflict(tabs, { serverId: 'srv-1' }, { excludeTabId: 't1' })).toBeNull();
  });

  it('returns null without a serverId (an unsaved host has no server identity)', () => {
    expect(findRdpConflict([rdpTab()], { username: 'Administrator' })).toBeNull();
    expect(findRdpConflict([rdpTab()], null)).toBeNull();
  });

  it('tolerates an empty or missing tab list', () => {
    expect(findRdpConflict([], { serverId: 'srv-1' })).toBeNull();
    expect(findRdpConflict(undefined, { serverId: 'srv-1' })).toBeNull();
  });
});

describe('tabCapabilities', () => {
  it('refuses duplicate and end-session for RDP', () => {
    const caps = tabCapabilities(rdpTab());
    expect(caps.canDuplicate).toBe(false);
    expect(caps.canEndSession).toBe(false);
    expect(caps.canAttach).toBe(false);
    expect(caps.endsOnClose).toBe(true);
    expect(caps.canSplit).toBe(true);
  });

  it('keeps SSH capabilities tied to a live hub session', () => {
    expect(tabCapabilities({ sessionId: 's1' }).canDuplicate).toBe(true);
    expect(tabCapabilities({ sessionId: null }).canDuplicate).toBe(false);
    expect(tabCapabilities({ sessionId: 's1' }).endsOnClose).toBe(false);
  });
});

describe('isWorkspaceShortcut', () => {
  const T = 0x54;
  const t = 0x74;
  const W = 0x57;
  const TAB = 0xff09;
  const LEFT = 0xff51;
  const RIGHT = 0xff53;

  it('reserves the Terminals page chords', () => {
    expect(isWorkspaceShortcut(T, { ctrl: true, shift: true })).toBe(true);
    expect(isWorkspaceShortcut(t, { meta: true, shift: true })).toBe(true);
    expect(isWorkspaceShortcut(W, { ctrl: true, shift: true })).toBe(true);
    expect(isWorkspaceShortcut(TAB, { ctrl: true })).toBe(true);
    expect(isWorkspaceShortcut(TAB, { ctrl: true, shift: true })).toBe(true);
    expect(isWorkspaceShortcut(0x31, { alt: true })).toBe(true);
    expect(isWorkspaceShortcut(0x39, { alt: true })).toBe(true);
    expect(isWorkspaceShortcut(LEFT, { alt: true, shift: true })).toBe(true);
    expect(isWorkspaceShortcut(RIGHT, { alt: true, shift: true })).toBe(true);
  });

  it('passes everything else to the remote host', () => {
    // Plain typing.
    expect(isWorkspaceShortcut(t, {})).toBe(false);
    // Ctrl+T without shift belongs to the remote (and to the browser).
    expect(isWorkspaceShortcut(t, { ctrl: true })).toBe(false);
    // Tab on its own must reach the remote desktop.
    expect(isWorkspaceShortcut(TAB, {})).toBe(false);
    // Alt+Tab never reaches the page at all, but assert the intent.
    expect(isWorkspaceShortcut(TAB, { alt: true })).toBe(false);
    // Arrows, with and without shift.
    expect(isWorkspaceShortcut(LEFT, {})).toBe(false);
    expect(isWorkspaceShortcut(LEFT, { shift: true })).toBe(false);
    expect(isWorkspaceShortcut(LEFT, { alt: true })).toBe(false);
    // Ctrl+Alt+Del parts individually.
    for (const ks of CTRL_ALT_DEL_KEYSYMS) expect(isWorkspaceShortcut(ks, { ctrl: true, alt: true })).toBe(false);
    // Digits without Alt (Ctrl+1 switches tabs in the *remote* browser).
    expect(isWorkspaceShortcut(0x31, { ctrl: true })).toBe(false);
  });

  it('defaults the modifier state when none is given', () => {
    expect(isWorkspaceShortcut(TAB)).toBe(false);
  });
});

describe('guacStatus / tabStateForStatus', () => {
  it('maps Guacamole client state codes', () => {
    expect(guacStatus(GUAC_STATE.CONNECTED)).toBe('connected');
    expect(guacStatus(GUAC_STATE.DISCONNECTING)).toBe('disconnected');
    expect(guacStatus(GUAC_STATE.DISCONNECTED)).toBe('disconnected');
    expect(guacStatus(GUAC_STATE.IDLE)).toBe('connecting');
    expect(guacStatus(GUAC_STATE.CONNECTING)).toBe('connecting');
    expect(guacStatus(GUAC_STATE.WAITING)).toBe('connecting');
    expect(guacStatus(99)).toBe('connecting');
  });

  it('maps a pane status onto a tab-bar state', () => {
    expect(tabStateForStatus('connected')).toBe('live');
    expect(tabStateForStatus('disconnected')).toBe('ended');
    expect(tabStateForStatus('connecting')).toBe('connecting');
  });
});

describe('guacErrorText', () => {
  it('names the duplicate-login eviction specifically', () => {
    expect(guacErrorText({ code: 0x0209 })).toMatch(/same Windows account/i);
    expect(isEvictionError({ code: 0x0209 })).toBe(true);
    expect(isEvictionError({ code: 0x0301 })).toBe(false);
    expect(isEvictionError(null)).toBe(false);
  });

  it('maps the codes a revoked or expired request produces', () => {
    expect(guacErrorText({ code: 0x0301 })).toMatch(/access may have expired/i);
    expect(guacErrorText({ code: 0x0303 })).toMatch(/not allowed/i);
  });

  it('falls back to guacd text, then to a generic line', () => {
    expect(guacErrorText({ code: 0x9999, message: 'weird' })).toBe('weird');
    expect(guacErrorText({ code: 0x9999, message: '   ' })).toMatch(/connection ended/i);
    expect(guacErrorText({})).toMatch(/connection ended/i);
    expect(guacErrorText(null)).toMatch(/connection ended/i);
  });
});

describe('nextDisplaySize', () => {
  it('sends the first real size', () => {
    expect(nextDisplaySize(null, { width: 1280, height: 800 })).toEqual({ width: 1280, height: 800 });
  });

  it('ignores a hidden pane measuring zero', () => {
    expect(nextDisplaySize({ width: 1280, height: 800 }, { width: 0, height: 0 })).toBeNull();
  });

  it('ignores sub-threshold jitter but takes a real resize', () => {
    expect(nextDisplaySize({ width: 1280, height: 800 }, { width: 1283, height: 802 })).toBeNull();
    expect(nextDisplaySize({ width: 1280, height: 800 }, { width: 1300, height: 800 })).toEqual({
      width: 1300,
      height: 800,
    });
  });

  it('refuses absurd geometries rather than sending them to guacd', () => {
    expect(nextDisplaySize(null, { width: 10, height: 10 })).toBeNull();
    expect(nextDisplaySize(null, { width: 99999, height: 800 })).toBeNull();
    expect(nextDisplaySize(null, { width: NaN, height: 800 })).toBeNull();
    expect(nextDisplaySize(null, {})).toBeNull();
  });

  it('rounds fractional CSS pixel sizes', () => {
    expect(nextDisplaySize(null, { width: 1279.6, height: 799.4 })).toEqual({ width: 1280, height: 799 });
  });
});

describe('fitScale', () => {
  it('fits the smaller ratio', () => {
    expect(fitScale({ width: 1000, height: 1000 }, { width: 500, height: 250 })).toBe(0.25);
  });

  it('returns null before the first remote frame (no divide by zero)', () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 500, height: 500 })).toBeNull();
    expect(fitScale({ width: 1000, height: 1000 }, { width: 0, height: 0 })).toBeNull();
    expect(fitScale(null, null)).toBeNull();
  });
});
