import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import {
  listTerminalSessions,
  duplicateTerminalSession,
  renameTerminalSession,
  closeTerminalSession,
} from '@/services/terminalService';
import * as L from '@/lib/workspaceLayout';
import { RDP, findRdpConflict, isRdpTab } from '@/lib/rdpPanes';

// v2: layout is per split group (see lib/workspaceLayout.js). v1 had a single
// global layout and is migrated on load. Stored per user (`:<userId>`), so a
// different person signing in on the same browser never inherits tabs.
const STORAGE_PREFIX = 'shellius.workspace.v2';
const UNSCOPED_KEYS = ['shellius.workspace.v2', 'shellius.workspace.v1'];
const storageKey = (userId) => `${STORAGE_PREFIX}:${userId || 'anon'}`;

const TerminalWorkspaceContext = createContext(null);

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// Workspace state persists tab metadata (never tickets/secrets) so a reload
// re-attaches every tab and replays recent output. Tabs without a live
// sessionId yet (still connecting when the page unloaded) are dropped.
function loadPersisted(userId) {
  try {
    const own = localStorage.getItem(storageKey(userId));
    if (own) {
      const parsed = JSON.parse(own);
      if (parsed && Array.isArray(parsed.tabs)) return parsed;
    }
    // One-time pickup of the old, unscoped keys (pre per-user storage).
    for (const key of UNSCOPED_KEYS) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      localStorage.removeItem(key);
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.tabs)) continue;
      if (parsed.layout) {
        const migrated = L.migrateLegacyLayout(parsed.layout, parsed.activeTabId);
        return { tabs: parsed.tabs, groups: migrated.groups, activeTabId: migrated.activeTabId };
      }
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function buildInitialState(userId) {
  const persisted = loadPersisted(userId);
  const tabs = (persisted?.tabs || [])
    .filter(
      (t) =>
        t &&
        (t.sessionId ||
          (t.kind === 'request' && t.accessRequestId) ||
          // RDP tabs never carry a sessionId: guacamole-lite sessions are not
          // in the SSH hub, so there is nothing to attach to. They are kept
          // anyway so the tab survives a reload, and reopen NOT connected.
          (t.protocol === RDP && t.accessRequestId))
    )
    .map((t) => {
      if (t.protocol === RDP) {
        return {
          id: t.id || uuid(),
          kind: 'terminal',
          protocol: RDP,
          accessRequestId: t.accessRequestId,
          serverId: t.serverId || null,
          sessionId: null,
          connect: { requestId: t.accessRequestId },
          label: t.label || 'Remote desktop',
          env: t.env,
          host: t.host,
          username: t.username,
          // Deliberately not auto-reconnected. An RDP connect is a fresh
          // Windows logon, and Windows evicts the previous one — a reload
          // would silently kick a session the same user may still have open
          // in another window. The pane shows a Connect button instead.
          autoConnect: false,
          state: 'ended',
          endReason: 'reload',
          error: null,
        };
      }
      return t.kind === 'request'
        ? {
            id: t.id || uuid(),
            kind: 'request',
            accessRequestId: t.accessRequestId,
            connect: null,
            sessionId: null,
            label: t.label || 'Access request',
            env: t.env,
            host: t.host,
            username: t.username,
            state: 'pending',
            error: null,
          }
        : {
            id: t.id || uuid(),
            kind: 'terminal',
            sessionId: t.sessionId,
            connect: { attach: t.sessionId },
            label: t.label || 'Terminal',
            env: t.env,
            host: t.host,
            username: t.username,
            state: 'connecting',
            error: null,
          };
    });
  const ws = L.sanitize(
    { groups: persisted?.groups || [], activeTabId: persisted?.activeTabId },
    tabs.map((t) => t.id)
  );
  return { tabs, ws };
}

