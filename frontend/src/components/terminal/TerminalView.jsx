import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Loader2, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { requestWsTicket } from '@/services/terminalService';
import '@xterm/xterm/css/xterm.css';

// Global shortcuts the terminal workspace needs even while a pane has
// keyboard focus — xterm otherwise swallows every keystroke. Returning
// `false` from attachCustomKeyEventHandler tells xterm to ignore the event
// entirely (no preventDefault, no terminal handling) so it bubbles up to the
// document-level listener in pages/Terminals.jsx.
function isWorkspaceShortcut(e) {
  if (e.type !== 'keydown') return true;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && (e.key.toLowerCase() === 't' || e.key.toLowerCase() === 'w')) return false;
  if (mod && e.key === 'Tab') return false;
  if (e.altKey && /^[1-9]$/.test(e.key)) return false;
  return true;
}

const XTERM_THEME = {
  // Brand palette (brand/README.txt): Ink canvas, Light text, Sky cursor,
  // Sky / Lavender for blue / magenta, the status tones for red / green.
  background: '#09090C',
  foreground: '#EDEEF2',
  cursor: '#8FB6F5',
  cursorAccent: '#09090C',
  selectionBackground: '#8FB6F540',
  black: '#1A1D27',
  red: '#F4776C',
  green: '#6EE7A8',
  yellow: '#F2D48A',
  blue: '#8FB6F5',
  magenta: '#B9A6F2',
  cyan: '#7FD8E8',
  white: '#C9CBD3',
  brightBlack: '#5A5E6B',
  brightRed: '#FF928A',
  brightGreen: '#94F0C0',
  brightYellow: '#F7E2A6',
  brightBlue: '#B3CEFA',
  brightMagenta: '#D0C3F7',
  brightCyan: '#A6E8F2',
  brightWhite: '#FFFFFF',
};

/**
 * TerminalView — reusable SSH terminal pane driven by a `connect` spec:
 *   { ticket }                 — Quick Connect (single-use ticket)
 *   { requestId, principal? }  — access-request session
 *   { attach: sessionId }      — attach to a live hub session
 *
 * Reports lifecycle via onSession({sessionId,...}) and onStateChange(state,
 * extra) where state is:
 *   'connecting'   opening the socket / SSH handshake
 *   'live'         shell is up
 *   'reconnecting' socket dropped; re-attaching automatically with backoff
 *   'lost'         the session no longer exists (backend restart, detach
 *                  timeout…); extra = 'not_found' | 'forbidden'
 *   'ended'        the hub ended it; extra = reason (exit, expired, …)
 *   'error'        couldn't connect (no session was ever established)
 * `statusOverlay={false}` hides the built-in ended/lost overlay (the
 * workspace shows a recovery card instead). Unmount
 * only closes the socket (server-side: detach). Callers that want an
 * explicit end must call the imperative `close()` handle (sends
 * `{type:'close'}`), which is distinct from unmounting.
 *
 * `visible` (default true) — when false the pane is hidden (parent applies
 * the `hidden` class) but the terminal + socket stay mounted; flip back to
 * true triggers a re-fit. `active` gates whether this instance should be
 * eligible for the custom-key passthrough (only the focused pane's document
 * listener matters, but xterm needs the handler regardless of focus so
 * pressing e.g. ctrl+tab from any pane works).
 */
