/**
 * rdpPanes.js — the pure decisions behind running RDP inside the multi-tab
 * terminal workspace. No React, no DOM, no Guacamole import: everything here
 * is a plain function so it can be unit-tested (see rdpPanes.test.js) and so
 * RdpTerminal.jsx is left with nothing but wiring.
 *
 * Three things live here:
 *
 *  1. The Windows single-session rule. Windows Server permits ONE interactive
 *     session per user account. Every Shellius RDP connection to a given
 *     server logs in as that server's configured RDP account (rdpUsername, or
 *     the Keystore identity's username — see backend resolveRdpCredentials),
 *     so two panes onto the same server are two logins as the SAME Windows
 *     user and the second evicts the first ("Disconnected by other
 *     connection"). This is the exact failure commit 5acbd45 fixed for the
 *     StrictMode double-mount; a split view would reintroduce it as a
 *     permanent feature. So we refuse the second pane and focus the first.
 *
 *  2. Which workspace keystrokes an RDP pane must NOT swallow. A focused pane
 *     captures essentially the whole keyboard; the handful of chords that
 *     drive the workspace itself have to survive.
 *
 *  3. Guacamole protocol/status codes → text and tab state.
 */

export const RDP = 'RDP';

/** States in which a tab still owns a (possibly broken) RDP connection. */
const LIVE_TAB_STATES = new Set(['connecting', 'live', 'reconnecting']);

export function isRdpTab(tab) {
  return !!tab && tab.protocol === RDP;
}

// ---------------------------------------------------------------------------
// 1. Windows single-session rule
// ---------------------------------------------------------------------------

/**
 * Does opening an RDP pane onto `target` collide with a tab that is already
 * open?
 *
 * Matching is deliberately conservative. Two panes collide when they address
 * the same server AND we cannot prove they use different Windows accounts.
 * The frontend often does not know the account at all (it is resolved
 * server-side from `Server.rdpUsername` / the bound identity and never sent to
 * the browser), so an unknown username on either side counts as "might be the
 * same" — we would rather make the user click an extra time than silently
 * evict a session they are working in.
 *
 * Usernames are compared case-insensitively: Windows account names are
 * case-insensitive, so `Administrator` and `administrator` are one account and
 * one session.
 *
 * @param {Array} tabs              workspace tabs
 * @param {object} target           { serverId, username? }
 * @param {object} [opts]
 * @param {string} [opts.excludeTabId]  ignore this tab (reconnect in place)
 * @returns {object|null}           the conflicting tab, or null
 */
export function findRdpConflict(tabs, target, opts = {}) {
  if (!target || !target.serverId) return null;
  const { excludeTabId } = opts;
  const wanted = normalizeAccount(target.username);

  for (const tab of tabs || []) {
    if (!isRdpTab(tab)) continue;
    if (tab.id === excludeTabId) continue;
    if (!LIVE_TAB_STATES.has(tab.state)) continue;
    if (tab.serverId !== target.serverId) continue;

    const existing = normalizeAccount(tab.username);
    // Both accounts known and different → two Windows users, two sessions,
    // no eviction. Anything else is treated as a collision.
    if (existing && wanted && existing !== wanted) continue;
    return tab;
  }
  return null;
}

function normalizeAccount(username) {
  if (typeof username !== 'string') return null;
  const trimmed = username.trim();
  if (!trimmed) return null;
  // DOMAIN\user and user@domain both identify one account; compare the whole
  // string lowercased rather than guessing at the domain part.
  return trimmed.toLowerCase();
}

/**
 * What a tab's context menu may offer. RDP has no session hub behind it:
 * `terminalService` tracks only SSH sessions ("Only SSH rows: RDP
 * (guacamole) sessions are not tracked by the hub"), so there is no session
 * id to attach to, duplicate, re-label or close over REST. Duplicating would
 * also be an instant self-eviction (see above).
 */
