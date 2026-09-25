import { useCallback, useEffect, useRef, useState } from 'react';
import Guacamole from 'guacamole-common-js';
import { Circle, Keyboard as KeyboardIcon, Loader, MousePointerClick, RefreshCw, X } from 'lucide-react';
import { getRdpGatewayToken } from '@/services/accessRequestService';
import {
  CTRL_ALT_DEL_KEYSYMS,
  fitScale,
  guacErrorText,
  guacStatus,
  isEvictionError,
  isWorkspaceShortcut,
  nextDisplaySize,
  tabStateForStatus,
} from '@/lib/rdpPanes';
import { cn } from '@/lib/utils';

const RESIZE_DEBOUNCE_MS = 300;

function StatusIndicator({ status }) {
  if (status === 'connecting') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-amber-500 dark:text-amber-400">
        <Loader className="h-3 w-3 animate-spin" />
        Connecting
      </span>
    );
  }
  if (status === 'connected') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-emerald-500 dark:text-emerald-400">
        <Circle className="h-2.5 w-2.5 fill-current" />
        Connected
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
      <Circle className="h-2.5 w-2.5 fill-current" />
      Disconnected
    </span>
  );
}

/**
 * RdpTerminal — one Guacamole RDP session, safe to mount more than once on a
 * page (the terminal workspace renders one per pane).
 *
 * ## Keyboard scoping — the reason this component is not a thin wrapper
 *
 * `Guacamole.Keyboard` used to be constructed here as
 * `new Guacamole.Keyboard(document)`. That binds capture-phase key listeners
 * to the whole document, so in a split view every mounted RDP pane received
 * every keystroke and all of them forwarded it to their own host. It also
 * meant an RDP pane stole keys from a neighbouring xterm pane.
 *
 * The keyboard is now bound to this pane's own container, which carries
 * `tabIndex={0}` so it can actually hold focus (a div cannot receive key
 * events otherwise) and shows a focus ring so it is obvious which pane the
 * keyboard is talking to. Key events only reach an element that is on the
 * focus path, so exactly one pane can ever receive them.
 *
 * `Guacamole.Keyboard` has no teardown API — `listenTo()` adds anonymous
 * capture listeners and nothing removes them — so "uninstall" is done by
 * nulling `onkeydown` / `onkeyup`, which the library checks on every event
 * before doing anything (including before calling preventDefault). The
 * keyboard object itself dies with the element.
 *
 * ## Stuck modifiers
 *
 * Losing focus with Ctrl or Alt held leaves that modifier *down on the remote
 * host* — every subsequent click becomes a Ctrl-click, and the user cannot
 * fix it from inside Shellius. `keyboard.reset()` fires `onkeyup` for every
 * key it believes is pressed, so releasing before detaching sends the matching
 * key-up events. Order matters: reset FIRST, then null the handlers, or the
 * key-ups go nowhere.
 *
 * Four separate things can strand a modifier, and all four are handled:
 *   - blur (clicking another pane)                → onBlur
 *   - the pane being hidden by a tab/layout switch, which does NOT reliably
 *     fire blur, because removing a focused node from the document silently
 *     moves activeElement to <body> in Chrome and Firefox
 *                                                  → the `visible` prop effect
 *   - the browser tab being backgrounded           → visibilitychange
 *   - Alt+Tab out of the browser                   → window blur
 *
 * ## Connection generation guard (`runIdRef`)
 *
 * `connect` is async — it awaits a gateway token before it has a client to
 * tear down — so `cleanup` alone cannot stop an attempt that is mid-flight.
 * Without this counter, React 18 StrictMode's double mount in development
 * produced TWO tunnels: the first attempt resumed after cleanup had already
 * run and opened its connection anyway, alongside the second. Both logged
 * into Windows as the same user, Windows allows one interactive session per
 * user, and the second kicked the first — the user saw "Disconnected by other
 * connection" on a session that had just connected. It is not only a
 * StrictMode artifact: double-clicking Reconnect, or any re-render that
 * changes requestId mid-connect, races the same way in production.
 *
 * ## Clipboard — deliberately not wired
 *
 * `Guacamole.Client` can bridge the clipboard both ways (`onclipboard`,
 * `createClipboardStream`). It is not wired here and that is a decision, not
 * an omission: remote → browser clipboard is an unaudited egress path out of
 * a recorded session, and browser → remote needs a clipboard-read permission
 * prompt. Both belong behind an org policy switch and an audit action, which
 * do not exist. See the report accompanying this change.
 *
 * @param {object} props
 * @param {string} props.requestId       approved RDP access request
 * @param {boolean} [props.visible]      false when parked in a hidden pane
 * @param {boolean} [props.embedded]     true inside a workspace pane (no outer chrome)
 * @param {boolean} [props.autoConnect]  false to open in a "not connected" state
 * @param {Function} [props.onClose]
 * @param {Function} [props.onStateChange] (state, detail) — 'connecting'|'live'|'ended'|'error'
 */
