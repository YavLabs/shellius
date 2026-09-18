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
  Clock,
  LayoutGrid,
  Rows,
  Columns,
  Square as SquareIcon,
  PanelRight,
  ChevronDown,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { cn } from '@/lib/utils';

const STATUS_DOT = {
  connecting: 'bg-amber-500 animate-pulse',
  live: 'bg-emerald-500',
  detached: 'bg-muted-foreground/60',
  ended: 'bg-red-500',
  error: 'bg-red-500',
  // Access-request tab states (see RequestStatusCard).
  pending: 'bg-amber-500 animate-pulse',
  denied: 'bg-red-500',
  expired: 'bg-muted-foreground/60',
  revoked: 'bg-red-500',
};

const LAYOUT_OPTIONS = [
  { mode: 'single', icon: SquareIcon, label: 'Single' },
  { mode: 'split-right', icon: Columns, label: 'Split right' },
  { mode: 'split-down', icon: Rows, label: 'Split down' },
  { mode: 'grid', icon: LayoutGrid, label: '2x2 grid' },
];

const DRAG_MIME = 'application/x-shellius-tab';

function TabItem({ tab, index, active, onSelect, onClose, menu, dragProps }) {
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

  const isTerminal = tab.kind !== 'request';

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      data-tab-id={tab.id}
      data-tab-index={index}
      draggable
      onDragStart={(e) => dragProps.onDragStart(e, tab.id, index)}
      onDragEnd={dragProps.onDragEnd}
      onDragOver={(e) => dragProps.onDragOver(e, index)}
      onDrop={(e) => dragProps.onDrop(e, index)}
      onClick={onSelect}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
      }}
      className={cn(
        'group relative flex h-full shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-border px-3 text-sm transition-colors',
        active ? 'bg-background text-foreground' : 'bg-muted/40 text-muted-foreground hover:bg-muted/70',
        dragProps.isDragging(tab.id) && 'opacity-40'
      )}
      title={
        tab.kind === 'request'
          ? `Access request — ${tab.label}`
          : `${tab.username || ''}${tab.username && tab.host ? '@' : ''}${tab.host || ''}`
      }
    >
      {dragProps.insertBefore === index && (
        <span className="absolute -left-px top-0.5 bottom-0.5 w-0.5 rounded bg-primary" aria-hidden="true" />
      )}
      {tab.kind === 'request' ? (
        <Clock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[tab.state] || STATUS_DOT.detached)} />
      )}
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
          {isTerminal && (
            <>
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
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => menu.onCloseOthers(tab.id)}>Close others</DropdownMenuItem>
          <DropdownMenuItem onSelect={onClose}>Close</DropdownMenuItem>
          {isTerminal && (
            <DropdownMenuItem
              onSelect={() => menu.onEndSession(tab.id)}
              className="text-destructive focus:text-destructive"
            >
              <Square className="mr-2 h-3.5 w-3.5" /> End session
            </DropdownMenuItem>
          )}
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
 * session after confirmation. Tabs can be reordered by dragging (HTML5 DnD)
 * or with Alt+Shift+Left/Right (handled by the page — see Terminals.jsx).
 * The right-aligned icon buttons replace the old separate "Layout" toolbar
 * row and per-pane header bars (item 3 of the workspace redesign): a single
 * slim bar for everything.
 */
function TerminalTabBar({ tabs, activeTabId, onSelect, workspace, onNewConnection, sessionsOpen, onToggleSessions }) {
  const [endTarget, setEndTarget] = useState(null);
  const [dragTabId, setDragTabId] = useState(null);
  const [insertBefore, setInsertBefore] = useState(null);
  const scrollRef = useRef(null);
  const scrollRafRef = useRef(null);

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

  const stopAutoScroll = () => {
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  };

  // Auto-scroll the strip when dragging near its left/right edge.
  const maybeAutoScroll = (clientX) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const EDGE = 48;
    let speed = 0;
    if (clientX < rect.left + EDGE) speed = -Math.max(2, (rect.left + EDGE - clientX) / 4);
    else if (clientX > rect.right - EDGE) speed = Math.max(2, (clientX - (rect.right - EDGE)) / 4);
    stopAutoScroll();
    if (speed !== 0) {
      const step = () => {
        el.scrollLeft += speed;
        scrollRafRef.current = requestAnimationFrame(step);
      };
      scrollRafRef.current = requestAnimationFrame(step);
    }
  };

  const dragProps = {
    isDragging: (id) => dragTabId === id,
    insertBefore,
    onDragStart: (e, id, index) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(DRAG_MIME, id);
      setDragTabId(id);
      workspace.setDraggedTabId(id);
      setInsertBefore(index);
    },
    onDragEnd: () => {
      setDragTabId(null);
      setInsertBefore(null);
      workspace.setDraggedTabId(null);
      stopAutoScroll();
    },
    onDragOver: (e, index) => {
      if (!dragTabId && !e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      maybeAutoScroll(e.clientX);
      const rect = e.currentTarget.getBoundingClientRect();
      const before = e.clientX - rect.left < rect.width / 2;
      setInsertBefore(before ? index : index + 1);
    },
    onDrop: (e, index) => {
      e.preventDefault();
      stopAutoScroll();
      const id = e.dataTransfer.getData(DRAG_MIME) || dragTabId;
      const fromIndex = tabs.findIndex((t) => t.id === id);
      if (fromIndex === -1) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const before = e.clientX - rect.left < rect.width / 2;
      let toIndex = before ? index : index + 1;
      if (toIndex > fromIndex) toIndex -= 1; // account for the removed slot
      workspace.moveTab(fromIndex, toIndex);
      setDragTabId(null);
      setInsertBefore(null);
      workspace.setDraggedTabId(null);
    },
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div
        role="tablist"
        aria-label="Open terminals"
        ref={scrollRef}
        className="no-scrollbar flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-border bg-muted/20"
      >
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.id}
            tab={tab}
            index={index}
            active={tab.id === activeTabId}
            onSelect={() => onSelect(tab.id)}
            onClose={() => workspace.closeTab(tab.id)}
            menu={menu}
            dragProps={dragProps}
          />
        ))}
        <button
          type="button"
          onClick={onNewConnection}
          className="flex h-full w-9 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="New connection"
          title="New connection (Ctrl+Shift+T)"
        >
          <Plus className="h-4 w-4" />
        </button>

        <div className="flex-1" />

        {tabs.length > 0 && (
          <div className="flex shrink-0 items-center gap-0.5 px-1.5">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-6 items-center gap-0.5 rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label="Layout"
                    >
                      {(() => {
                        const current = LAYOUT_OPTIONS.find((o) => o.mode === workspace.layout.mode) || LAYOUT_OPTIONS[0];
                        const Icon = current.icon;
                        return <Icon className="h-3.5 w-3.5" />;
                      })()}
                      <ChevronDown className="h-2.5 w-2.5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">Layout</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                {LAYOUT_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  const active = workspace.layout.mode === opt.mode;
                  return (
                    <DropdownMenuItem key={opt.mode} onSelect={() => workspace.setLayout(opt.mode)}>
                      <Icon className={cn('mr-2 h-3.5 w-3.5', active && 'text-primary')} />
                      {opt.label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onToggleSessions}
                  aria-label="Toggle sessions panel"
                  aria-pressed={sessionsOpen}
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground',
                    sessionsOpen && 'bg-accent text-foreground'
                  )}
                >
                  <PanelRight className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Sessions</TooltipContent>
            </Tooltip>
          </div>
        )}

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
    </TooltipProvider>
  );
}

export default TerminalTabBar;
