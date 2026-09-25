import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

/**
 * These tests cover the structural fix that lets RDP live in a workspace
 * pane: the Guacamole keyboard must be bound to THIS pane's element rather
 * than to `document`, and every key it believes is held must be released
 * before the pane gives up the keyboard — otherwise a modifier held while
 * switching panes stays down on the remote host.
 *
 * Guacamole is mocked. That is deliberate and it is also the limit of what
 * these prove: they verify the wiring (which element, which order, which
 * keysyms), not the library's own key interpretation, and they cannot prove
 * anything about what Windows does with the events.
 */

// ── Guacamole mock ────────────────────────────────────────────────────────

const G = vi.hoisted(() => {
  const created = {
    keyboards: [],
    clients: [],
    tunnels: [],
    mice: [],
  };

  class FakeKeyboard {
    constructor(element) {
      this.element = element;
      this.onkeydown = null;
      this.onkeyup = null;
      this.modifiers = { shift: false, ctrl: false, alt: false, meta: false };
      this.pressed = {};
      this.resetCalls = [];
      created.keyboards.push(this);
    }

    // Mirrors the real library: press() records the key and returns whatever
    // the handler returned; reset() fires onkeyup for everything still held.
    press(keysym) {
      this.pressed[keysym] = true;
      return this.onkeydown ? this.onkeydown(keysym) : undefined;
    }

    release(keysym) {
      if (!this.pressed[keysym]) return;
      delete this.pressed[keysym];
      if (this.onkeyup) this.onkeyup(keysym);
    }

    reset() {
      // Record whether the handlers were still attached at reset time — the
      // whole point of the reset-before-detach ordering.
      this.resetCalls.push({ hadKeyup: !!this.onkeyup, held: Object.keys(this.pressed).map(Number) });
      for (const keysym of Object.keys(this.pressed)) this.release(Number(keysym));
    }
  }

  class FakeDisplay {
    constructor() {
      this.el = document.createElement('div');
      this.scaleCalls = [];
      this.onresize = null;
    }
    getElement() {
      return this.el;
    }
    getWidth() {
      return 1280;
    }
    getHeight() {
      return 800;
    }
    scale(v) {
      this.scaleCalls.push(v);
    }
  }

  class FakeClient {
    constructor(tunnel) {
      this.tunnel = tunnel;
      this.display = new FakeDisplay();
      this.keyEvents = [];
      this.sizes = [];
      this.connectData = null;
      this.disconnected = 0;
      this.onstatechange = null;
      this.onerror = null;
      created.clients.push(this);
    }
    getDisplay() {
      return this.display;
    }
    connect(data) {
      this.connectData = data;
    }
    disconnect() {
      this.disconnected += 1;
    }
    sendKeyEvent(pressed, keysym) {
      this.keyEvents.push([pressed, keysym]);
    }
    sendMouseState() {}
    sendSize(w, h) {
      this.sizes.push([w, h]);
    }
  }

  class FakeMouse {
    constructor(element) {
      this.element = element;
      created.mice.push(this);
    }
  }

  class FakeTunnel {
    constructor(url) {
      this.url = url;
      created.tunnels.push(this);
    }
  }

  return { created, FakeKeyboard, FakeDisplay, FakeClient, FakeMouse, FakeTunnel };
});

const created = G.created;

vi.mock('guacamole-common-js', () => ({
  default: {
    WebSocketTunnel: G.FakeTunnel,
    Client: G.FakeClient,
    Mouse: G.FakeMouse,
    Keyboard: G.FakeKeyboard,
  },
}));

vi.mock('@/services/accessRequestService', () => ({
  getRdpGatewayToken: vi.fn(async () => ({ token: 'opaque-guac-token', expiresAt: 'later' })),
}));

// jsdom has no ResizeObserver.
class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {}
  disconnect() {}
}

import RdpTerminal from './RdpTerminal';
import { getRdpGatewayToken } from '@/services/accessRequestService';

const CTRL_L = 0xffe3;
const A = 0x0061;
const TAB = 0xff09;

beforeEach(() => {
  created.keyboards.length = 0;
  created.clients.length = 0;
  created.tunnels.length = 0;
  created.mice.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  getRdpGatewayToken.mockClear();
});

const surface = () => screen.getByRole('application', { name: /remote desktop/i });

async function mountPane(props = {}) {
  const view = render(<RdpTerminal requestId="ar-1" {...props} />);
  await waitFor(() => expect(created.keyboards.length).toBeGreaterThan(0));
  return view;
}

describe('RdpTerminal — keyboard scoping', () => {
  it('binds the Guacamole keyboard to the pane surface, never to `document`', async () => {
    await mountPane();
    const keyboard = created.keyboards.at(-1);
    expect(keyboard.element).toBe(surface());
    expect(keyboard.element).not.toBe(document);
    expect(keyboard.element.tabIndex).toBe(0);
  });

  it('two panes get two keyboards on two different elements', async () => {
    render(
      <>
        <RdpTerminal requestId="ar-1" />
        <RdpTerminal requestId="ar-2" />
      </>
    );
    await waitFor(() => expect(created.keyboards.length).toBe(2));
    const [a, b] = created.keyboards;
    expect(a.element).not.toBe(b.element);
    expect(a.element).not.toBe(document);
    expect(b.element).not.toBe(document);
  });

  it('only forwards keys while the pane holds focus', async () => {
    await mountPane();
    const keyboard = created.keyboards.at(-1);
    const client = created.clients.at(-1);

    // Not focused yet: no handlers, so the library would do nothing at all.
    expect(keyboard.onkeydown).toBeNull();

    act(() => surface().focus());
    expect(keyboard.onkeydown).toBeTypeOf('function');

    act(() => {
      keyboard.press(A);
    });
    expect(client.keyEvents).toContainEqual([1, A]);
  });
});

