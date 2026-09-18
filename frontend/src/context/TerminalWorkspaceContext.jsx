import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  listTerminalSessions,
  duplicateTerminalSession,
  renameTerminalSession,
  closeTerminalSession,
} from '@/services/terminalService';

const STORAGE_KEY = 'shellius.workspace.v1';
const PANE_COUNTS = { single: 1, 'split-right': 2, 'split-down': 2, grid: 4 };

const TerminalWorkspaceContext = createContext(null);

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// Workspace state persists tab metadata (never tickets/secrets) so a reload
// re-attaches every tab and replays recent output. Tabs without a live
// sessionId yet (still connecting when the page unloaded) are dropped.
function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeLayout(layout, fallbackTabId) {
  const mode = layout && PANE_COUNTS[layout.mode] ? layout.mode : 'single';
  const count = PANE_COUNTS[mode];
  const panes = Array.from({ length: count }, (_, i) => layout?.panes?.[i] ?? null);
  if (!panes.some(Boolean) && fallbackTabId) panes[0] = fallbackTabId;
  return { mode, panes };
}

function buildInitialState() {
  const persisted = loadPersisted();
  const tabs = (persisted?.tabs || [])
    .filter((t) => t && t.sessionId)
    .map((t) => ({
      id: t.id || uuid(),
      sessionId: t.sessionId,
      connect: { attach: t.sessionId },
      label: t.label || 'Terminal',
      env: t.env,
      host: t.host,
      username: t.username,
      state: 'connecting',
      error: null,
    }));
  const layout = normalizeLayout(persisted?.layout, tabs[0]?.id);
  const activeTabId = tabs.some((t) => t.id === persisted?.activeTabId) ? persisted.activeTabId : tabs[0]?.id || null;
  return { tabs, layout, activeTabId };
}

export function TerminalWorkspaceProvider({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const onTerminalsPage = location.pathname === '/terminals';

  const initialRef = useRef(null);
  if (!initialRef.current) initialRef.current = buildInitialState();

  const [tabs, setTabs] = useState(initialRef.current.tabs);
  const [layout, setLayoutState] = useState(initialRef.current.layout);
  const [activeTabId, setActiveTabId] = useState(initialRef.current.activeTabId);
  const [focusedPane, setFocusedPane] = useState(0);
  const [liveCount, setLiveCount] = useState(0);

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
        setTabsMirrored((prev) =>
          prev.map((t) =>
            t.sessionId && !liveIds.has(t.sessionId)
              ? { ...t, state: 'ended', error: 'Session ended' }
              : t
          )
        );
      })
      .catch(() => {});
  }, []);

  // Persist (best-effort — never tickets/secrets, only ids + display meta).
  useEffect(() => {
    try {
      const persistTabs = tabs
        .filter((t) => !!t.sessionId)
        .map((t) => ({ id: t.id, sessionId: t.sessionId, label: t.label, env: t.env, host: t.host, username: t.username }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: persistTabs, layout, activeTabId }));
    } catch {
      /* ignore quota/serialization errors — workspace state is best-effort */
    }
  }, [tabs, layout, activeTabId]);

  // Poll the live session list — feeds the Sessions panel + sidebar badge.
  // 15s while the workspace page is open, 60s elsewhere (cheap).
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      listTerminalSessions()
        .then((sessions) => {
          if (!cancelled) setLiveCount(sessions.length);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, onTerminalsPage ? 15000 : 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [onTerminalsPage]);

  const assignToPane = useCallback((tabId, preferredPane) => {
    setLayoutState((prev) => {
      const panes = [...prev.panes];
      if (typeof preferredPane === 'number' && preferredPane < panes.length) {
        panes[preferredPane] = tabId;
        setFocusedPane(preferredPane);
        return { ...prev, panes };
      }
      const emptyIdx = panes.findIndex((p) => !p);
      if (emptyIdx !== -1) {
        panes[emptyIdx] = tabId;
        setFocusedPane(emptyIdx);
      } else {
        panes[0] = tabId;
        setFocusedPane(0);
      }
      return { ...prev, panes };
    });
  }, []);

  const openTab = useCallback(
    (connect, meta = {}) => {
      const { label, env, host, username, focus = true, sessionId = null, pane } = meta;
      const id = uuid();
      setTabsMirrored((prev) => [
        ...prev,
        {
          id,
          sessionId,
          connect,
          label: label || 'Terminal',
          env,
          host,
          username,
          state: 'connecting',
          error: null,
        },
      ]);
      assignToPane(id, pane);
      if (focus) {
        setActiveTabId(id);
        navigate('/terminals');
      }
      return id;
    },
    [assignToPane, navigate]
  );

  const closeTab = useCallback((id, opts = {}) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    setTabsMirrored((prev) => prev.filter((t) => t.id !== id));
    setLayoutState((prev) => ({ ...prev, panes: prev.panes.map((p) => (p === id ? null : p)) }));
    setActiveTabId((prev) => {
      if (prev !== id) return prev;
      const remaining = tabsRef.current.filter((t) => t.id !== id);
      return remaining[remaining.length - 1]?.id || null;
    });
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
      if (!tab?.sessionId) return null;
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
    if (tab?.sessionId) renameTerminalSession(tab.sessionId, label).catch(() => {});
  }, []);

  const splitWith = useCallback((id, direction) => {
    setLayoutState({ mode: direction === 'right' ? 'split-right' : 'split-down', panes: [id, null] });
    setFocusedPane(1);
  }, []);

  const setLayout = useCallback(
    (mode) => {
      setLayoutState((prev) => normalizeLayout({ mode, panes: prev.panes }, activeTabId));
      setFocusedPane(0);
    },
    [activeTabId]
  );

  const assignPane = useCallback((paneIndex, tabId) => {
    setLayoutState((prev) => {
      const panes = [...prev.panes];
      panes[paneIndex] = tabId || null;
      return { ...prev, panes };
    });
  }, []);

  const attachSession = useCallback(
    (sessionId, meta = {}) => {
      const existing = tabsRef.current.find((t) => t.sessionId === sessionId);
      if (existing) {
        setActiveTabId(existing.id);
        assignToPane(existing.id);
        navigate('/terminals');
        return existing.id;
      }
      return openTab({ attach: sessionId }, { ...meta, sessionId, focus: true });
    },
    [openTab, assignToPane, navigate]
  );

  // Called by TerminalView (via the pane wrapper) once the socket reports
  // session metadata (`connected` / `attached` control frames).
  const setTabSessionInfo = useCallback((id, info) => {
    if (!info) return;
    setTabsMirrored((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        return {
          ...t,
          sessionId: info.sessionId || t.sessionId,
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
        if (state === 'ended') return { ...t, state, error: extra ? `Session ended (${extra})` : 'Session ended' };
        return { ...t, state, error: null };
      })
    );
  }, []);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) || null, [tabs, activeTabId]);

  const value = useMemo(
    () => ({
      tabs,
      layout,
      activeTabId,
      activeTab,
      focusedPane,
      liveCount,
      setActiveTabId,
      setFocusedPane,
      openTab,
      closeTab,
      closeOthers,
      duplicateTab,
      renameTab,
      splitWith,
      setLayout,
      assignPane,
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
      liveCount,
      openTab,
      closeTab,
      closeOthers,
      duplicateTab,
      renameTab,
      splitWith,
      setLayout,
      assignPane,
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
