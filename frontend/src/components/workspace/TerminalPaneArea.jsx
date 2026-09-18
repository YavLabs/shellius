import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import TerminalView from '@/components/terminal/TerminalView';
import RequestStatusCard from '@/components/workspace/RequestStatusCard';
import { cn } from '@/lib/utils';

const MAX_MOUNTED = 12;
const DRAG_MIME = 'application/x-shellius-tab';

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

// Quadrant the pointer is over within a pane's box, used both to decide the
// drop overlay position and the actual split (see dropTab in
// lib/workspaceLayout.js for the placement rules). The centre
// ~30% is its own "replace" zone so a drop doesn't have to be pixel-perfect
// to land on an edge.
function zoneFromPoint(rect, clientX, clientY) {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x > 0.35 && x < 0.65 && y > 0.35 && y < 0.65) return 'center';
  const d = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  return Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
}

function DropOverlay({ zone, label }) {
  const pos = {
    left: 'inset-y-0 left-0 w-1/2',
    right: 'inset-y-0 right-0 w-1/2',
    top: 'inset-x-0 top-0 h-1/2',
    bottom: 'inset-x-0 bottom-0 h-1/2',
    center: 'inset-6',
  }[zone];
  return (
    <div
      className={cn(
        'pointer-events-none absolute z-20 flex items-center justify-center rounded-md border-2 border-primary/70 bg-primary/15',
        pos
      )}
      aria-hidden="true"
    >
      <span className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground shadow">{label}</span>
    </div>
  );
}