function RdpTerminal({
  requestId,
  visible = true,
  embedded = false,
  autoConnect = true,
  onClose,
  onStateChange,
}) {
  // The focusable pane surface that owns the keyboard.
  const surfaceRef = useRef(null);
  // A plain div React never renders into; the Guacamole display is appended here.
  const displayHostRef = useRef(null);

  const clientRef = useRef(null);
  const displayRef = useRef(null);
  const mouseRef = useRef(null);
  const keyboardRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const resizeTimerRef = useRef(null);
  const sentSizeRef = useRef(null);
  // Keysyms whose key-down we actually forwarded. Workspace chords are
  // swallowed, so their key-up must be swallowed too rather than sent as an
  // orphan release.
  const sentKeysRef = useRef(new Set());
  const runIdRef = useRef(0);

  const [status, setStatus] = useState(autoConnect ? 'connecting' : 'disconnected');
  // { text, evicted } — `evicted` is the Windows duplicate-login case, which
  // gets an extra line of explanation because it is the one disconnect users
  // cannot work out for themselves.
  const [error, setError] = useState(null);
  const [focused, setFocused] = useState(false);
  const [started, setStarted] = useState(autoConnect);

  // ── keyboard install / uninstall ────────────────────────────────────────

  /** Release every key the remote believes is held. Safe to call any time. */
  const releaseHeldKeys = useCallback(() => {
    const keyboard = keyboardRef.current;
    if (!keyboard) return;
    try {
      // Fires onkeyup for each pressed key, which is what actually sends the
      // release to the host. Never call this after detaching the handlers.
      keyboard.reset();
    } catch {
      /* keyboard already torn down */
    }
    // Belt and braces: anything still marked as sent gets an explicit release,
    // in case Guacamole's own bookkeeping and ours disagree.
    const client = clientRef.current;
    if (client && sentKeysRef.current.size) {
      for (const keysym of sentKeysRef.current) {
        try {
          client.sendKeyEvent(0, keysym);
        } catch {
          /* tunnel gone */
        }
      }
    }
    sentKeysRef.current.clear();
  }, []);

  const attachKeyboard = useCallback(() => {
    const keyboard = keyboardRef.current;
    if (!keyboard) return;
    // The client is resolved per event, not captured here: the keyboard
    // outlives any single connection (see the mount effect below), so a
    // Reconnect must not leave the handlers wired to a dead client.
    keyboard.onkeydown = (keysym) => {
      const client = clientRef.current;
      if (!client) return true;
      // Chords the Terminals page owns (Ctrl+Tab, Alt+N, Ctrl+Shift+T/W,
      // Alt+Shift+arrows) must not reach Windows. Returning true tells
      // Guacamole NOT to preventDefault, so the page's own window-level
      // handler deals with it as usual.
      if (isWorkspaceShortcut(keysym, keyboard.modifiers)) return true;
      sentKeysRef.current.add(keysym);
      client.sendKeyEvent(1, keysym);
      return false; // swallow the browser default (Tab, F5, F11, …)
    };
    keyboard.onkeyup = (keysym) => {
      const client = clientRef.current;
      if (!sentKeysRef.current.delete(keysym)) return true;
      if (client) client.sendKeyEvent(0, keysym);
      return false;
    };
  }, []);

  const detachKeyboard = useCallback(() => {
    releaseHeldKeys(); // must happen while the handlers are still live
    const keyboard = keyboardRef.current;
    if (keyboard) {
      keyboard.onkeydown = null;
      keyboard.onkeyup = null;
    }
  }, [releaseHeldKeys]);

  // ── teardown ────────────────────────────────────────────────────────────

  const cleanup = useCallback(() => {
    // Anything still awaiting a token is now stale and must not connect.
    runIdRef.current += 1;
    // Release and unwire, but keep the Keyboard object: Guacamole's
    // listenTo() has no counterpart, so constructing one per connection would
    // pile up dead capture listeners on the surface with every Reconnect.
    detachKeyboard();
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
    if (mouseRef.current) {
      mouseRef.current.onmousedown = null;
      mouseRef.current.onmouseup = null;
      mouseRef.current.onmousemove = null;
      mouseRef.current.onmouseout = null;
      mouseRef.current.onmousewheel = null;
      mouseRef.current = null;
    }
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
    if (clientRef.current) {
      try {
        clientRef.current.disconnect();
      } catch {
        // already disconnected
      }
      clientRef.current = null;
    }
    displayRef.current = null;
    sentSizeRef.current = null;
    if (displayHostRef.current) displayHostRef.current.innerHTML = '';
  }, [detachKeyboard]);

  // ── sizing ──────────────────────────────────────────────────────────────

  const paneSize = () => {
    const el = displayHostRef.current;
    if (!el) return { width: 0, height: 0 };
    return { width: el.clientWidth, height: el.clientHeight };
  };

  const rescale = useCallback(() => {
    const display = displayRef.current;
    if (!display) return;
    const scale = fitScale({ width: display.getWidth(), height: display.getHeight() }, paneSize());
    if (scale !== null) display.scale(scale);
  }, []);

  /**
   * Ask guacd for a remote desktop the size of this pane. The connection is
   * built with `resize-method: display-update` (backend rdpService), so the
   * remote session really does reflow rather than being letterboxed.
   * Debounced: a divider drag fires ResizeObserver dozens of times a second
   * and each size instruction makes Windows re-lay-out the desktop.
   */
  const scheduleRemoteResize = useCallback(() => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      const client = clientRef.current;
      if (!client) return;
      const size = nextDisplaySize(sentSizeRef.current, paneSize());
      if (!size) return;
      try {
        client.sendSize(size.width, size.height);
        sentSizeRef.current = size;
      } catch {
        /* tunnel closed between the timer and now */
      }
    }, RESIZE_DEBOUNCE_MS);
  }, []);

  // ── connect ─────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    if (!requestId || !displayHostRef.current) return;

    cleanup();
    // Claim this attempt. Any later cleanup bumps the counter and everything
    // below bails out rather than opening a second tunnel.
    const runId = runIdRef.current;
    const superseded = () => runId !== runIdRef.current;

    setStatus('connecting');
    setError(null);

    let tokenData;
    try {
      const resp = await getRdpGatewayToken(requestId);
      tokenData = resp.data || resp;
    } catch (err) {
      if (superseded()) return;
      setError({
        text:
          err.response?.data?.error?.message ||
          err.message ||
          'Failed to obtain an RDP gateway token.',
        evicted: false,
      });
      setStatus('disconnected');
      return;
    }

    // The await above is exactly where a second mount overtakes the first.
    if (superseded() || !displayHostRef.current) return;

    const jwt = tokenData.token;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // NOTE: do NOT put query params on the tunnel URL — Guacamole's
    // WebSocketTunnel builds the socket URL as `tunnelURL + "?" + connectData`,
    // so any existing "?token=" would collide and corrupt the token. The token
    // is passed via the connect() data string below instead.
    const wsUrl = `${wsProtocol}//${window.location.host}/api/terminal/rdp`;

    const tunnel = new Guacamole.WebSocketTunnel(wsUrl);
    const client = new Guacamole.Client(tunnel);
    clientRef.current = client;

    client.onstatechange = (state) => {
      if (superseded()) return;
      setStatus(guacStatus(state));
    };

    client.onerror = (guacError) => {
      if (superseded()) return;
      setStatus('disconnected');
      setError({ text: guacErrorText(guacError), evicted: isEvictionError(guacError) });
    };

    const display = client.getDisplay();
    displayRef.current = display;
    const displayEl = display.getElement();
    displayHostRef.current.appendChild(displayEl);

    // Recompute scale as soon as the remote desktop dimensions are known
    // (first frame) and whenever they change.
    display.onresize = rescale;

    // Open at the pane's real size so the first frame already fits; fall back
    // to a sane default for a pane that has not been laid out yet.
    const { width, height } = paneSize();
    const initial = nextDisplaySize(null, { width, height }) || { width: 1280, height: 800 };
    sentSizeRef.current = initial;

    client.connect(
      `token=${encodeURIComponent(jwt)}&width=${initial.width}&height=${initial.height}&dpi=96`
    );

    // Last check. If this attempt was superseded while connecting, hang up
    // now — leaving it open is what kicks the surviving session off Windows.
    if (superseded()) {
      try {
        client.disconnect();
      } catch {
        // already gone
      }
      if (clientRef.current === client) clientRef.current = null;
      return;
    }

    // Mouse is bound to the display element and is already per-pane.
    const mouse = new Guacamole.Mouse(displayEl);
    mouseRef.current = mouse;
    const sendMouse = (mouseState) => {
      try {
        client.sendMouseState(mouseState);
      } catch {
        /* tunnel closed */
      }
    };
    mouse.onmousedown = sendMouse;
    mouse.onmouseup = sendMouse;
    mouse.onmousemove = sendMouse;
    mouse.onmouseout = sendMouse;
    mouse.onmousewheel = sendMouse;

    // Re-wire the (pane-scoped, mount-lifetime) keyboard onto this client,
    // but only if the pane already holds focus; otherwise onFocus does it.
    sentKeysRef.current.clear();
    if (visible && surfaceRef.current && document.activeElement === surfaceRef.current) {
      attachKeyboard();
    }

    const resizeObserver = new ResizeObserver(() => {
      rescale();
      scheduleRemoteResize();
    });
    resizeObserverRef.current = resizeObserver;
    if (displayHostRef.current) resizeObserver.observe(displayHostRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, cleanup, rescale, scheduleRemoteResize, attachKeyboard]);

  // THE fix: one Guacamole keyboard per pane, bound to this pane's own
  // focusable surface rather than to `document`. Created on mount and kept
  // for the pane's whole life, because the library offers no way to remove
  // the capture listeners it installs.
  useEffect(() => {
    if (!surfaceRef.current) return undefined;
    keyboardRef.current = new Guacamole.Keyboard(surfaceRef.current);
    const keyboard = keyboardRef.current;
    return () => {
      keyboard.onkeydown = null;
      keyboard.onkeyup = null;
      if (keyboardRef.current === keyboard) keyboardRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!started) return undefined;
    connect();
    return () => {
      cleanup();
    };
  }, [connect, cleanup, started]);

  // ── focus, visibility and the stuck-modifier defences ───────────────────

  // A pane parked in TerminalPaneArea's hidden holder must not hold the
  // keyboard. `visible` is a React prop, so unlike DOM blur it is guaranteed
  // to fire — removing a focused node from the document does not emit blur in
  // Chrome or Firefox.
  useEffect(() => {
    if (visible) return;
    detachKeyboard();
    setFocused(false);
    if (surfaceRef.current && document.activeElement === surfaceRef.current) {
      surfaceRef.current.blur();
    }
  }, [visible, detachKeyboard]);

  // Backgrounded browser tab / Alt+Tab out of the browser. The element keeps
  // DOM focus in both cases, so we release the held keys but leave the
  // handlers attached — typing resumes on return without needing a click.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') releaseHeldKeys();
    };
    const onWindowBlur = () => releaseHeldKeys();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [releaseHeldKeys]);

  // Report state upward for the tab bar's status dot.
  useEffect(() => {
    if (!onStateChange) return;
    if (!started) {
      onStateChange('ended', 'reload');
      return;
    }
    onStateChange(tabStateForStatus(status), status === 'disconnected' ? 'closed' : undefined);
    // `error` is intentionally not a dependency: onStateChange only carries
    // the coarse state, and re-firing on every error text change is noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, started]);

  const handleFocus = () => {
    setFocused(true);
    attachKeyboard();
  };

  const handleBlur = () => {
    setFocused(false);
    detachKeyboard();
  };

  const handleReconnect = () => {
    if (!started) {
      setStarted(true);
      return;
    }
    connect();
  };

  const sendCtrlAltDel = () => {
    const client = clientRef.current;
    if (!client || status !== 'connected') return;
    try {
      for (const keysym of CTRL_ALT_DEL_KEYSYMS) client.sendKeyEvent(1, keysym);
      for (const keysym of [...CTRL_ALT_DEL_KEYSYMS].reverse()) client.sendKeyEvent(0, keysym);
    } catch {
      /* tunnel closed */
    }
    surfaceRef.current?.focus();
  };

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden bg-ink',
        !embedded && 'rounded-lg border border-border'
      )}
    >
      {/* Status bar */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-ink-raised px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <StatusIndicator status={status} />
          {status === 'connected' && !focused && (
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
              <MousePointerClick className="h-3 w-3" />
              Click to use the keyboard
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {status === 'connected' && (
            <button
              type="button"
              onClick={sendCtrlAltDel}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              title="Send Ctrl+Alt+Delete to the remote desktop (the real key combination is taken by your own OS)"
            >
              <KeyboardIcon className="h-3 w-3" />
              Ctrl+Alt+Del
            </button>
          )}
          {status === 'disconnected' && (
            <button
              type="button"
              onClick={handleReconnect}
              className="flex items-center gap-1.5 rounded-md bg-accent/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            >
              <RefreshCw className="h-3 w-3" />
              {started ? 'Reconnect' : 'Connect'}
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              title="Close session"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-red-500/20 bg-red-500/10 px-3 py-1.5">
          <p className="flex-1 text-xs text-red-400">
            {error.text}
            {error.evicted && ' Only one person can be signed in to this Windows account at a time.'}
          </p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded p-0.5 text-red-400 transition-colors hover:text-red-300"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* The focusable surface. tabIndex makes a div able to hold focus at
          all, which is what scopes the Guacamole keyboard to this pane. */}
      <div
        ref={surfaceRef}
        tabIndex={0}
        role="application"
        aria-label="Remote desktop"
        onFocus={handleFocus}
        onBlur={handleBlur}
        onMouseDown={() => surfaceRef.current?.focus()}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden outline-none ring-inset',
          focused ? 'cursor-none ring-2 ring-primary/70' : 'ring-1 ring-transparent'
        )}
      >
        <div ref={displayHostRef} className="h-full w-full bg-[#09090C]" />

        {!started && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink/90 text-center">
            <p className="text-sm text-foreground">This remote desktop is not connected.</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              An RDP session cannot be re-attached after a reload the way an SSH session can, so it
              is left to you to start it again.
            </p>
            <button
              type="button"
              onClick={handleReconnect}
              className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Connect
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default RdpTerminal;