export function tabCapabilities(tab) {
  if (isRdpTab(tab)) {
    return {
      canRename: true,        // local label only
      canSplit: true,
      canDuplicate: false,    // would evict the original Windows session
      canOpenNewWindow: true, // a fresh /terminal?requestId=… window…
      canEndSession: false,   // …but only after this pane is closed
      canAttach: false,
      endsOnClose: true,      // closing the tab really does end the connection
    };
  }
  return {
    canRename: true,
    canSplit: true,
    canDuplicate: !!tab?.sessionId,
    canOpenNewWindow: !!tab?.sessionId,
    canEndSession: true,
    canAttach: true,
    endsOnClose: false,       // SSH detaches; the hub keeps it running
  };
}

// ---------------------------------------------------------------------------
// 2. Keyboard ownership
// ---------------------------------------------------------------------------

// X11 keysyms for the keys used by workspace chords.
const KS = {
  TAB: 0xff09,
  LEFT: 0xff51,
  RIGHT: 0xff53,
  T_UPPER: 0x0054,
  T_LOWER: 0x0074,
  W_UPPER: 0x0057,
  W_LOWER: 0x0077,
  ONE: 0x0031,
  NINE: 0x0039,
};

/**
 * True when this keysym + modifier state is a chord the Terminals page owns
 * (see the `keydown` handler in pages/Terminals.jsx). The pane must not send
 * it to the remote host, or every Ctrl+Tab would both switch Shellius tabs
 * and reach Windows.
 *
 * The pane still calls preventDefault on it — Terminals.jsx does too, and
 * preventDefault does not stop propagation, so the page handler still runs.
 *
 * @param {number} keysym
 * @param {{ctrl?:boolean, alt?:boolean, shift?:boolean, meta?:boolean}} modifiers
 */
export function isWorkspaceShortcut(keysym, modifiers = {}) {
  const mod = !!modifiers.ctrl || !!modifiers.meta;
  const shift = !!modifiers.shift;
  const alt = !!modifiers.alt;

  // Ctrl/Cmd+Shift+T — new connection
  if (mod && shift && (keysym === KS.T_UPPER || keysym === KS.T_LOWER)) return true;
  // Ctrl/Cmd+Shift+W — close tab
  if (mod && shift && (keysym === KS.W_UPPER || keysym === KS.W_LOWER)) return true;
  // Ctrl/Cmd+Tab and Ctrl/Cmd+Shift+Tab — cycle tabs
  if (mod && keysym === KS.TAB) return true;
  // Alt+1..9 — jump to tab N. Terminals.jsx tests only `altKey`, so neither
  // do we: if the page is going to act on the chord, the remote must not
  // also receive it.
  if (alt && keysym >= KS.ONE && keysym <= KS.NINE) return true;
  // Alt+Shift+Left/Right — move tab
  if (alt && shift && (keysym === KS.LEFT || keysym === KS.RIGHT)) return true;

  return false;
}

/**
 * The Ctrl+Alt+Del chord, as keysyms, for the toolbar button. The OS
 * intercepts the real key combination before any web page sees it (Secure
 * Attention Sequence), so it can only ever be injected, never captured.
 */
export const CTRL_ALT_DEL_KEYSYMS = [0xffe3, 0xffe9, 0xffff]; // Control_L, Alt_L, Delete

// ---------------------------------------------------------------------------
// 3. Guacamole state + errors
// ---------------------------------------------------------------------------

export const GUAC_STATE = {
  IDLE: 0,
  CONNECTING: 1,
  WAITING: 2,
  CONNECTED: 3,
  DISCONNECTING: 4,
  DISCONNECTED: 5,
};

/** Guacamole client state code → the pane's own status. */
export function guacStatus(code) {
  switch (code) {
    case GUAC_STATE.CONNECTED:
      return 'connected';
    case GUAC_STATE.DISCONNECTING:
    case GUAC_STATE.DISCONNECTED:
      return 'disconnected';
    case GUAC_STATE.IDLE:
    case GUAC_STATE.CONNECTING:
    case GUAC_STATE.WAITING:
      return 'connecting';
    default:
      return 'connecting';
  }
}