describe('RdpTerminal — stuck modifiers', () => {
  it('releases a held modifier on blur, while the key-up handler is still live', async () => {
    await mountPane();
    const keyboard = created.keyboards.at(-1);
    const client = created.clients.at(-1);

    act(() => surface().focus());
    act(() => {
      keyboard.press(CTRL_L);
    });
    expect(client.keyEvents).toEqual([[1, CTRL_L]]);

    act(() => surface().blur());

    // reset() must have run BEFORE onkeyup was nulled, or the release never
    // reaches the host — this is the stuck-Ctrl bug.
    expect(keyboard.resetCalls.at(-1)).toMatchObject({ hadKeyup: true, held: [CTRL_L] });
    expect(client.keyEvents).toContainEqual([0, CTRL_L]);
    expect(keyboard.onkeydown).toBeNull();
    expect(keyboard.onkeyup).toBeNull();
  });

  it('releases held keys when the pane is hidden by a tab switch (no blur fires)', async () => {
    const { rerender } = await mountPane({ visible: true });
    const keyboard = created.keyboards.at(-1);
    const client = created.clients.at(-1);

    act(() => surface().focus());
    act(() => {
      keyboard.press(CTRL_L);
    });
    client.keyEvents.length = 0;

    // TerminalPaneArea parks the pane in a hidden holder. Removing a focused
    // node does not emit blur in Chrome or Firefox, so the prop is the only
    // reliable signal.
    await act(async () => {
      rerender(<RdpTerminal requestId="ar-1" visible={false} />);
    });

    expect(client.keyEvents).toContainEqual([0, CTRL_L]);
    expect(keyboard.onkeydown).toBeNull();
  });

  it('releases held keys when the browser tab is backgrounded, but keeps the keyboard', async () => {
    await mountPane();
    const keyboard = created.keyboards.at(-1);
    const client = created.clients.at(-1);

    act(() => surface().focus());
    act(() => {
      keyboard.press(CTRL_L);
    });
    client.keyEvents.length = 0;

    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    spy.mockRestore();

    expect(client.keyEvents).toContainEqual([0, CTRL_L]);
    // Still focused, so typing must resume on return without a click.
    expect(keyboard.onkeydown).toBeTypeOf('function');
  });

  it('releases held keys when the window loses focus (Alt+Tab out of the browser)', async () => {
    await mountPane();
    const keyboard = created.keyboards.at(-1);
    const client = created.clients.at(-1);
    act(() => surface().focus());
    act(() => {
      keyboard.press(CTRL_L);
    });
    client.keyEvents.length = 0;

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(client.keyEvents).toContainEqual([0, CTRL_L]);
  });
});

describe('RdpTerminal — workspace chords', () => {
  it('does not send Ctrl+Tab to the remote, and sends no orphan key-up for it', async () => {
    await mountPane();
    const keyboard = created.keyboards.at(-1);
    const client = created.clients.at(-1);
    act(() => surface().focus());

    keyboard.modifiers.ctrl = true;
    let allowDefault;
    act(() => {
      allowDefault = keyboard.press(TAB);
    });
    // true = "do not preventDefault", so the Terminals page handler still runs.
    expect(allowDefault).toBe(true);
    expect(client.keyEvents).not.toContainEqual([1, TAB]);

    act(() => keyboard.release(TAB));
    expect(client.keyEvents).not.toContainEqual([0, TAB]);
  });

  it('sends a plain Tab to the remote and swallows the browser default', async () => {
    await mountPane();
    const keyboard = created.keyboards.at(-1);
    const client = created.clients.at(-1);
    act(() => surface().focus());

    let allowDefault;
    act(() => {
      allowDefault = keyboard.press(TAB);
    });
    expect(allowDefault).toBe(false); // preventDefault, or focus leaves the pane
    expect(client.keyEvents).toContainEqual([1, TAB]);
  });
});

describe('RdpTerminal — connection lifecycle', () => {
  it('opens exactly one tunnel and never puts the token in the URL', async () => {
    await mountPane();
    expect(created.tunnels.length).toBe(1);
    expect(created.tunnels[0].url).toMatch(/\/api\/terminal\/rdp$/);
    expect(created.tunnels[0].url).not.toMatch(/token/);
    expect(created.clients[0].connectData).toContain('token=opaque-guac-token');
  });

  it('does not connect at all when a restored tab opens un-started', async () => {
    render(<RdpTerminal requestId="ar-1" autoConnect={false} />);
    await screen.findByText(/not connected/i);
    expect(getRdpGatewayToken).not.toHaveBeenCalled();
    expect(created.clients.length).toBe(0);
  });

  it('disconnects the client when the pane unmounts', async () => {
    const { unmount } = await mountPane();
    const client = created.clients.at(-1);
    act(() => unmount());
    expect(client.disconnected).toBeGreaterThan(0);
  });

  it('surfaces a failed token mint without opening a tunnel', async () => {
    getRdpGatewayToken.mockRejectedValueOnce({
      response: { data: { error: { message: 'Access request has expired' } } },
    });
    render(<RdpTerminal requestId="ar-1" />);
    await screen.findByText(/access request has expired/i);
    expect(created.tunnels.length).toBe(0);
  });
});
