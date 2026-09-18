import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import TerminalView from '@/components/terminal/TerminalView';
import { cn } from '@/lib/utils';

const MAX_MOUNTED = 12;

function paneGridStyle(mode, ratio) {
  switch (mode) {
    case 'split-right':
      return { gridTemplateColumns: `${ratio}% ${100 - ratio}%`, gridTemplateRows: '1fr' };
    case 'split-down':
      return { gridTemplateRows: `${ratio}% ${100 - ratio}%`, gridTemplateColumns: '1fr' };
    case 'grid':
      return { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' };
    default:
      return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' };
  }
}

function slotArea(mode, paneIdx) {
  if (mode === 'split-right') return { gridColumn: paneIdx === 0 ? '1' : '2', gridRow: '1' };
  if (mode === 'split-down') return { gridColumn: '1', gridRow: paneIdx === 0 ? '1' : '2' };
  if (mode === 'grid') return { gridColumn: String((paneIdx % 2) + 1), gridRow: String(Math.floor(paneIdx / 2) + 1) };
  return { gridColumn: '1', gridRow: '1' };
}

function PaneHeader({ tab, paneIndex, focused, onFocus, tabs, onAssign, onClosePane }) {
  return (
    <div
      onMouseDown={onFocus}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 border-b px-2 text-xs',
        focused ? 'border-primary/40 bg-accent/40' : 'border-border bg-muted/30'
      )}
    >
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{tab ? tab.label : 'Empty pane'}</span>
      {tab?.env && <EnvironmentBadge environment={tab.env} />}
      {tab?.host && <span className="hidden truncate text-muted-foreground sm:inline">{tab.host}</span>}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Show tab in this pane"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {tabs.map((t) => (
            <DropdownMenuItem key={t.id} onSelect={() => onAssign(paneIndex, t.id)}>
              {t.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        onClick={() => onClosePane(paneIndex)}
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Close pane"
        title="Close pane (doesn't end the session)"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * TerminalPaneArea — renders the current layout (single / split-right /
 * split-down / 2x2 grid). Every open tab keeps a mounted TerminalView (up to
 * MAX_MOUNTED, portaled into whichever pane shows it, or into a hidden
 * holding area) so switching tabs or splitting panes never reconnects.
 */
function TerminalPaneArea({ workspace }) {
  const { tabs, layout, focusedPane, setFocusedPane, assignPane, setTabSessionInfo, setTabState } = workspace;
  const [ratio, setRatio] = useState(50);
  const containerRef = useRef(null);
  const draggingRef = useRef(false);
  const [slotNodes, setSlotNodes] = useState({});
  const [hiddenNode, setHiddenNode] = useState(null);

  const tabById = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);
  const assignedIds = useMemo(() => new Set(layout.panes.filter(Boolean)), [layout.panes]);

  // Cap mounted terminals: every pane-assigned tab, plus the most recently
  // opened remaining tabs up to MAX_MOUNTED.
  const mountedTabs = useMemo(() => {
    const assigned = tabs.filter((t) => assignedIds.has(t.id));
    const rest = tabs.filter((t) => !assignedIds.has(t.id));
    const budget = Math.max(0, MAX_MOUNTED - assigned.length);
    return [...assigned, ...rest.slice(-budget)];
  }, [tabs, assignedIds]);

  const setSlotRef = useCallback(
    (idx) => (node) => {
      setSlotNodes((prev) => (prev[idx] === node ? prev : { ...prev, [idx]: node }));
    },
    []
  );

  const startDrag = useCallback(
    (e) => {
      e.preventDefault();
      draggingRef.current = true;
      const onMove = (ev) => {
        if (!draggingRef.current || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const isRow = layout.mode === 'split-down';
        const pct = isRow
          ? ((ev.clientY - rect.top) / rect.height) * 100
          : ((ev.clientX - rect.left) / rect.width) * 100;
        setRatio(Math.min(80, Math.max(20, pct)));
      };
      const onUp = () => {
        draggingRef.current = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [layout.mode]
  );

  const showDivider = layout.mode === 'split-right' || layout.mode === 'split-down';

  if (tabs.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="relative grid h-full min-h-0 w-full gap-px bg-border"
      style={paneGridStyle(layout.mode, ratio)}
    >
      {layout.panes.map((tabId, paneIndex) => {
        const tab = tabId ? tabById.get(tabId) : null;
        return (
          <div
            key={paneIndex}
            style={slotArea(layout.mode, paneIndex)}
            className={cn(
              'flex min-h-0 min-w-0 flex-col bg-background outline-none',
              focusedPane === paneIndex && 'ring-1 ring-inset ring-primary/50'
            )}
          >
            <PaneHeader
              tab={tab}
              paneIndex={paneIndex}
              focused={focusedPane === paneIndex}
              onFocus={() => setFocusedPane(paneIndex)}
              tabs={tabs}
              onAssign={assignPane}
              onClosePane={(idx) => assignPane(idx, null)}
            />
            <div ref={setSlotRef(paneIndex)} className="min-h-0 flex-1">
              {!tab && (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  Select a tab above
                </div>
              )}
            </div>
          </div>
        );
      })}

      <div ref={setHiddenNode} className="hidden" aria-hidden="true" />

      {mountedTabs.map((tab) => {
        const paneIndex = layout.panes.indexOf(tab.id);
        const visible = paneIndex !== -1;
        const target = visible ? slotNodes[paneIndex] : hiddenNode;
        if (!target) return null;
        return createPortal(
          <div
            className="h-full min-h-0"
            onMouseDownCapture={() => visible && setFocusedPane(paneIndex)}
          >
            <TerminalView
              connect={tab.connect}
              visible={visible}
              onSession={(info) => setTabSessionInfo(tab.id, info)}
              onStateChange={(state, extra) => setTabState(tab.id, state, extra)}
              className="h-full"
            />
          </div>,
          target,
          tab.id
        );
      })}

      {showDivider && (
        <div
          onPointerDown={startDrag}
          className={cn(
            'absolute z-10 bg-transparent hover:bg-primary/30',
            layout.mode === 'split-right'
              ? 'top-0 bottom-0 w-1.5 -translate-x-1/2 cursor-col-resize'
              : 'left-0 right-0 h-1.5 -translate-y-1/2 cursor-row-resize'
          )}
          style={layout.mode === 'split-right' ? { left: `${ratio}%` } : { top: `${ratio}%` }}
        />
      )}
    </div>
  );
}

export default TerminalPaneArea;