const TerminalView = forwardRef(function TerminalView(
  { connect, visible = true, onSession, onStateChange, onHostKey, statusOverlay = true, className = '' },
  ref
) {
  const { refresh } = useAuth();
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const connectKeyRef = useRef(null);
  const liveSessionRef = useRef(null); // sessionId this view is currently attached to

  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState('');
  const [endedReason, setEndedReason] = useState('');
  const statusRef = useRef('connecting');

  const emitState = useCallback(
    (s, extra) => {
      statusRef.current = s;
      setStatus(s);
      onStateChange?.(s, extra);
    },
    [onStateChange]
  );

  // Only send real size changes. Each resize is a SIGWINCH on the remote
  // shell, and readline redraws its prompt on every one.
  const lastSizeRef = useRef(null);
  const sendResize = useCallback((cols, rows) => {
    if (!cols || !rows) return;
    const last = lastSizeRef.current;
    if (last && last.cols === cols && last.rows === rows) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
      lastSizeRef.current = { cols, rows };
    }
  }, []);

  useImperativeHandle(ref, () => ({
    close: () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'close' }));
      }
    },
    focus: () => termRef.current?.focus(),
    fit: () => {
      try {
        fitAddonRef.current?.fit();
        if (termRef.current) sendResize(termRef.current.cols, termRef.current.rows);
      } catch {
        /* container may be zero-sized (hidden pane) — ignore */
      }
    },
  }));

  // Re-fit whenever the pane becomes visible again (tab switch / layout
  // change) — hidden panes have zero size so fit() during that window would
  // collapse the terminal to 0 cols/rows.
  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          if (termRef.current) sendResize(termRef.current.cols, termRef.current.rows);
          termRef.current?.focus();
        } catch {
          /* ignore */
        }
      }, 30);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [visible, sendResize]);

  // Once this view is live on a session, the workspace switches the tab's
  // connect spec to {attach: <that session>} (so a remount — e.g. navigating
  // away and back — re-attaches instead of reusing a spent ticket or opening a
  // brand-new session). That spec change must NOT reconnect the live view, so
  // "attach to the session I'm already on" keeps the previous key. A spec
  // carrying `retry` (an explicit Reconnect/Retry from the workspace) always
  // reconnects.
  const rawConnectKey = connect ? JSON.stringify(connect) : null;
  const connectKey =
    connect?.attach && !connect.retry && connect.attach === liveSessionRef.current && connectKeyRef.current
      ? connectKeyRef.current
      : rawConnectKey;

  // Automatic re-attach after the socket drops (network blip, laptop sleep,
  // proxy/backend restart). { attempt, delayMs, offline } while retrying.
  const [reconnect, setReconnect] = useState(null);
  const retryNowRef = useRef(null);

  useEffect(() => {
    if (!connect) return undefined;
    connectKeyRef.current = connectKey;

    const signal = { cancelled: false };
    setError('');
    setEndedReason('');
    setReconnect(null);
    statusRef.current = 'connecting';
    emitState('connecting');

    let cleanupResize = () => {};
    let retryTimer = null;
    let attempt = 0;
    let onlineListener = null;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      theme: XTERM_THEME,
      allowTransparency: false,
      scrollback: 3000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.attachCustomKeyEventHandler(isWorkspaceShortcut);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    if (containerRef.current) {
      term.open(containerRef.current);
    }

    // Keystrokes go to whichever socket is current (it changes on re-attach).
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    term.onResize(({ cols, rows }) => sendResize(cols, rows));

    const failBeforeConnect = (message) => {
      if (signal.cancelled) return;
      setError((prev) => prev || message);
      emitState('error', message);
    };

    const markLost = (reason) => {
      if (signal.cancelled) return;
      clearTimeout(retryTimer);
      setReconnect(null);
      setEndedReason(reason || '');
      emitState('lost', reason || 'not_found');
    };

    const sessionToResume = () => liveSessionRef.current || connect.attach || null;

    // Re-attach loop: 1s, 2s, 4s, 8s, then every 15s, and immediately when the
    // browser comes back online. Only a session that is really gone (4404/4403)
    // stops it; the workspace then offers recovery.
    function scheduleReconnect() {
      if (signal.cancelled) return;
      const sid = sessionToResume();
      if (!sid) return;
      attempt += 1;
      const delayMs = Math.min(15000, 1000 * 2 ** Math.min(attempt - 1, 4));
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      setReconnect({ attempt, delayMs, offline });
      if (statusRef.current !== 'reconnecting') emitState('reconnecting');
      clearTimeout(retryTimer);
      if (onlineListener) window.removeEventListener('online', onlineListener);
      const go = () => {
        if (onlineListener) window.removeEventListener('online', onlineListener);
        onlineListener = null;
        clearTimeout(retryTimer);
        start({ attach: sid }, { reattach: true });
      };
      retryNowRef.current = go;
      onlineListener = go;
      window.addEventListener('online', onlineListener);
      if (!offline) retryTimer = setTimeout(go, delayMs);
    }

    function start(sshParams, { reattach }) {
      (async () => {
        try {
          await refresh();
        } catch {
          // fall back to the stored access token already on the axios client;
          // the ws-ticket request below will 401 if it's stale.
        }
        if (signal.cancelled || termRef.current !== term) return;

        setTimeout(async () => {
          if (signal.cancelled || termRef.current !== term) return;
          try {
            fitAddon.fit();
          } catch {
            /* zero-size container (inactive pane) — cols/rows fall back to defaults */
          }
          const { cols, rows } = term;

          // The connect spec becomes the ws-ticket's bound `params`, minted by
          // an authenticated REST call (JWT stays in the Authorization header,
          // never the WS URL). See services/terminalService.js requestWsTicket
          // and backend routes/terminal.js POST /ws-ticket (B-6/B-7 hardening).
          let wsTicket;
          try {
            wsTicket = await requestWsTicket('ssh', sshParams);
          } catch (err) {
            const st = err.response?.status;
            // Backend down / restarting / rate limited: keep trying to re-attach.
            const transient = !err.response || st >= 500 || st === 429 || st === 408;
            if (reattach && transient) {
              scheduleReconnect();
              return;
            }
            failBeforeConnect(
              err.response?.data?.error?.message || err.message || 'Failed to start the terminal session.'
            );
            return;
          }
          if (signal.cancelled || termRef.current !== term) return;

          const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const params = new URLSearchParams({ t: wsTicket.ticket, cols: String(cols), rows: String(rows) });
          const url = `${wsProtocol}//${window.location.host}/api/terminal/ssh?${params.toString()}`;
          openWs(url, { reattach });
        }, 50);
      })();
    }

    let sshParams;
    if (connect.attach) sshParams = { attach: connect.attach };
    else if (connect.ticket) sshParams = { ticket: connect.ticket };
    else if (connect.requestId) {
      sshParams = { requestId: connect.requestId, ...(connect.principal ? { principal: connect.principal } : {}) };
    }
    if (sshParams) start(sshParams, { reattach: !!connect.attach });

    const handleResize = () => {
      // A hidden tab (moved into the workspace's display:none holder) has a
      // zero-size box. Fitting to it would shrink the remote PTY to a
      // couple of columns and garble the prompt, so wait until it's shown.
      const box = containerRef.current;
      if (!box || box.clientWidth < 20 || box.clientHeight < 20) return;
      try {
        fitAddonRef.current?.fit();
        sendResize(term.cols, term.rows);
      } catch {
        /* ignore */
      }
    };
    resizeObserverRef.current = new ResizeObserver(handleResize);
    if (containerRef.current) resizeObserverRef.current.observe(containerRef.current);

    // Web fonts (JetBrains Mono etc.) can finish loading after xterm's first
    // fit, subtly changing glyph metrics and, with it, how many rows fit —
    // re-fit once they're ready so the last line/cursor doesn't end up
    // clipped below the visible pane.
    let fontsCancelled = false;
    document.fonts?.ready
      ?.then(() => {
        if (fontsCancelled || signal.cancelled) return;
        handleResize();
      })
      .catch(() => {});

    cleanupResize = () => {
      fontsCancelled = true;
      resizeObserverRef.current?.disconnect();
    };

    function openWs(url, { reattach }) {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      lastSizeRef.current = null; // new socket: next resize must go through
      ws.binaryType = 'arraybuffer';
      const isCurrent = () => wsRef.current === ws && !signal.cancelled;

      let sshUp = false;
      // A socket that fails once we had a session is retried, not reported.
      const resumable = () => reattach || !!liveSessionRef.current;
      const markUp = (info) => {
        if (!isCurrent()) return;
        if (info?.sessionId) liveSessionRef.current = info.sessionId;
        const wasUp = sshUp;
        sshUp = true;
        clearTimeout(openTimer);
        clearTimeout(handshakeTimer);
        if (!wasUp) {
          attempt = 0;
          setReconnect(null);
          setError('');
          emitState('live');
          onSession?.(info);
          term.focus();
        }
      };
      const fail = (message) => {
        if (!isCurrent()) return;
        if (!resumable()) {
          setError((prev) => prev || message);
          emitState('error', message);
        }
        try {
          ws.close(4000, 'client timeout');
        } catch {
          /* ignore */
        }
      };

      let handshakeTimer;
      const openTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          fail('Could not reach the terminal service — if Shellius is behind a proxy, it must forward WebSocket upgrades.');
        }
      }, 10_000);

      ws.onopen = () => {
        if (!isCurrent()) return;
        clearTimeout(openTimer);
        handshakeTimer = setTimeout(() => {
          if (!sshUp) fail('Timed out establishing the SSH session. The host may be unreachable, or a firewall is dropping the connection.');
        }, 45_000);
      };

      ws.onmessage = (evt) => {
        if (!isCurrent()) return;
        let text;
        if (typeof evt.data === 'string') {
          text = evt.data;
        } else if (evt.data instanceof ArrayBuffer) {
          text = new TextDecoder().decode(evt.data);
        } else if (evt.data instanceof Blob) {
          evt.data.text().then((t) => {
            markUp();
            term.write(t);
          });
          return;
        }
        if (text && text.length > 0 && text[0] === '{') {
          try {
            const msg = JSON.parse(text);
            if (msg?.type === 'error' && typeof msg.message === 'string') {
              clearTimeout(openTimer);
              clearTimeout(handshakeTimer);
              setError(msg.message);
              emitState('error', msg.message);
              return;
            }
            if (msg?.type === 'hostkey') {
              onHostKey?.({ fingerprint: msg.fingerprint, algorithm: msg.algorithm, status: msg.status });
              return;
            }
            if (msg?.type === 'connected') {
              markUp({
                sessionId: msg.sessionId,
                authMethod: msg.authMethod,
                host: msg.host,
                port: msg.port,
                username: msg.username,
                label: msg.label,
              });
              return;
            }
            if (msg?.type === 'attached') {
              // The hub replays its recent-output buffer next. On a re-attach
              // this xterm already shows that output, so start clean instead
              // of printing it twice.
              if (reattach && term.buffer.active.length > 1) term.reset();
              markUp({ sessionId: msg.sessionId, attached: true });
              return;
            }
            if (msg?.type === 'ended') {
              clearTimeout(retryTimer);
              setReconnect(null);
              setEndedReason(msg.reason || 'closed');
              emitState('ended', msg.reason);
              return;
            }
          } catch {
            // not JSON — raw shell output that happens to start with '{'
          }
        }
        markUp();
        term.write(text);
      };

      ws.onerror = () => {
        // onclose always follows and decides between retry / lost / error.
      };

      ws.onclose = (evt) => {
        clearTimeout(openTimer);
        clearTimeout(handshakeTimer);
        if (!isCurrent()) return;
        if (statusRef.current === 'ended') return;
        // The session no longer exists in the hub (backend restarted, detach
        // timeout, ended elsewhere) or isn't ours: nothing to re-attach to.
        if (evt.code === 4404 || evt.code === 4403) {
          markLost(evt.code === 4403 ? 'forbidden' : 'not_found');
          return;
        }
        if (resumable()) {
          scheduleReconnect();
          return;
        }
        if (evt.code !== 1000 && evt.code !== 1001) {
          const message = evt.reason ? evt.reason : `Connection closed (code ${evt.code}).`;
          setError((prev) => prev || message);
          emitState('error', message);
        }
      };
    }

    // Laptop wake / network change: a socket the browser hasn't noticed is
    // dead yet gets retried as soon as we're back online.
    const onBackOnline = () => {
      const ws = wsRef.current;
      if (statusRef.current === 'live' && ws && ws.readyState !== WebSocket.OPEN && sessionToResume()) {
        scheduleReconnect();
      }
    };
    window.addEventListener('online', onBackOnline);

    return () => {
      signal.cancelled = true;
      clearTimeout(retryTimer);
      if (onlineListener) window.removeEventListener('online', onlineListener);
      window.removeEventListener('online', onBackOnline);
      retryNowRef.current = null;
      cleanupResize();
      if (wsRef.current) {
        // Unmount = detach only. The hub keeps the SSH session alive; no
        // explicit {type:'close'} frame is sent here.
        wsRef.current.close(1000, 'pane unmounted');
        wsRef.current = null;
      }
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectKey]);

  return (
    <div className={`relative flex h-full min-h-0 flex-col bg-ink ${className}`}>
      {error && status !== 'ended' && status !== 'reconnecting' && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-red-500/20 bg-red-500/10 px-3 py-1.5">
          <p className="flex-1 text-xs text-red-400">{error}</p>
          <button onClick={() => setError('')} className="rounded p-0.5 text-red-400 hover:text-red-300">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {status === 'reconnecting' && reconnect && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5"
        >
          <p className="flex flex-1 items-center gap-2 text-xs text-amber-300">
            <Loader2 className="h-3 w-3 animate-spin" />
            {reconnect.offline
              ? "You're offline. Reconnecting when the network is back…"
              : `Connection lost. Reconnecting${reconnect.attempt > 1 ? ` (attempt ${reconnect.attempt})` : ''}…`}
          </p>
          <button
            type="button"
            onClick={() => retryNowRef.current?.()}
            className="rounded px-1.5 py-0.5 text-xs font-medium text-amber-200 hover:bg-amber-500/20"
          >
            Retry now
          </button>
        </div>
      )}

      {status === 'connecting' && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-ink">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…
          </span>
        </div>
      )}

      {/* The workspace renders its own recovery card for these (statusOverlay=false). */}
      {statusOverlay && (status === 'ended' || status === 'lost') && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-ink/95 text-center">
          <p className="text-sm font-medium text-foreground">
            {status === 'lost' ? 'This session is no longer running' : 'Session ended'}
          </p>
          <p className="text-xs text-muted-foreground">
            {status === 'lost'
              ? 'Shellius may have restarted, or the session timed out while detached.'
              : endedReason
                ? `Reason: ${endedReason}`
                : ''}
          </p>
        </div>
      )}

      {/* The padding lives on this OUTER box, not on containerRef itself:
          @xterm/addon-fit computes available height from
          `term.element.parentElement`'s computed (border-box) height minus
          only `term.element`'s OWN padding — it does not know about padding
          on an ancestor. Padding directly on containerRef (xterm's mount
          point) was silently double-counted as available space, so xterm
          rendered ~1 row taller than the visible box and clipped the last
          line/cursor below the fold. Keeping containerRef padding-free
          makes its clientHeight exactly the terminal's real budget. */}
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        <div ref={containerRef} className="h-full min-h-0 w-full" />
      </div>
    </div>
  );
});

export default TerminalView;
