import { useEffect, useRef, useState, useCallback } from 'react';
import Guacamole from 'guacamole-common-js';
import { Circle, Loader, RefreshCw, X } from 'lucide-react';
import { getRdpGatewayToken } from '@/services/accessRequestService';

const STATUS = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
};

// Guacamole client state codes
const GUAC_STATE_IDLE = 0;
const GUAC_STATE_CONNECTING = 1;
const GUAC_STATE_WAITING = 2;
const GUAC_STATE_CONNECTED = 3;
const GUAC_STATE_DISCONNECTING = 4;
const GUAC_STATE_DISCONNECTED = 5;

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

function RdpTerminal({ requestId, onClose }) {
  const containerRef = useRef(null);
  const clientRef = useRef(null);
  const mouseRef = useRef(null);
  const keyboardRef = useRef(null);
  const resizeObserverRef = useRef(null);

  const [status, setStatus] = useState(STATUS.CONNECTING);
  const [error, setError] = useState('');

  const cleanup = useCallback(() => {
    if (keyboardRef.current) {
      keyboardRef.current.onkeydown = null;
      keyboardRef.current.onkeyup = null;
      keyboardRef.current = null;
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
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
    }
  }, []);

  const connect = useCallback(async () => {
    if (!requestId || !containerRef.current) return;

    cleanup();

    setStatus(STATUS.CONNECTING);
    setError('');

    let tokenData;
    try {
      const resp = await getRdpGatewayToken(requestId);
      tokenData = resp.data || resp;
    } catch (err) {
      const msg =
        err.response?.data?.error?.message ||
        err.message ||
        'Failed to obtain RDP gateway token.';
      setError(msg);
      setStatus(STATUS.DISCONNECTED);
      return;
    }

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

    // Map Guacamole connection states to our STATUS values
    client.onstatechange = (state) => {
      if (state === GUAC_STATE_CONNECTED) {
        setStatus(STATUS.CONNECTED);
      } else if (
        state === GUAC_STATE_DISCONNECTED ||
        state === GUAC_STATE_DISCONNECTING
      ) {
        setStatus(STATUS.DISCONNECTED);
      }
    };

    client.onerror = (guacError) => {
      setStatus(STATUS.DISCONNECTED);
      setError(
        guacError?.message || 'RDP connection error. The session may have ended.'
      );
    };

    // Mount the Guacamole display element
    const displayEl = client.getDisplay().getElement();
    containerRef.current.appendChild(displayEl);

    // Compute initial dimensions from the container
    const containerWidth = containerRef.current.clientWidth || 1280;
    const containerHeight = containerRef.current.clientHeight || 800;

    client.connect(
      `token=${encodeURIComponent(jwt)}&width=${containerWidth}&height=${containerHeight}&dpi=96`
    );

    // Wire up mouse events
    const mouse = new Guacamole.Mouse(displayEl);
    mouseRef.current = mouse;
    mouse.onmousedown = (mouseState) => client.sendMouseState(mouseState);
    mouse.onmouseup = (mouseState) => client.sendMouseState(mouseState);
    mouse.onmousemove = (mouseState) => client.sendMouseState(mouseState);
    mouse.onmouseout = (mouseState) => client.sendMouseState(mouseState);
    mouse.onmousewheel = (mouseState) => client.sendMouseState(mouseState);

    // Wire up keyboard events on the document
    const keyboard = new Guacamole.Keyboard(document);
    keyboardRef.current = keyboard;
    keyboard.onkeydown = (keysym) => client.sendKeyEvent(1, keysym);
    keyboard.onkeyup = (keysym) => client.sendKeyEvent(0, keysym);

    // Resize observer — dispatch size to the display and attempt client.sendSize
    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current || !clientRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      if (!w || !h) return;
      const display = clientRef.current.getDisplay();
      display.scale(w / display.getWidth() || 1);
      // sendSize is available in newer guacamole-common-js builds
      if (typeof clientRef.current.sendSize === 'function') {
        clientRef.current.sendSize(w, h);
      }
    });
    resizeObserverRef.current = resizeObserver;
    resizeObserver.observe(containerRef.current);
  }, [requestId, cleanup]);

  useEffect(() => {
    connect();
    return () => {
      cleanup();
    };
  }, [connect, cleanup]);

  const handleReconnect = () => {
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
              title="Close session"
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

      {/* Guacamole display container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden cursor-none"
        style={{ background: '#000000' }}
      />
    </div>
  );
}

export default RdpTerminal;
