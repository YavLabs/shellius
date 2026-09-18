import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  X,
  MoreHorizontal,
  Pencil,
  Copy,
  SplitSquareHorizontal,
  SplitSquareVertical,
  ExternalLink,
  Square,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { cn } from '@/lib/utils';

const STATUS_DOT = {
  connecting: 'bg-amber-500 animate-pulse',
  live: 'bg-emerald-500',
  detached: 'bg-muted-foreground/60',
  ended: 'bg-red-500',
  error: 'bg-red-500',
};

function TabItem({ tab, active, onSelect, onClose, onContextMenu, menu }) {
  const [renaming, setRenaming] = useState(false);
  // Right-click opens the same menu as the ⋯ button (controlled dropdown).
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState(tab.label);
  const inputRef = useRef(null);

  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  const startRename = () => {
    setDraft(tab.label);
    setRenaming(true);
  };

  const commitRename = () => {
    setRenaming(false);
    const trimmed = draft.trim().slice(0, 60);
    if (trimmed && trimmed !== tab.label) menu.onRename(tab.id, trimmed);
  };

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      data-tab-id={tab.id}
      onClick={onSelect}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.();
        setMenuOpen(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
      }}
      className={cn(
        'group flex h-9 shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-border px-3 text-sm transition-colors',
        active ? 'bg-background text-foreground' : 'bg-muted/40 text-muted-foreground hover:bg-muted/70'
      )}
      title={`${tab.username || ''}${tab.username && tab.host ? '@' : ''}${tab.host || ''}`}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[tab.state] || STATUS_DOT.detached)} />
      {renaming ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          maxLength={60}
          className="h-6 w-32 rounded border border-border bg-background px-1 text-xs text-foreground focus:outline-none"
        />
      ) : (
        <span className="max-w-[10rem] truncate">{tab.label}</span>
      )}
      {tab.env && <EnvironmentBadge environment={tab.env} className="hidden sm:inline-flex" />}

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className={cn('rounded p-0.5 hover:bg-accent group-hover:opacity-100', menuOpen ? 'opacity-100' : 'opacity-0')}
            aria-label={`Options for ${tab.label}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={startRename}>
            <Pencil className="mr-2 h-3.5 w-3.5" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => menu.onDuplicate(tab.id)} disabled={!tab.sessionId}>
            <Copy className="mr-2 h-3.5 w-3.5" /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => menu.onSplit(tab.id, 'right')}>
            <SplitSquareHorizontal className="mr-2 h-3.5 w-3.5" /> Split right
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => menu.onSplit(tab.id, 'down')}>
            <SplitSquareVertical className="mr-2 h-3.5 w-3.5" /> Split down
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => menu.onOpenNewWindow(tab.id)} disabled={!tab.sessionId}>
            <ExternalLink className="mr-2 h-3.5 w-3.5" /> Open in new window
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => menu.onCloseOthers(tab.id)}>Close others</DropdownMenuItem>
          <DropdownMenuItem onSelect={onClose}>Close</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => menu.onEndSession(tab.id)}
            className="text-destructive focus:text-destructive"
          >
            <Square className="mr-2 h-3.5 w-3.5" /> End session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
        aria-label={`Close ${tab.label}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * TerminalTabBar — Termius-like horizontally scrollable tab strip. Closing
 * (×) only detaches; "End session" (in the per-tab menu) terminates the SSH
 * session after confirmation.
 */
function TerminalTabBar({ tabs, activeTabId, onSelect, workspace, onNewConnection }) {
  const [endTarget, setEndTarget] = useState(null);

  const menu = {
    onRename: workspace.renameTab,
    onDuplicate: (id) => workspace.duplicateTab(id),
    onSplit: (id, dir) => workspace.splitWith(id, dir),
    onOpenNewWindow: (id) => {
      const tab = workspace.tabs.find((t) => t.id === id);
      if (!tab?.sessionId) return;
      const params = new URLSearchParams({ attach: tab.sessionId, label: tab.label || 'Terminal' });
      window.open(`/terminal?${params.toString()}`, '_blank');
    },
    onCloseOthers: (id) => workspace.closeOthers(id),
    onEndSession: (id) => setEndTarget(id),
  };

  const confirmEnd = () => {
    if (endTarget) workspace.closeTab(endTarget, { end: true });
    setEndTarget(null);
  };

  return (
    <div
      role="tablist"
      aria-label="Open terminals"
      className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-muted/20"
    >
      {tabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          onSelect={() => onSelect(tab.id)}
          onClose={() => workspace.closeTab(tab.id)}
          menu={menu}
        />
      ))}
      <button
        type="button"
        onClick={onNewConnection}
        className="flex h-9 w-9 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="New connection"
        title="New connection (Ctrl+Shift+T)"
      >
        <Plus className="h-4 w-4" />
      </button>

      <ConfirmDialog
        open={!!endTarget}
        title="End session"
        message="This immediately closes the SSH connection for everyone attached to it. This can't be undone."
        confirmLabel="End session"
        variant="destructive"
        onConfirm={confirmEnd}
        onCancel={() => setEndTarget(null)}
      />
    </div>
  );
}

export default TerminalTabBar;