// A small chip shown only on hover (in split layouts) instead of a
// persistent per-pane header bar — see item 3 of the workspace redesign.
function PaneHoverChip({ tab, paneIndex, tabs, onAssign, onClosePane }) {
  return (
    <div className="pointer-events-none absolute right-1.5 top-1.5 z-10 opacity-0 transition-opacity group-hover/pane:opacity-100 group-focus-within/pane:opacity-100">
      <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-border bg-popover/95 px-1.5 py-1 text-[11px] shadow-sm backdrop-blur">
        <span className="max-w-[9rem] truncate font-medium text-foreground">{tab ? tab.label : 'Empty pane'}</span>
        {tab?.env && <EnvironmentBadge environment={tab.env} />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Pane options">
              <MoreHorizontal className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {tabs.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => onAssign(paneIndex, t.id)}>
                Show {t.label}
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
    </div>
  );
}

/**
 * TerminalPaneArea — renders the layout on screen (single / split-right /
 * split-down / 2x2 grid). Each split belongs to the tabs in it (see
 * lib/workspaceLayout.js), so this is the active tab's split, or the active
 * tab alone. Every open tab keeps a mounted TerminalView (up to
 * MAX_MOUNTED) in a stable host node that is moved into whichever pane
 * shows it, or into a hidden holding area, so switching tabs or splitting
 * panes never reconnects (see hostNodesRef).
 * Request tabs (`kind: 'request'`) render a RequestStatusCard instead.
 *
 * Single-pane mode has no header at all — the terminal fills the pane
 * edge-to-edge (p-2 inner padding). Split modes show a small floating label
 * chip in the top-right corner of each pane on hover, and the focused pane
 * gets a subtle 1px primary ring instead of a header bar.
 *
 * Dragging a tab from the tab bar onto a pane splits/replaces it — see the
 * `dropTab` in lib/workspaceLayout.js for the exact zone → layout rules.
 */
function TerminalPaneArea({ workspace }) {
  const { tabs, layout, focusedPane, setFocusedPane, assignPane, dropTabOnPane, draggedTabId, setTabSessionInfo, setTabState } =
    workspace;
  // Divider position per split (keyed by group id), so each split keeps its own.
  const [ratios, setRatios] = useState({});
  const ratio = ratios[layout.id] ?? 50;
  const setRatio = useCallback((value) => setRatios((prev) => ({ ...prev, [layout.id]: value })), [layout.id]);
  const containerRef = useRef(null);
  const draggingRef = useRef(false);
  const [slotNodes, setSlotNodes] = useState({});
  const [hiddenNode, setHiddenNode] = useState(null);
  const [dragOverPane, setDragOverPane] = useState(null); // { index, zone }

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

  // One STABLE ref callback per pane index. Returning a fresh closure each
  // render made React detach (null) and re-attach the ref on every commit;
  // both calls set state, which re-rendered, which looped forever
  // ("Maximum update depth exceeded").
  const slotRefCallbacks = useRef({});
  const setSlotRef = useCallback((idx) => {
    if (!slotRefCallbacks.current[idx]) {
      slotRefCallbacks.current[idx] = (node) => {
        setSlotNodes((prev) => (prev[idx] === node ? prev : { ...prev, [idx]: node }));
      };
    }
    return slotRefCallbacks.current[idx];
  }, []);

  // Each mounted tab renders into its OWN host <div>, which never changes, and
  // that div is moved between panes / the hidden holder with plain DOM
  // appendChild. Portaling straight into the pane slot would remount the
  // TerminalView whenever the tab changes pane, because React recreates a
  // portal when its container changes. Every tab switch or layout change
  // would then open a new WebSocket: a new ticket, a re-attach, a replay, and
  // "Too many requests" after a few quick switches.
  const hostNodesRef = useRef(new Map());
  const hostFor = (tabId) => {
    let node = hostNodesRef.current.get(tabId);
    if (!node) {
      node = document.createElement('div');
      node.className = 'h-full min-h-0';
      hostNodesRef.current.set(tabId, node);
    }
    return node;
  };

  useLayoutEffect(() => {
    const mountedIds = new Set(mountedTabs.map((t) => t.id));
    for (const [tabId, node] of hostNodesRef.current) {
      if (!mountedIds.has(tabId)) {
        node.remove();
        hostNodesRef.current.delete(tabId);
        continue;
      }
      const paneIndex = layout.panes.indexOf(tabId);
      const target = paneIndex !== -1 ? slotNodes[paneIndex] : hiddenNode;
      if (target && node.parentNode !== target) target.appendChild(node);
    }
  });

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
    [layout.mode, setRatio]
  );

  const showDivider = layout.mode === 'split-right' || layout.mode === 'split-down';
  const isSplit = layout.mode !== 'single';

  // Drag handlers live on the OUTER container, not the per-pane divs.
  // TerminalView is rendered via createPortal into a pane's slot div, and
  // React's *synthetic* event bubbling follows the React tree (where the
  // portal call is authored — a sibling of the pane divs, both children of
  // this container), not the DOM tree. A native drop over the portaled
  // xterm content therefore never reaches a per-pane div's onDrop, even
  // though it visually sits inside that pane. Handling it here (a genuine
  // React-tree ancestor of the portal) and hit-testing the pane via
  // elementFromPoint + closest('[data-pane-index]') sidesteps that entirely.
  const paneAt = (clientX, clientY) => {
    const el = document.elementFromPoint(clientX, clientY);
    const paneEl = el?.closest('[data-pane-index]');
    if (!paneEl || !containerRef.current?.contains(paneEl)) return null;
    return { index: Number(paneEl.dataset.paneIndex), rect: paneEl.getBoundingClientRect() };
  };

  const handleContainerDragOver = (e) => {
    if (!draggedTabId && !e.dataTransfer.types.includes(DRAG_MIME)) return;
    const hit = paneAt(e.clientX, e.clientY);
    if (!hit) {
      setDragOverPane(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const zone = zoneFromPoint(hit.rect, e.clientX, e.clientY);
    setDragOverPane((prev) => (prev?.index === hit.index && prev?.zone === zone ? prev : { index: hit.index, zone }));
  };

  const handleContainerDragLeave = (e) => {
    if (containerRef.current?.contains(e.relatedTarget)) return;
    setDragOverPane(null);
  };

  const handleContainerDrop = (e) => {
    const id = e.dataTransfer.getData(DRAG_MIME) || draggedTabId;
    const hit = paneAt(e.clientX, e.clientY);
    setDragOverPane(null);
    if (!id || !hit) return;
    e.preventDefault();
    const zone = zoneFromPoint(hit.rect, e.clientX, e.clientY);
    dropTabOnPane(id, hit.index, zone);
  };

  if (tabs.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="relative grid h-full min-h-0 w-full gap-px bg-border"
      style={paneGridStyle(layout.mode, ratio)}
      onDragOver={handleContainerDragOver}
      onDragLeave={handleContainerDragLeave}
      onDrop={handleContainerDrop}
    >
      {layout.panes.map((tabId, paneIndex) => {
        const tab = tabId ? tabById.get(tabId) : null;
        const isDropTarget = dragOverPane?.index === paneIndex;
        return (
          <div
            key={paneIndex}
            data-pane-index={paneIndex}
            data-pane-tab-id={tabId || ''}
            style={slotArea(layout.mode, paneIndex)}
            className={cn(
              'group/pane relative flex min-h-0 min-w-0 flex-col bg-background outline-none',
              focusedPane === paneIndex && 'ring-1 ring-inset ring-primary/50'
            )}
            onMouseDownCapture={() => setFocusedPane(paneIndex)}
          >
            {isSplit && (
              <PaneHoverChip
                tab={tab}
                paneIndex={paneIndex}
                tabs={tabs}
                onAssign={assignPane}
                onClosePane={(idx) => assignPane(idx, null)}
              />
            )}
            <div ref={setSlotRef(paneIndex)} className="min-h-0 flex-1">
              {!tab && (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  {focusedPane === paneIndex
                    ? 'Click a tab above or open a new connection to fill this pane'
                    : 'Drop a tab here, or click to select this pane'}
                </div>
              )}
            </div>
            {isDropTarget && (
              <DropOverlay zone={dragOverPane.zone} label={tabById.get(draggedTabId)?.label || 'Tab'} />
            )}
          </div>
        );
      })}

      <div ref={setHiddenNode} className="hidden" aria-hidden="true" />

      {mountedTabs.map((tab) => {
        const paneIndex = layout.panes.indexOf(tab.id);
        const visible = paneIndex !== -1;
        return createPortal(
          <div className="h-full min-h-0" onMouseDownCapture={() => visible && setFocusedPane(paneIndex)}>
            {tab.kind === 'request' ? (
              <RequestStatusCard tab={tab} focused={visible && focusedPane === paneIndex} />
            ) : (
              <TerminalView
                connect={tab.connect}
                visible={visible}
                onSession={(info) => setTabSessionInfo(tab.id, info)}
                onStateChange={(state, extra) => setTabState(tab.id, state, extra)}
                className="h-full"
              />
            )}
          </div>,
          hostFor(tab.id),
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
