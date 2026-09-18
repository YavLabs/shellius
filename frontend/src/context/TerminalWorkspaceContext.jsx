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
    .filter((t) => t && (t.sessionId || (t.kind === 'request' && t.accessRequestId)))
    .map((t) =>
      t.kind === 'request'
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
          }
    );
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
        setTabsMirrored((prev) =>
          prev.map((t) =>
            t.kind !== 'request' && t.sessionId && !liveIds.has(t.sessionId)
              ? { ...t, state: 'ended', error: 'Session ended' }
              : t
          )
        );
      })
      .catch(() => {});
  }, []);

  // Persist (best-effort — never tickets/secrets, only ids + display meta).
  // Request tabs persist their accessRequestId (not a secret — same as a
  // sessionId, just a row id) so a reload keeps the status card in place.
  useEffect(() => {
    try {
      const persistTabs = tabs
        .filter((t) => !!t.sessionId || (t.kind === 'request' && !!t.accessRequestId))
        .map((t) => ({
          id: t.id,
          kind: t.kind === 'request' ? 'request' : 'terminal',
          sessionId: t.sessionId,
          accessRequestId: t.accessRequestId,
          label: t.label,
          env: t.env,
          host: t.host,
          username: t.username,
        }));
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
          kind: 'terminal',
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

  // Opens a status-card tab bound to an access request (pending/denied/
  // expired/approved-not-yet-connected). Used by NewConnectionDialog after
  // RequestForm submits, and to focus an existing "Pending" row's tab.
  const openRequestTab = useCallback(
    (accessRequest, meta = {}) => {
      const existing = tabsRef.current.find((t) => t.kind === 'request' && t.accessRequestId === accessRequest.id);
      if (existing) {
        setActiveTabId(existing.id);
        assignToPane(existing.id, meta.pane);
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
      assignToPane(id, meta.pane);
      if (meta.focus !== false) {
        setActiveTabId(id);
        navigate('/terminals');
      }
      return id;
    },
    [assignToPane, navigate]
  );

  // Converts a request tab into a terminal tab in place (same id/pane slot)
  // once the request is APPROVED and the user hits Connect. `connect` is the
  // usual TerminalView spec, e.g. { requestId }.
  const convertRequestTabToTerminal = useCallback((id, connect, meta = {}) => {
    setTabsMirrored((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              kind: 'terminal',
              connect,
              sessionId: null,
              state: 'connecting',
              error: null,
              label: meta.label || t.label,
              env: meta.env || t.env,
            }
          : t
      )
    );
  }, []);

  // Shared entry point for "an access request was just created/resolved" —
  // used by NewConnectionDialog and RequestStatusCard's "Request again".
  // Auto-approved (non-prod / admin bypass) requests skip the status card
  // and open a terminal tab immediately; everything else gets a status tab.
  const openTabForAccessRequest = useCallback(
    (accessRequest, meta = {}) => {
      if (accessRequest.status === 'APPROVED') {
        return openTab(
          { requestId: accessRequest.id },
          {
            label: meta.label || accessRequest.server?.displayName || accessRequest.server?.hostname,
            env: meta.env || accessRequest.server?.environment,
            focus: meta.focus,
          }
        );
      }
      return openRequestTab(accessRequest, meta);
    },
    [openTab, openRequestTab]
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

  /**
   * dropTabOnPane — Termius-style drag-a-tab-onto-the-pane-area split.
   * `zone` is one of 'left' | 'right' | 'top' | 'bottom' | 'center', computed
   * by the drop target from pointer position within the hovered pane's box.
   *
   * Rules (documented here since they're not obvious from the code):
   *  - single pane: left/right → split-right (dragged tab goes to the side
   *    dropped on, existing tab takes the other side); top/bottom →
   *    split-down, same idea; centre → replace (stay single-pane).
   *  - 2-pane layout (split-right/split-down), same-axis zone (e.g.
   *    left/right while already split-right) or centre → replace the
   *    hovered pane's tab (there's no 3rd column/row to add on that axis).
   *  - 2-pane layout, cross-axis zone (e.g. top/bottom while split-right) →
   *    promotes to a 2x2 grid. The hovered pane's column/row is split into
   *    two (existing tab + dragged tab, ordered by which half was dropped
   *    on); the *other* existing pane keeps its tab in the first row/column
   *    of its own column/row and the newly-exposed 4th slot is left empty
   *    (a tab can only occupy one slot, so a 3-tab drop can't fill all 4).
   *  - grid (4 panes, already maxed out): any zone (including edges) simply
   *    replaces the hovered pane's tab — there's no 5th slot to expand into.
   */
  const dropTabOnPane = useCallback((tabId, paneIndex, zone) => {
    setLayoutState((prev) => {
      const mode = prev.mode;
      const panes = [...prev.panes];

      if (mode === 'grid' || zone === 'center') {
        panes[paneIndex] = tabId;
        return { ...prev, panes };
      }

      if (mode === 'single') {
        const current = panes[0];
        if (zone === 'right') return { mode: 'split-right', panes: [current, tabId] };
        if (zone === 'left') return { mode: 'split-right', panes: [tabId, current] };
        if (zone === 'bottom') return { mode: 'split-down', panes: [current, tabId] };
        if (zone === 'top') return { mode: 'split-down', panes: [tabId, current] };
        return prev;
      }

      const sameAxis =
        (mode === 'split-right' && (zone === 'left' || zone === 'right')) ||
        (mode === 'split-down' && (zone === 'top' || zone === 'bottom'));
      if (sameAxis) {
        panes[paneIndex] = tabId;
        return { ...prev, panes };
      }

      // Cross-axis on a 2-pane layout → promote to a 2x2 grid (see comment above).
      const otherIndex = paneIndex === 0 ? 1 : 0;
      const hovered = panes[paneIndex];
      const other = panes[otherIndex];
      const grid = [null, null, null, null];
      if (mode === 'split-right') {
        const col = paneIndex;
        const otherCol = otherIndex;
        if (zone === 'bottom') {
          grid[col] = hovered;
          grid[2 + col] = tabId;
        } else {
          grid[col] = tabId;
          grid[2 + col] = hovered;
        }
        grid[otherCol] = other;
      } else {
        const row = paneIndex;
        const otherRow = otherIndex;
        if (zone === 'right') {
          grid[row * 2] = hovered;
          grid[row * 2 + 1] = tabId;
        } else {
          grid[row * 2] = tabId;
          grid[row * 2 + 1] = hovered;
        }
        grid[otherRow * 2] = other;
      }
      return { mode: 'grid', panes: grid };
    });
    setFocusedPane(paneIndex);
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
      draggedTabId,
      setDraggedTabId,
      setActiveTabId,
      setFocusedPane,
      openTab,
      openRequestTab,
      openTabForAccessRequest,
      convertRequestTabToTerminal,
      closeTab,
      closeOthers,
      duplicateTab,
      renameTab,
      splitWith,
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
      liveCount,
      draggedTabId,
      openTab,
      openRequestTab,
      openTabForAccessRequest,
      convertRequestTabToTerminal,
      closeTab,
      closeOthers,
      duplicateTab,
      renameTab,
      splitWith,
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