export function TerminalWorkspaceProvider({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const onTerminalsPage = location.pathname === '/terminals';

  const { user } = useAuth();
  const userId = user?.id || null;
  const initialRef = useRef(null);
  if (!initialRef.current) initialRef.current = buildInitialState(userId);

  const [tabs, setTabs] = useState(initialRef.current.tabs);
  // { groups, activeTabId } — split groups + the tab on screen. The visible
  // layout is derived from these (L.currentView), so each split belongs to
  // its tabs instead of being one global layout.
  const [ws, setWs] = useState(initialRef.current.ws);
  const { activeTabId } = ws;
  const [liveCount, setLiveCount] = useState(0);
  // Ephemeral (not persisted) — the tab id currently being dragged, so the
  // pane-area drop overlay can show its label without relying on
  // dataTransfer.getData() during dragover (most browsers only expose that
  // on `drop`, not `dragover`).
  const [draggedTabId, setDraggedTabId] = useState(null);

  // tabsRef mirrors `tabs` synchronously (not via a useEffect, which only
  // runs after commit) — callers like duplicateTab/closeTab read tabsRef
  // immediately after calling another tab-mutating function in the same
  // event handler tick (e.g. SessionsPanel's attach-then-duplicate), before
  // React would otherwise have re-rendered. React 18 runs a setState
  // updater function synchronously to compute pending state even though the
  // commit itself is batched, so mirroring inside every updater is safe.
  const tabsRef = useRef(tabs);
  const setTabsMirrored = useCallback((updater) => {
    setTabs((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      tabsRef.current = next;
      return next;
    });
  }, []);

  const prunedRef = useRef(false);
  useEffect(() => {
    if (prunedRef.current) return;
    prunedRef.current = true;
    if (tabsRef.current.length === 0) return;
    listTerminalSessions()
      .then((sessions) => {
        const liveIds = new Set(sessions.map((s) => s.id));
        // Restored tabs whose session is gone (backend restarted, detach
        // timeout…) don't try to attach at all. They open straight on the
        // recovery card (SessionRecoveryCard) instead of a failing connect.
        setTabsMirrored((prev) =>
          prev.map((t) =>
            t.kind !== 'request' && !isRdpTab(t) && t.sessionId && !liveIds.has(t.sessionId)
              ? { ...t, state: 'lost', endReason: 'not_found', skipConnect: true, error: null }
              : t
          )
        );
      })
      .catch(() => {
        // Backend unreachable right now: tabs attach normally, and TerminalView
        // keeps retrying until it's back (or reports the session lost).
      });
  }, []);

  // Persist (best-effort — never tickets/secrets, only ids + display meta).
  // Request tabs persist their accessRequestId (not a secret — same as a
  // sessionId, just a row id) so a reload keeps the status card in place.
  useEffect(() => {
    try {
      const persistTabs = tabs
        .filter(
          (t) =>
            !!t.sessionId ||
            (t.kind === 'request' && !!t.accessRequestId) ||
            (isRdpTab(t) && !!t.accessRequestId)
        )
        .map((t) => ({
          id: t.id,
          kind: t.kind === 'request' ? 'request' : 'terminal',
          protocol: t.protocol,
          sessionId: t.sessionId,
          accessRequestId: t.accessRequestId,
          serverId: t.serverId,
          label: t.label,
          env: t.env,
          host: t.host,
          username: t.username,
        }));
      localStorage.setItem(storageKey(userId), JSON.stringify({ tabs: persistTabs, groups: ws.groups, activeTabId: ws.activeTabId }));
    } catch {
      /* ignore quota/serialization errors — workspace state is best-effort */
    }
  }, [tabs, ws, userId]);

  // Poll the live session list — feeds the Sessions panel + sidebar badge.
  // 15s while the workspace page is open, 60s elsewhere (cheap).
  const [liveSessions, setLiveSessions] = useState([]);
  const pollRef = useRef(() => {});
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      listTerminalSessions()
        .then((sessions) => {
          if (cancelled) return;
          setLiveCount(sessions.length);
          setLiveSessions(sessions);
        })
        .catch(() => {});
    };
    pollRef.current = poll;
    poll();
    const id = setInterval(poll, onTerminalsPage ? 15000 : 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [onTerminalsPage]);
  const refreshLiveSessions = useCallback(() => pollRef.current(), []);

  // Show a tab: its split if it's in one, otherwise full size.
  // `fillEmptyPane` (tab-bar clicks): a focused empty pane in the split on
  // screen takes the tab instead.
  const selectTab = useCallback((id, opts) => {
    setWs((prev) => L.selectTab(prev, id, opts));
  }, []);

  const openTab = useCallback(
    (connect, meta = {}) => {
      // New tabs open full size (their own view), unless the split on screen
      // has a focused empty pane waiting for a tab. See lib/workspaceLayout.js.
      const {
        label,
        env,
        host,
        username,
        focus = true,
        sessionId = null,
        pane,
        protocol,
        serverId = null,
        accessRequestId = null,
        autoConnect = true,
      } = meta;
      const id = uuid();
      setTabsMirrored((prev) => [
        ...prev,
        {
          id,
          kind: 'terminal',
          protocol: protocol === RDP ? RDP : undefined,
          sessionId,
          connect,
          label: label || 'Terminal',
          env,
          host,
          username,
          serverId,
          accessRequestId,
          autoConnect,
          state: 'connecting',
          error: null,
        },
      ]);
      setWs((prev) =>
        typeof pane === 'number' ? L.placeInPane(L.addTab(prev, id, { focus: false }), id, pane) : L.addTab(prev, id, { focus })
      );
      if (focus) navigate('/terminals');
      return id;
    },
    [navigate]
  );

  /**
   * Open an approved RDP access request in a workspace pane.
   *
   * Windows Server permits ONE interactive session per user account, and every
   * Shellius RDP connection to a given server signs in as that server's
   * configured RDP account (backend resolveRdpCredentials). A second pane onto
   * the same server is therefore a second logon as the SAME Windows user, and
   * Windows evicts the first with "Disconnected by other connection" — the
   * exact failure the runIdRef guard in RdpTerminal exists to prevent. So we
   * do not open one: the existing tab is brought to the front instead.
   *
   * Two panes onto the same server as two *different*, known Windows accounts
   * are allowed, because those are two separate Windows sessions.
   *
   * @returns {{ id: string, conflict: object|null }} `conflict` is the tab that
   *   was focused instead of opening a new one.
   */
  const openRdpTab = useCallback(
    ({ requestId, serverId, username }, meta = {}) => {
      const conflict = findRdpConflict(tabsRef.current, { serverId, username });
      if (conflict) {
        selectTab(conflict.id);
        if (meta.focus !== false) navigate('/terminals');
        return { id: conflict.id, conflict };
      }
      const id = openTab(
        { requestId },
        {
          ...meta,
          protocol: RDP,
          serverId: serverId || null,
          accessRequestId: requestId,
          username,
          label: meta.label || 'Remote desktop',
        }
      );
      return { id, conflict: null };
    },
    [openTab, selectTab, navigate]
  );

  // Opens a status-card tab bound to an access request (pending/denied/
  // expired/approved-not-yet-connected). Used by NewConnectionDialog after
  // RequestForm submits, and to focus an existing "Pending" row's tab.
  const openRequestTab = useCallback(
    (accessRequest, meta = {}) => {
      const existing = tabsRef.current.find((t) => t.kind === 'request' && t.accessRequestId === accessRequest.id);
      if (existing) {
        selectTab(existing.id);
        navigate('/terminals');
        return existing.id;
      }
      const id = uuid();
      const label = meta.label || accessRequest.server?.displayName || accessRequest.server?.hostname || 'Access request';
      setTabsMirrored((prev) => [
        ...prev,
        {
          id,
          kind: 'request',
          accessRequestId: accessRequest.id,
          connect: null,
          sessionId: null,
          label,
          env: meta.env || accessRequest.server?.environment,
          host: meta.host,
          username: meta.username,
          state: 'pending',
          error: null,
        },
      ]);
      setWs((prev) => L.addTab(prev, id, { focus: meta.focus !== false }));
      if (meta.focus !== false) navigate('/terminals');
      return id;
    },
    [selectTab, navigate]
  );

  // Converts a request tab into a terminal tab in place (same id/pane slot)
  // once the request is APPROVED and the user hits Connect. `connect` is the
  // usual TerminalView spec, e.g. { requestId }.
  const convertRequestTabToTerminal = useCallback((id, connect, meta = {}) => {
    // An approved RDP request auto-connects when its tab is on screen. If a
    // pane onto the same server + Windows account is already live, converting
    // would open a second logon and Windows would evict the first, so show
    // the live one instead and leave this tab as a status card.
    if (meta.protocol === RDP) {
      const conflict = findRdpConflict(
        tabsRef.current,
        { serverId: meta.serverId, username: meta.username },
        { excludeTabId: id }
      );
      if (conflict) {
        setWs((prev) => L.selectTab(prev, conflict.id));
        return;
      }
    }
    setTabsMirrored((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              kind: 'terminal',
              protocol: meta.protocol === RDP ? RDP : undefined,
              connect,
              sessionId: null,
              serverId: meta.serverId ?? t.serverId ?? null,
              accessRequestId: meta.protocol === RDP ? connect?.requestId : undefined,
              username: meta.username ?? t.username,
              autoConnect: true,
              state: 'connecting',
              error: null,
              label: meta.label || t.label,
              env: meta.env || t.env,
            }
          : t
      )
    );
  }, []);

  // Recovery: give an existing tab a new connect spec (Reconnect / Retry /
  // Quick Connect again) so it keeps its place in the tab bar and its split.
  // `retry` forces TerminalView to reconnect even for the same spec.
  const reconnectTab = useCallback((id, connect, meta = {}) => {
    setTabsMirrored((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              kind: 'terminal',
              accessRequestId: isRdpTab(t) ? connect?.requestId ?? t.accessRequestId : undefined,
              autoConnect: true,
              connect: { ...connect, retry: Date.now() },
              sessionId: null,
              state: 'connecting',
              error: null,
              endReason: null,
              skipConnect: false,
              label: meta.label || t.label,
              env: meta.env || t.env,
              host: meta.host || t.host,
              username: meta.username || t.username,
            }
          : t
      )
    );
    setWs((prev) => L.selectTab(prev, id));
  }, []);

  // Recovery: turn a terminal tab into an access-request status tab in place
  // (a new request is pending approval).
  const convertTabToRequest = useCallback((id, accessRequest, meta = {}) => {
    setTabsMirrored((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              kind: 'request',
              accessRequestId: accessRequest.id,
              connect: null,
              sessionId: null,
              state: 'pending',
              error: null,
              endReason: null,
              skipConnect: false,
              label: meta.label || t.label,
              env: meta.env || accessRequest.server?.environment || t.env,
            }
          : t
      )
    );
    setWs((prev) => L.selectTab(prev, id));
  }, []);

  // Shared entry point for "an access request was just created/resolved" —
  // used by NewConnectionDialog and RequestStatusCard's "Request again".
  // Auto-approved (non-prod / admin bypass) requests skip the status card
  // and open a terminal tab immediately; everything else gets a status tab.
  const openTabForAccessRequest = useCallback(
    (accessRequest, meta = {}) => {
      if (accessRequest.status === 'APPROVED') {
        const label =
          meta.label || accessRequest.server?.displayName || accessRequest.server?.hostname;
        const env = meta.env || accessRequest.server?.environment;
        if (accessRequest.protocol === RDP) {
          return openRdpTab(
            {
              requestId: accessRequest.id,
              serverId: accessRequest.server?.id || accessRequest.serverId || null,
              username: accessRequest.requestedPrincipal || meta.username,
            },
            { label, env, focus: meta.focus }
          ).id;
        }
        return openTab({ requestId: accessRequest.id }, { label, env, focus: meta.focus });
      }
      return openRequestTab(accessRequest, meta);
    },
    [openTab, openRdpTab, openRequestTab]
  );

  // Reorders tabs (drag in the tab bar, or Alt+Shift+Left/Right). Layout
  // (pane assignments) references tab ids, not positions, so no pane update
  // is needed — order only affects the tab bar and Alt+Tab/Alt+N cycling.
  const moveTab = useCallback((fromIndex, toIndex) => {
    setTabsMirrored((prev) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex >= prev.length
      ) {
        return prev;
      }
      const next = prev.slice();
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const closeTab = useCallback((id, opts = {}) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    const remaining = tabsRef.current.filter((t) => t.id !== id).map((t) => t.id);
    setTabsMirrored((prev) => prev.filter((t) => t.id !== id));
    setWs((prev) => L.removeTab(prev, id, remaining));
    if (opts.end && tab?.sessionId) {
      closeTerminalSession(tab.sessionId).catch(() => {});
    }
  }, []);

  const closeOthers = useCallback(
    (id) => {
      tabsRef.current.filter((t) => t.id !== id).forEach((t) => closeTab(t.id));
    },
    [closeTab]
  );

  const duplicateTab = useCallback(
    async (id) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      // An RDP tab has no hub session, and a second pane to the same Windows
      // account would evict this one. tabCapabilities() hides the menu item;
      // this is the guard behind it.
      if (isRdpTab(tab) || !tab?.sessionId) return null;
      const result = await duplicateTerminalSession(tab.sessionId);
      const connect = result?.connect || result;
      return openTab(connect, {
        label: tab.label ? `${tab.label} (copy)` : undefined,
        env: tab.env,
        host: tab.host,
        username: tab.username,
        focus: true,
      });
    },
    [openTab]
  );

  const renameTab = useCallback((id, label) => {
    setTabsMirrored((prev) => prev.map((t) => (t.id === id ? { ...t, label } : t)));
    const tab = tabsRef.current.find((t) => t.id === id);
    if (tab?.sessionId && !isRdpTab(tab)) renameTerminalSession(tab.sessionId, label).catch(() => {});
  }, []);

  // Everything below acts on the split on screen only (see lib/workspaceLayout.js
  // for the exact rules, and workspaceLayout.test.js for the scenarios).
  const splitWith = useCallback((id, direction) => {
    setWs((prev) => L.splitWith(prev, id, direction));
  }, []);

  const setLayout = useCallback((mode) => {
    setWs((prev) => L.setLayoutMode(prev, mode));
  }, []);

  // Put a tab into a pane of the split on screen (null = close that pane;
  // its tab stays open as a standalone tab).
  const assignPane = useCallback((paneIndex, tabId) => {
    setWs((prev) => L.placeInPane(prev, tabId || null, paneIndex));
  }, []);

  // Workspaces = split groups shown as one tab in the tab bar.
  const renameWorkspace = useCallback((groupId, name) => {
    setWs((prev) => L.renameGroup(prev, groupId, name));
  }, []);
  const ungroupWorkspace = useCallback((groupId) => {
    setWs((prev) => L.ungroup(prev, groupId));
  }, []);
  // Reorder a whole workspace in the tab bar: its members move as one block.
  const moveWorkspace = useCallback((memberIds, toTabIndex) => {
    setTabsMirrored((prev) => L.moveBlock(prev, memberIds, toTabIndex));
  }, []);

  const removeFromSplit = useCallback((tabId) => {
    setWs((prev) => L.removeFromSplit(prev, tabId));
  }, []);

  const setFocusedPane = useCallback((paneIndex) => {
    setWs((prev) => L.focusPane(prev, paneIndex));
  }, []);

  // Drag a tab from the tab bar onto the pane area. `zone`: 'left' | 'right'
  // | 'top' | 'bottom' | 'center', from the pointer position in the pane.
  const dropTabOnPane = useCallback((tabId, paneIndex, zone) => {
    setWs((prev) => L.dropTab(prev, tabId, paneIndex, zone));
  }, []);

  const attachSession = useCallback(
    (sessionId, meta = {}) => {
      const focus = meta.focus !== false;
      const existing = tabsRef.current.find((t) => t.sessionId === sessionId);
      if (existing) {
        if (focus) {
          selectTab(existing.id);
          navigate('/terminals');
        }
        return existing.id;
      }
      return openTab({ attach: sessionId }, { ...meta, sessionId, focus });
    },
    [openTab, selectTab, navigate]
  );

  // Called by TerminalView (via the pane wrapper) once the socket reports
  // session metadata (`connected` / `attached` control frames).
  const setTabSessionInfo = useCallback((id, info) => {
    if (!info) return;
    setTabsMirrored((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const sessionId = info.sessionId || t.sessionId;
        return {
          ...t,
          sessionId,
          // From now on this tab resumes by attaching to its own session: a
          // Quick Connect ticket is single-use, and re-using an access request
          // would silently open a second SSH session.
          connect: sessionId ? { attach: sessionId } : t.connect,
          host: info.host ?? t.host,
          port: info.port ?? t.port,
          username: info.username ?? t.username,
          authMethod: info.authMethod ?? t.authMethod,
        };
      })
    );
  }, []);

  const setTabState = useCallback((id, state, extra) => {
    setTabsMirrored((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if (state === 'error') return { ...t, state, error: extra || t.error || 'Connection error' };
        if (state === 'ended' || state === 'lost') return { ...t, state, endReason: extra || null, error: null };
        return { ...t, state, error: null, endReason: null };
      })
    );
  }, []);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) || null, [tabs, activeTabId]);

  // The layout on screen, in the shape the pane area has always consumed.
  const view = useMemo(() => L.currentView(ws), [ws]);
  const layout = useMemo(() => ({ id: view.group?.id || null, mode: view.mode, panes: view.panes }), [view]);
  const focusedPane = view.focusedPane;
  // tabId → { groupId, mode, onScreen } for the tab bar's split indicators.
  const splitInfo = useMemo(() => {
    const map = new Map();
    for (const g of ws.groups) {
      if (g.panes.filter(Boolean).length < 2) continue;
      for (const id of g.panes) if (id) map.set(id, { groupId: g.id, mode: g.mode, onScreen: g.id === view.group?.id });
    }
    return map;
  }, [ws.groups, view]);

  const value = useMemo(
    () => ({
      tabs,
      layout,
      activeTabId,
      activeTab,
      focusedPane,
      splitInfo,
      liveCount,
      liveSessions,
      refreshLiveSessions,
      reconnectTab,
      convertTabToRequest,
      draggedTabId,
      setDraggedTabId,
      selectTab,
      // Kept for existing callers: selecting is the only way to change the active tab.
      setActiveTabId: selectTab,
      setFocusedPane,
      openTab,
      openRdpTab,
      openRequestTab,
      openTabForAccessRequest,
      convertRequestTabToTerminal,
      closeTab,
      closeOthers,
      duplicateTab,
      renameTab,
      splitWith,
      removeFromSplit,
      groups: ws.groups,
      renameWorkspace,
      ungroupWorkspace,
      moveWorkspace,
      setLayout,
      assignPane,
      moveTab,
      dropTabOnPane,
      attachSession,
      setTabSessionInfo,
      setTabState,
    }),
    [
      tabs,
      layout,
      activeTabId,
      activeTab,
      focusedPane,
      splitInfo,
      liveCount,
      liveSessions,
      refreshLiveSessions,
      reconnectTab,
      convertTabToRequest,
      draggedTabId,
      selectTab,
      setFocusedPane,
      openTab,
      openRdpTab,
      openRequestTab,
      openTabForAccessRequest,
      convertRequestTabToTerminal,
      closeTab,
      closeOthers,
      duplicateTab,
      renameTab,
      splitWith,
      removeFromSplit,
      ws.groups,
      renameWorkspace,
      ungroupWorkspace,
      moveWorkspace,
      setLayout,
      assignPane,
      moveTab,
      dropTabOnPane,
      attachSession,
      setTabSessionInfo,
      setTabState,
    ]
  );

  return <TerminalWorkspaceContext.Provider value={value}>{children}</TerminalWorkspaceContext.Provider>;
}

export function useTerminalWorkspace() {
  const ctx = useContext(TerminalWorkspaceContext);
  if (!ctx) throw new Error('useTerminalWorkspace must be used within a TerminalWorkspaceProvider');
  return ctx;
}

export default TerminalWorkspaceContext;
