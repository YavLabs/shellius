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
  Maximize2,
  Ungroup,
  Monitor,
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
import { barItems, itemTabId } from '@/lib/workspaceLayout';
import { isRdpTab, tabCapabilities } from '@/lib/rdpPanes';

const STATUS_DOT = {
  connecting: 'bg-amber-500 animate-pulse',
  live: 'bg-emerald-500',
  detached: 'bg-muted-foreground/60',
  ended: 'bg-red-500',
  error: 'bg-red-500',
  reconnecting: 'bg-amber-500 animate-pulse',
  lost: 'bg-red-500',
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

const SPLIT_ICON = { 'split-right': Columns, 'split-down': Rows, grid: LayoutGrid };

// `split` is { mode, onScreen } when the tab is in a split, else undefined.
function TabItem({ tab, index, active, split, onSelect, onClose, menu, dragProps }) {
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
  const isRdp = isRdpTab(tab);
  const caps = tabCapabilities(tab);
  const SplitIcon = split ? SPLIT_ICON[split.mode] : null;

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      data-tab-id={tab.id}
      data-tab-index={index}
      data-tab-state={tab.state}
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
        'group relative flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-3 text-sm transition-colors',
        active
          ? 'bg-foreground/[0.10] text-foreground'
          : split?.onScreen
            ? 'bg-foreground/[0.07] text-foreground/80 hover:bg-foreground/[0.09]'
            : 'bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground/90',
        dragProps.isDragging(tab.id) && 'opacity-40'
      )}
      title={
        tab.kind === 'request'
          ? `Access request — ${tab.label}`
          : `${tab.username || ''}${tab.username && tab.host ? '@' : ''}${tab.host || ''}${
              split && !split.onScreen ? ' — in a split view, click to show it' : ''
            }`
      }
    >
      {dragProps.insertBefore === index && (
        <span className="absolute -left-[4px] top-1 bottom-1 w-0.5 rounded bg-primary" aria-hidden="true" />
      )}
      {tab.kind === 'request' ? (
        <Clock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <>
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[tab.state] || STATUS_DOT.detached)} />
          {isRdp && <Monitor className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Remote desktop" />}
        </>
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
      {SplitIcon && (
        <SplitIcon
          className={cn('h-3 w-3 shrink-0', split.onScreen ? 'text-primary' : 'text-muted-foreground/70')}
          aria-label="In a split view"
        />
      )}
      {tab.env && <EnvironmentBadge environment={tab.env} className="hidden sm:inline-flex" />}

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className={cn('rounded p-0.5 hover:bg-foreground/10 group-hover:opacity-100', menuOpen ? 'opacity-100' : 'opacity-0')}
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
              {/* Duplicate is absent for RDP, not merely disabled: a second
                  pane onto the same Windows account evicts this one. */}
              {caps.canDuplicate !== false && !isRdp && (
                <DropdownMenuItem onSelect={() => menu.onDuplicate(tab.id)} disabled={!tab.sessionId}>
                  <Copy className="mr-2 h-3.5 w-3.5" /> Duplicate
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => menu.onSplit(tab.id, 'right')}>
                <SplitSquareHorizontal className="mr-2 h-3.5 w-3.5" /> Split right
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => menu.onSplit(tab.id, 'down')}>
                <SplitSquareVertical className="mr-2 h-3.5 w-3.5" /> Split down
              </DropdownMenuItem>
              {split && (
                <DropdownMenuItem onSelect={() => menu.onRemoveFromSplit(tab.id)}>
                  <Maximize2 className="mr-2 h-3.5 w-3.5" /> Remove from split
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => menu.onOpenNewWindow(tab.id)}
                disabled={!caps.canOpenNewWindow}
              >
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                {isRdp ? 'Move to a new window' : 'Open in new window'}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => menu.onCloseOthers(tab.id)}>Close others</DropdownMenuItem>
          <DropdownMenuItem onSelect={onClose}>Close</DropdownMenuItem>
          {isTerminal && caps.canEndSession && (
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
        className="rounded p-0.5 opacity-0 hover:bg-foreground/10 group-hover:opacity-100"
        aria-label={`Close ${tab.label}`}
        title={caps.endsOnClose ? 'Close (this ends the remote desktop session)' : 'Close (the session keeps running)'}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// Worst member state wins, so a workspace dot turns amber/red when any pane needs attention.
const STATE_RANK = ['error', 'lost', 'ended', 'denied', 'revoked', 'reconnecting', 'connecting', 'pending', 'expired', 'detached', 'live'];
function workspaceState(tabs) {
  let best = 'live';
  for (const t of tabs) {
    const r = STATE_RANK.indexOf(t.state);
    if (r !== -1 && r < STATE_RANK.indexOf(best)) best = t.state;
  }
  return best;
}

/**
 * One tab-bar item for a whole split (2+ tabs merged): named "Workspace"
 * by default (renameable), shows how many terminals it holds, and a
 * combined status dot. Clicking shows the split; × closes (detaches) every
 * terminal in it; the menu can rename, ungroup into tabs, or end every session.
 */
function WorkspaceItem({ item, index, active, onSelect, workspace, onEndAll, dragProps }) {
  const { group, tabs } = item;
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState(group.name || 'Workspace');
  const inputRef = useRef(null);
  const Icon = SPLIT_ICON[group.mode] || LayoutGrid;
  const state = workspaceState(tabs);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const startRename = () => {
    setDraft(group.name || 'Workspace');
    setRenaming(true);
  };
  const commitRename = () => {
    setRenaming(false);
    const trimmed = draft.trim().slice(0, 60);
    if (trimmed && trimmed !== group.name) workspace.renameWorkspace(group.id, trimmed);
  };
  const closeAll = () => tabs.forEach((t) => workspace.closeTab(t.id));

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      data-workspace-id={group.id}
      data-tab-state={state}
      draggable={!renaming}
      onDragStart={(e) => dragProps.onDragStart(e, item, index)}
      onDragEnd={dragProps.onDragEnd}
      onDragOver={(e) => dragProps.onDragOver(e, index)}
      onDrop={(e) => dragProps.onDrop(e, index)}
      onClick={onSelect}
      onDoubleClick={startRename}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeAll();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
        if (e.key === 'F2') startRename();
      }}
      title={`${group.name || 'Workspace'}: ${tabs.map((t) => t.label).join(', ')}`}
      className={cn(
        'group relative flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-3 text-sm transition-colors',
        active
          ? 'bg-foreground/[0.10] text-foreground'
          : 'bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground/90',
        dragProps.isDragging(group.id) && 'opacity-40'
      )}
    >
      {dragProps.insertBefore === index && (
        <span className="absolute -left-[4px] top-1 bottom-1 w-0.5 rounded bg-primary" aria-hidden="true" />
      )}
      <Icon className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
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
          aria-label="Workspace name"
          className="h-6 w-32 rounded border border-border bg-background px-1 text-xs text-foreground focus:outline-none"
        />
      ) : (
        <span className="max-w-[10rem] truncate font-medium">{group.name || 'Workspace'}</span>
      )}
      <span className="rounded bg-foreground/[0.08] px-1 text-[10px] font-semibold tabular-nums text-muted-foreground" aria-label={`${tabs.length} terminals`}>
        {tabs.length}
      </span>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[state] || STATUS_DOT.detached)} aria-hidden="true" />

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className={cn('rounded p-0.5 hover:bg-foreground/10 group-hover:opacity-100', menuOpen ? 'opacity-100' : 'opacity-0')}
            aria-label={`Options for ${group.name || 'Workspace'}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={startRename}>
            <Pencil className="mr-2 h-3.5 w-3.5" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => workspace.ungroupWorkspace(group.id)}>
            <Ungroup className="mr-2 h-3.5 w-3.5" /> Ungroup into tabs
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {tabs.map((t) => (
            <DropdownMenuItem key={t.id} onSelect={() => workspace.selectTab(t.id)}>
              <span className={cn('mr-2 h-1.5 w-1.5 rounded-full', STATUS_DOT[t.state] || STATUS_DOT.detached)} />
              <span className="truncate">{t.label}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={closeAll}>Close workspace</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onEndAll(tabs)} className="text-destructive focus:text-destructive">
            <Square className="mr-2 h-3.5 w-3.5" /> End all sessions
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          closeAll();
        }}
        className="rounded p-0.5 opacity-0 hover:bg-foreground/10 group-hover:opacity-100"
        aria-label={`Close ${group.name || 'Workspace'}`}
        title="Close workspace (sessions keep running)"
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
  const openSessionIds = new Set(tabs.map((t) => t.sessionId).filter(Boolean));
  const detachedCount = (workspace.liveSessions || []).filter((s) => !openSessionIds.has(s.id)).length;

  const menu = {
    onRename: workspace.renameTab,
    onDuplicate: (id) => workspace.duplicateTab(id),
    onSplit: (id, dir) => workspace.splitWith(id, dir),
    onRemoveFromSplit: (id) => workspace.removeFromSplit(id),
    onOpenNewWindow: (id) => {
      const tab = workspace.tabs.find((t) => t.id === id);
      if (!tab) return;
      if (isRdpTab(tab)) {
        // RDP cannot be handed over: guacamole-lite has no attach, so the new
        // window opens a NEW Windows logon. Close this pane first or the two
        // evict each other (see lib/rdpPanes.js).
        const requestId = tab.connect?.requestId || tab.accessRequestId;
        if (!requestId) return;
        workspace.closeTab(id);
        window.open(`/terminal?requestId=${encodeURIComponent(requestId)}`, '_blank');
        return;
      }
      if (!tab.sessionId) return;
      const params = new URLSearchParams({ attach: tab.sessionId, label: tab.label || 'Terminal' });
      window.open(`/terminal?${params.toString()}`, '_blank');
    },
    onCloseOthers: (id) => workspace.closeOthers(id),
    onEndSession: (id) => setEndTarget(id),
  };

  // endTarget: a tab id, or { tabs } for a workspace's "End all sessions".
  const confirmEnd = () => {
    if (typeof endTarget === 'string') workspace.closeTab(endTarget, { end: true });
    // RDP members have no hub session to end over REST; closing the tab tears
    // the tunnel down, which is the same thing for them.
    else if (endTarget?.tabs)
      endTarget.tabs.forEach((t) => workspace.closeTab(t.id, { end: !isRdpTab(t) }));
    setEndTarget(null);
  };

  // A split of 2+ tabs is one workspace item; everything else is a plain tab.
  const items = barItems(tabs, workspace.groups || []);
  const memberIds = (item) => (item.type === 'tab' ? [item.tab.id] : item.tabs.map((t) => t.id));

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

  // Drag works on bar items: a plain tab can also be dropped on the pane area
  // (split); a workspace only reorders, moving its terminals as one block.
  const dragProps = {
    isDragging: (key) => dragTabId === key,
    insertBefore,
    onDragStart: (e, itemOrId, index) => {
      e.dataTransfer.effectAllowed = 'move';
      const isWorkspace = typeof itemOrId === 'object';
      const key = isWorkspace ? itemOrId.group.id : itemOrId;
      e.dataTransfer.setData(DRAG_MIME, isWorkspace ? `ws:${key}` : key);
      setDragTabId(key);
      workspace.setDraggedTabId(isWorkspace ? null : key);
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
      const raw = e.dataTransfer.getData(DRAG_MIME) || dragTabId;
      const key = raw?.startsWith('ws:') ? raw.slice(3) : raw;
      const dragged = items.find((it) => it.key === key);
      setDragTabId(null);
      setInsertBefore(null);
      workspace.setDraggedTabId(null);
      if (!dragged) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const before = e.clientX - rect.left < rect.width / 2;
      const toItem = before ? index : index + 1;
      // Convert "before bar item N" into a position among the other tabs.
      const block = memberIds(dragged);
      const rest = tabs.filter((t) => !block.includes(t.id));
      const anchor = items.slice(toItem).find((it) => it !== dragged);
      const at = anchor ? rest.findIndex((t) => t.id === memberIds(anchor)[0]) : rest.length;
      workspace.moveWorkspace(block, at === -1 ? rest.length : at);
    },
  };

  return (
    <TooltipProvider delayDuration={300}>
      {/* Only the tab strip scrolls; the toolbar sits outside it so its
          badges aren't clipped by the strip's overflow. */}
      <div className="flex h-9 shrink-0 items-center gap-1.5">
      <div
        role="tablist"
        aria-label="Open terminals"
        ref={scrollRef}
        className="no-scrollbar flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden"
      >
        {items.map((item, index) =>
          item.type === 'workspace' ? (
            <WorkspaceItem
              key={item.key}
              item={item}
              index={index}
              active={item.tabs.some((t) => t.id === activeTabId)}
              onSelect={() => workspace.selectTab(itemTabId(item))}
              workspace={workspace}
              onEndAll={(members) => setEndTarget({ tabs: members })}
              dragProps={dragProps}
            />
          ) : (
          <TabItem
            key={item.key}
            tab={item.tab}
            index={index}
            active={item.tab.id === activeTabId}
            split={workspace.splitInfo.get(item.tab.id)}
            onSelect={() => onSelect(item.tab.id)}
            onClose={() => workspace.closeTab(item.tab.id)}
            menu={menu}
            dragProps={dragProps}
          />
          )
        )}
        <button
          type="button"
          onClick={onNewConnection}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
          aria-label="New connection"
          title="New connection (Ctrl+Shift+T)"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

        {tabs.length > 0 && (
          <div className="flex shrink-0 items-center gap-1">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-8 items-center gap-0.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
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
                  data-detached-count={detachedCount}
                  aria-label="Toggle sessions panel"
                  aria-pressed={sessionsOpen}
                  className={cn(
                    'relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground',
                    sessionsOpen && 'bg-foreground/[0.10] text-foreground'
                  )}
                >
                  <PanelRight className="h-3.5 w-3.5" />
                  {detachedCount > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold text-primary-foreground">
                      {detachedCount}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {detachedCount > 0
                  ? `Sessions (${detachedCount} running but not open in a tab)`
                  : 'Sessions'}
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        <ConfirmDialog
          open={!!endTarget}
          title={endTarget?.tabs ? `End ${endTarget.tabs.length} sessions` : 'End session'}
          message={
            endTarget?.tabs
              ? `This immediately closes all ${endTarget.tabs.length} SSH connections in this workspace, for everyone attached to them. This can't be undone.`
              : "This immediately closes the SSH connection for everyone attached to it. This can't be undone."
          }
          confirmLabel={endTarget?.tabs ? 'End all sessions' : 'End session'}
          variant="destructive"
          onConfirm={confirmEnd}
          onCancel={() => setEndTarget(null)}
        />
      </div>
    </TooltipProvider>
  );
}

export default TerminalTabBar;
