import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Loader2, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
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
  background: '#0a0a0a',
  foreground: '#e4e4e4',
  cursor: '#e4e4e4',
  selectionBackground: '#ffffff33',
  black: '#1e1e1e',
  red: '#f28779',
  green: '#87d987',
  yellow: '#ffd580',
  blue: '#5ccfe6',
  magenta: '#d4bfff',
  cyan: '#95e6cb',
  white: '#d0d0d0',
  brightBlack: '#636363',
  brightRed: '#ff6e67',
  brightGreen: '#a1ef8b',
  brightYellow: '#ffe585',
  brightBlue: '#6dcfef',
  brightMagenta: '#e0cfff',
  brightCyan: '#a8f5d4',
  brightWhite: '#ffffff',
};

/**
 * TerminalView — reusable SSH terminal pane driven by a `connect` spec:
 *   { ticket }                 — Quick Connect (single-use ticket)
 *   { requestId, principal? }  — access-request session
 *   { attach: sessionId }      — attach to a live hub session
 *
 * Reports lifecycle via onSession({sessionId,...}) and onStateChange(state,
 * extra) where state is 'connecting' | 'live' | 'ended' | 'error'. Unmount
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
  { connect, visible = true, onSession, onStateChange, onHostKey, className = '' },
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

  const sendResize = useCallback((cols, rows) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
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
  // "attach to the session I'm already on" keeps the previous key.
  const rawConnectKey = connect ? JSON.stringify(connect) : null;
  const connectKey =
    connect?.attach && connect.attach === liveSessionRef.current && connectKeyRef.current
      ? connectKeyRef.current
      : rawConnectKey;

  useEffect(() => {
    if (!connect) return undefined;
    connectKeyRef.current = connectKey;

    const signal = { cancelled: false };
    setError('');
    setEndedReason('');
    statusRef.current = 'connecting';
    emitState('connecting');

    let cleanupResize = () => {};

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

    (async () => {
      let token = localStorage.getItem('accessToken');
      try {
        const refreshed = await refresh();
        if (refreshed?.accessToken) token = refreshed.accessToken;
      } catch {
        // fall back to stored token; backend will reject if it's stale
      }
      if (signal.cancelled) return;

      setTimeout(() => {
        if (signal.cancelled || termRef.current !== term) return;
        try {
          fitAddon.fit();
        } catch {
          /* zero-size container (inactive pane) — cols/rows fall back to defaults */
        }
        const { cols, rows } = term;
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const params = new URLSearchParams({ token, cols: String(cols), rows: String(rows) });
        if (connect.attach) {
          params.set('attach', connect.attach);
        } else if (connect.ticket) {
          params.set('ticket', connect.ticket);
        } else if (connect.requestId) {
          params.set('requestId', connect.requestId);
          if (connect.principal) params.set('principal', connect.principal);
        } else {
          return;
        }
        const url = `${wsProtocol}//${window.location.host}/api/terminal/ssh?${params.toString()}`;
        openWs(url, term, signal);
      }, 50);
    })();

    const handleResize = () => {
      try {
        fitAddonRef.current?.fit();
        sendResize(term.cols, term.rows);
      } catch {
        /* ignore */
      }
    };
    resizeObserverRef.current = new ResizeObserver(handleResize);
    if (containerRef.current) resizeObserverRef.current.observe(containerRef.current);
    cleanupResize = () => resizeObserverRef.current?.disconnect();

    function openWs(url, term, signal) {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';
      const isCurrent = () => wsRef.current === ws && !signal.cancelled;

      let sshUp = false;
      const markUp = (info) => {
        if (!isCurrent()) return;
        if (info?.sessionId) liveSessionRef.current = info.sessionId;
        sshUp = true;
        clearTimeout(openTimer);
        clearTimeout(handshakeTimer);
        emitState('live');
        onSession?.(info);
        term.focus();
      };
      const fail = (message) => {
        if (!isCurrent()) return;
        setError((prev) => prev || message);
        emitState('error', message);
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
              markUp({ sessionId: msg.sessionId, attached: true });
              return;
            }
            if (msg?.type === 'ended') {
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
        if (!isCurrent()) return;
        clearTimeout(openTimer);
        clearTimeout(handshakeTimer);
        setError((prev) => prev || 'WebSocket connection error. Check your network or try reconnecting.');
        emitState('error');
      };

      ws.onclose = (evt) => {
        clearTimeout(openTimer);
        clearTimeout(handshakeTimer);
        if (!isCurrent()) return;
        // A prior 'ended' control frame already reported the real reason —
        // don't downgrade it to a generic close error.
        if (statusRef.current !== 'ended' && evt.code !== 1000 && evt.code !== 1001) {
          setError((prev) => prev || (evt.reason ? evt.reason : `Connection closed (code ${evt.code}).`));
        }
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
      term.onResize(({ cols, rows }) => sendResize(cols, rows));
    }

    return () => {
      signal.cancelled = true;
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
    <div className={`relative flex h-full min-h-0 flex-col bg-[#0a0a0a] ${className}`}>
      {error && status !== 'ended' && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-red-500/20 bg-red-500/10 px-3 py-1.5">
          <p className="flex-1 text-xs text-red-400">{error}</p>
          <button onClick={() => setError('')} className="rounded p-0.5 text-red-400 hover:text-red-300">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {status === 'connecting' && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[#0a0a0a]">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…
          </span>
        </div>
      )}

      {status === 'ended' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[#0a0a0a]/95 text-center">
          <p className="text-sm font-medium text-foreground">Session ended</p>
          <p className="text-xs text-muted-foreground">{endedReason ? `Reason: ${endedReason}` : ''}</p>
        </div>
      )}

      <div ref={containerRef} className="min-h-0 flex-1 p-2" />
    </div>
  );
});

export default TerminalView;
