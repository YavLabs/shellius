import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Circle, Loader, RefreshCw, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import '@xterm/xterm/css/xterm.css';

const STATUS = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
};

function StatusIndicator({ status }) {
  if (status === STATUS.CONNECTING) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-amber-500 dark:text-amber-400">
        <Loader className="h-3 w-3 animate-spin" />
        Connecting
      </span>
    );
  }
  if (status === STATUS.CONNECTED) {
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

function WebTerminal({ requestId, onClose }) {
  // NOTE: we deliberately do NOT consume `accessToken` from context here.
  // connect() calls refresh(), which updates accessToken in AuthContext; if
  // accessToken were a dependency of connect()/the effect, that update would
  // re-create connect → tear down and reopen the socket → refresh() again, an
  // endless reconnect loop. The loop left a stale "WebSocket connection error"
  // banner on top of an otherwise-Connected session. The token is always read
  // fresh from storage (and via refresh()) at connect time, so it isn't needed
  // as reactive state.
  const { refresh } = useAuth();
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);
  const resizeObserverRef = useRef(null);

  const [status, setStatus] = useState(STATUS.CONNECTING);
  const [error, setError] = useState('');

  const sendResize = useCallback((cols, rows) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);

  const connect = useCallback(async () => {
    if (!requestId) return;

    setStatus(STATUS.CONNECTING);
    setError('');

    // Force-refresh the access token before opening the WebSocket. The WS
    // bypasses axios entirely, so the auto-refresh interceptor never fires
    // for it. Without this, a stale token (15 min default TTL) leaves the
    // backend rejecting the upgrade with "Invalid or expired token".
    let token = localStorage.getItem('accessToken');
    try {
      const refreshed = await refresh();
      if (refreshed?.accessToken) token = refreshed.accessToken;
    } catch {
      // If refresh fails, fall back to whatever's in storage and let the
      // backend reject — the user will get the auth error and can re-login.
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;

    // Init terminal
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      theme: {
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
      },
      allowTransparency: false,
      scrollback: 3000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    if (containerRef.current) {
      term.open(containerRef.current);
      // Small delay to allow DOM to settle before fitting
      setTimeout(() => {
        fitAddon.fit();
        const { cols, rows } = term;
        const url = `${protocol}//${host}/api/terminal/ssh?token=${encodeURIComponent(token)}&requestId=${encodeURIComponent(requestId)}&cols=${cols}&rows=${rows}`;
        openWs(url, term);
      }, 50);
    }

    // Handle window resize
    const handleResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
        sendResize(term.cols, term.rows);
      }
    };

    resizeObserverRef.current = new ResizeObserver(handleResize);
    if (containerRef.current) {
      resizeObserverRef.current.observe(containerRef.current);
    }
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [requestId, refresh, sendResize]);

  function openWs(url, term) {
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    // A socket that has been superseded (replaced in wsRef during a reconnect)
    // must never write output or flip status/error for the live session.
    const isCurrent = () => wsRef.current === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      setStatus(STATUS.CONNECTED);
      term.focus();
    };

    ws.onmessage = (evt) => {
      if (!isCurrent()) return;
      let text;
      if (typeof evt.data === 'string') {
        text = evt.data;
      } else if (evt.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(evt.data);
      } else if (evt.data instanceof Blob) {
        evt.data.text().then((t) => term.write(t));
        return;
      }
      // Backend may send structured JSON control frames (e.g. errors).
      if (text && text.length > 0 && text[0] === '{') {
        try {
          const msg = JSON.parse(text);
          if (msg && msg.type === 'error' && typeof msg.message === 'string') {
            setError(msg.message);
            return;
          }
        } catch {
          // not JSON — treat as raw shell output
        }
      }
      term.write(text);
    };

    ws.onerror = () => {
      if (!isCurrent()) return;
      setStatus(STATUS.DISCONNECTED);
      setError((prev) => prev || 'WebSocket connection error. Check your network or try reconnecting.');
    };

    ws.onclose = (evt) => {
      if (!isCurrent()) return;
      setStatus(STATUS.DISCONNECTED);
      if (evt.code !== 1000 && evt.code !== 1001) {
        // Prefer the human reason from the backend (set via setError on the
        // structured error frame just before close). Fall back to evt.reason
        // if the frame never arrived.
        setError((prev) =>
          prev || (evt.reason ? evt.reason : `Connection closed (code ${evt.code}). You may reconnect.`)
        );
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    term.onResize(({ cols, rows }) => {
      sendResize(cols, rows);
    });
  }

  useEffect(() => {
    // connect() is async and resolves to its own cleanup function (or
    // undefined). Capture the resolved value into a ref so the useEffect
    // teardown can call it correctly.
    let cleanupFn = null;
    let cancelled = false;
    connect().then((fn) => {
      if (cancelled) {
        if (typeof fn === 'function') fn();
      } else {
        cleanupFn = fn;
      }
    });

    return () => {
      cancelled = true;
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmounted');
        wsRef.current = null;
      }
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
      if (typeof cleanupFn === 'function') cleanupFn();
    };
  }, [connect]);

  const handleReconnect = () => {
    // Clean up existing terminal and ws before reconnecting
    if (wsRef.current) {
      wsRef.current.close(1000, 'Reconnecting');
      wsRef.current = null;
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
    }
    connect();
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] rounded-lg overflow-hidden border border-border">
      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 bg-[#111111] shrink-0">
        <StatusIndicator status={status} />
        <div className="flex items-center gap-2">
          {status === STATUS.DISCONNECTED && (
            <button
              onClick={handleReconnect}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground bg-accent/60 hover:bg-accent transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              Reconnect
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
              title="Close terminal"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-red-500/10 border-b border-red-500/20 shrink-0">
          <p className="text-xs text-red-400 flex-1">{error}</p>
          <button
            onClick={() => setError('')}
            className="rounded p-0.5 text-red-400 hover:text-red-300 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 p-2"
        style={{ background: '#0a0a0a' }}
      />
    </div>
  );
}

export default WebTerminal;
