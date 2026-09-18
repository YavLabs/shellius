import { useCallback, useEffect, useState } from 'react';
import { SquareTerminal, Zap, Plus } from 'lucide-react';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import TerminalTabBar from '@/components/workspace/TerminalTabBar';
import TerminalPaneArea from '@/components/workspace/TerminalPaneArea';
import SessionsPanel from '@/components/workspace/SessionsPanel';
import NewConnectionDialog from '@/components/workspace/NewConnectionDialog';
import RunningSessionsList from '@/components/workspace/RunningSessionsList';
import { barItems, itemTabId } from '@/lib/workspaceLayout';
import DisconnectedBanner from '@/components/workspace/DisconnectedBanner';
import { getHistory, reconnectHistory } from '@/services/quickConnectService';

function EmptyState({ onNewConnection }) {
  const { allowed, openQuickConnect } = useQuickConnect();
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    getHistory({ limit: 5 })
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  const { openTab, refreshLiveSessions } = useTerminalWorkspace();
  useEffect(() => {
    refreshLiveSessions();
  }, [refreshLiveSessions]);

  const reconnect = async (item) => {
    if (item.authType !== 'credential') {
      openQuickConnect({ host: item.host, port: item.port, username: item.username, authTab: item.authType === 'key' ? 'key' : 'password' });
      return;
    }
    try {
      const resp = await reconnectHistory(item.id);
      openTab({ ticket: resp.ticket }, { label: `${item.username || 'user'}@${item.host}`, host: item.host, username: item.username });
    } catch {
      openQuickConnect({ host: item.host, port: item.port, username: item.username, authTab: 'credential' });
    }
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <SquareTerminal className="h-10 w-10 text-muted-foreground/40" />
      <div>
        <p className="text-sm font-medium text-foreground">No open terminals</p>
        <p className="mt-1 text-xs text-muted-foreground">Open a server connection or start a Quick Connect.</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onNewConnection}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" /> New connection
        </button>
        {allowed && (
          <button
            type="button"
            onClick={() => openQuickConnect()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground hover:bg-accent"
          >
            <Zap className="h-3.5 w-3.5" /> Quick Connect
          </button>
        )}
      </div>

      {/* Live sessions not open in any tab (detached after closing a tab, a
          reload, or another window). */}
      <RunningSessionsList className="mt-4 w-full max-w-md" />

      {recent.length > 0 && (
        <div className="mt-4 w-full max-w-md text-left">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent Quick Connects
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {recent.map((item) => (
              <li key={item.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {item.username}@{item.host}
                </span>
                <button
                  type="button"
                  onClick={() => reconnect(item)}
                  className="text-[11px] font-medium text-primary hover:underline"
                >
                  Connect
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Terminals — the in-app terminal workspace (`/terminals`). Tab bar +
 * layout toolbar + pane area + collapsible sessions panel. Fills the height
 * below the topbar (AppLayout skips its scroll container for this route).
 */
function Terminals() {
  const workspace = useTerminalWorkspace();
  const [newConnOpen, setNewConnOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  const { tabs, activeTabId, selectTab, closeTab } = workspace;

  useEffect(() => {
    if (!activeTabId && tabs.length > 0) selectTab(tabs[tabs.length - 1].id);
  }, [activeTabId, tabs, selectTab]);

  // A click in the tab bar shows that tab, either its own split or full
  // size. The exception is when the split on screen has a focused empty
  // pane: then the clicked tab fills it. Keyboard cycling (below) only ever
  // switches tabs.
  const clickTab = useCallback((id) => selectTab(id, { fillEmptyPane: true }), [selectTab]);

  // Workspace keyboard shortcuts — only active on this page, and only when
  // xterm isn't swallowing the keys (see TerminalView's
  // attachCustomKeyEventHandler, which lets these bubble here).
  useEffect(() => {
    const handler = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        setNewConnOpen(true);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
        return;
      }
      // Cycling / Alt+N follow the tab bar: a workspace counts as one item.
      const items = barItems(tabs, workspace.groups || []);
      const activeIdx = items.findIndex((it) =>
        it.type === 'tab' ? it.tab.id === activeTabId : it.tabs.some((t) => t.id === activeTabId)
      );
      if (mod && e.key === 'Tab') {
        e.preventDefault();
        if (items.length < 2) return;
        const next = e.shiftKey ? (activeIdx - 1 + items.length) % items.length : (activeIdx + 1) % items.length;
        selectTab(itemTabId(items[next]));
        return;
      }
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        const item = items[Number(e.key) - 1];
        if (item) {
          e.preventDefault();
          selectTab(itemTabId(item));
        }
        return;
      }
      // Keyboard alternative to drag-reordering: Alt+Shift+Left/Right moves
      // the active tab one slot in the tab bar.
      if (e.altKey && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (activeIdx === -1) return;
        const to = e.key === 'ArrowLeft' ? activeIdx - 1 : activeIdx + 1;
        if (to < 0 || to >= items.length) return;
        const ids = (it) => (it.type === 'tab' ? [it.tab.id] : it.tabs.map((t) => t.id));
        const block = ids(items[activeIdx]);
        const rest = tabs.filter((t) => !block.includes(t.id));
        // Moving left: go before the neighbour; right: after it.
        const neighbour = ids(items[to]);
        const at = e.key === 'ArrowLeft'
          ? rest.findIndex((t) => t.id === neighbour[0])
          : rest.findIndex((t) => t.id === neighbour[neighbour.length - 1]) + 1;
        workspace.moveWorkspace(block, at);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, activeTabId, closeTab, selectTab, workspace]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TerminalTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={clickTab}
        workspace={workspace}
        onNewConnection={() => setNewConnOpen(true)}
        sessionsOpen={sessionsOpen}
        onToggleSessions={() => setSessionsOpen((v) => !v)}
      />

      <DisconnectedBanner workspace={workspace} />

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {tabs.length === 0 ? (
            <EmptyState onNewConnection={() => setNewConnOpen(true)} />
          ) : (
            <TerminalPaneArea workspace={workspace} />
          )}
        </div>
        {sessionsOpen && <SessionsPanel workspace={workspace} onClose={() => setSessionsOpen(false)} onNewConnection={() => setNewConnOpen(true)} />}
      </div>

      <NewConnectionDialog open={newConnOpen} onClose={() => setNewConnOpen(false)} />
    </div>
  );
}

export default Terminals;