/** Pane status → the workspace tab state consumed by TerminalTabBar. */
export function tabStateForStatus(status) {
  if (status === 'connected') return 'live';
  if (status === 'disconnected') return 'ended';
  return 'connecting';
}

const GUAC_ERRORS = {
  0x0200: 'The remote desktop gateway hit an internal error.',
  0x0201: 'The remote desktop gateway is busy. Try again in a moment.',
  0x0202: 'The server took too long to respond.',
  0x0203: 'The server refused the connection or dropped it unexpectedly.',
  0x0204: 'The remote desktop could not be found.',
  0x0205: 'The remote desktop is already in use.',
  0x0206: 'The remote desktop closed the connection.',
  0x0207: 'The server could not be reached.',
  0x0208: 'The server is not accepting connections right now.',
  // The one that matters most here: Windows evicted this login because the
  // same account signed in somewhere else.
  0x0209: 'Signed out — the same Windows account connected from somewhere else.',
  0x020a: 'Disconnected after being idle for too long.',
  0x020b: 'The session was closed.',
  0x0300: 'The gateway rejected the connection request.',
  0x0301: 'Access to this server was refused. Your access may have expired.',
  0x0303: 'You are not allowed to connect to this server.',
  0x0308: 'Disconnected after being idle for too long.',
  0x031d: 'Too many active connections. Close one and try again.',
};

/**
 * Human text for a Guacamole error/status object. Never surfaces raw
 * credentials or protocol detail — guacd's own message is used only when we
 * have no mapping for the code.
 */
export function guacErrorText(error) {
  if (!error) return 'The remote desktop connection ended.';
  const mapped = GUAC_ERRORS[error.code];
  if (mapped) return mapped;
  if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
  return 'The remote desktop connection ended.';
}

/** True when the disconnect was Windows evicting us for a duplicate login. */
export function isEvictionError(error) {
  return error?.code === 0x0209;
}

// ---------------------------------------------------------------------------
// 4. display-update resizing
// ---------------------------------------------------------------------------

/** guacd rejects silly geometries; Guacamole's own client uses these bounds. */
const MIN_DIM = 200;
const MAX_DIM = 8192;
/** Below this many pixels of change, a resize is not worth a round trip. */
export const RESIZE_THRESHOLD_PX = 8;

/**
 * Decide whether to ask guacd for a new remote desktop size
 * (`resize-method: display-update`, set in backend rdpService.buildRdpToken).
 *
 * Returns the geometry to send, or null to do nothing. Nulls out anything
 * that is not a sane, meaningfully-different size so a hidden pane
 * (clientWidth 0, because TerminalPaneArea parks it in a `display:none`
 * holder) or a one-pixel reflow never reaches the wire.
 *
 * @param {{width:number,height:number}|null} current  last size sent
 * @param {{width:number,height:number}} next          pane size now
 */
export function nextDisplaySize(current, next) {
  const width = Math.round(next?.width ?? 0);
  const height = Math.round(next?.height ?? 0);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < MIN_DIM || height < MIN_DIM) return null;
  if (width > MAX_DIM || height > MAX_DIM) return null;
  if (
    current &&
    Math.abs(current.width - width) < RESIZE_THRESHOLD_PX &&
    Math.abs(current.height - height) < RESIZE_THRESHOLD_PX
  ) {
    return null;
  }
  return { width, height };
}

/**
 * Scale factor to fit a remote desktop of `display` into a container of
 * `container`, or null when either is not measurable yet.
 *
 * Guarding zero matters: `display.getWidth()` is 0 until the first remote
 * frame arrives, and `container/0` is Infinity — `display.scale(Infinity)`
 * renders the canvas off-screen, which reads as a black screen.
 */
export function fitScale(display, container) {
  const dw = display?.width ?? 0;
  const dh = display?.height ?? 0;
  const cw = container?.width ?? 0;
  const ch = container?.height ?? 0;
  if (!dw || !dh || !cw || !ch) return null;
  const scale = Math.min(cw / dw, ch / dh);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return scale;
}
