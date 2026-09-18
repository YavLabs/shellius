/**
 * Pure layout model for the terminal workspace (no React). The context calls
 * these functions from its state updaters; they are unit-tested on their own
 * (workspaceLayout.test.js).
 *
 * Model
 * -----
 * The tab bar lists terminal tabs. A tab is either **standalone** (shown full
 * size when selected) or a member of exactly one **split group**:
 *
 *   group = { id, mode: 'split-right' | 'split-down' | 'grid', panes: [tabId|null…], focusedPane }
 *
 * The view is derived from the active tab. If it's in a group, that group's
 * split is shown with the active tab's pane focused. Otherwise the tab is
 * shown on its own. Every split therefore belongs to the tabs in it, so:
 *
 *   - opening or selecting a standalone tab shows it full size and leaves
 *     other splits alone;
 *   - selecting any member of a split brings that whole split back;
 *   - changing the layout (e.g. to Single) only affects the split on screen.
 *
 * A group may have empty panes, e.g. right after "Split right", where the
 * new pane waits for a tab. Selecting or opening a tab while an empty pane
 * is focused fills that pane. A group with fewer than two tabs is dissolved
 * once it's no longer on screen, or immediately when a tab is closed or
 * removed from it (see `compactGroup`).
 */

export const PANE_COUNTS = { single: 1, 'split-right': 2, 'split-down': 2, grid: 4 };
const SPLIT_MODES = new Set(['split-right', 'split-down', 'grid']);

let seq = 0;
export function groupId() {
  seq += 1;
  return `grp_${Date.now().toString(36)}_${seq}`;
}

export const emptyWorkspace = () => ({ groups: [], activeTabId: null });

export function findGroup(groups, tabId) {
  if (!tabId) return null;
  return groups.find((g) => g.panes.includes(tabId)) || null;
}

const tabCount = (g) => g.panes.filter(Boolean).length;

/** The layout currently on screen: `{ group|null, mode, panes, focusedPane }`. */
export function currentView(ws) {
  const group = findGroup(ws.groups, ws.activeTabId);
  if (group) return { group, mode: group.mode, panes: group.panes, focusedPane: group.focusedPane };
  return { group: null, mode: 'single', panes: [ws.activeTabId || null], focusedPane: 0 };
}

function replaceGroup(groups, group) {
  return groups.map((g) => (g.id === group.id ? group : g));
}

/**
 * Normalize a group after a tab left it (close / moved elsewhere / pane
 * closed): 0-1 tabs dissolves it, and a 2x2 grid left with 2 tabs becomes a
 * side-by-side split, so there's no half-empty grid. Returns null when
 * dissolved.
 */
export function compactGroup(group) {
  const members = group.panes.filter(Boolean);
  if (members.length <= 1) return null;
  if (group.mode === 'grid' && members.length === 2) {
    const focusedTab = group.panes[group.focusedPane];
    return { ...group, mode: 'split-right', panes: members, focusedPane: Math.max(0, members.indexOf(focusedTab)) };
  }
  return group;
}

/**
 * Remove a tab from whatever group holds it (tab closed or moved into another
 * group). `keepGroupId` skips compaction of that group (the caller is about to
 * place the tab back into it).
 */
export function detachTab(groups, tabId, keepGroupId = null) {
  const out = [];
  for (const g of groups) {
    const idx = g.panes.indexOf(tabId);
    if (idx === -1) {
      out.push(g);
      continue;
    }
    const panes = g.panes.map((p) => (p === tabId ? null : p));
    const next = { ...g, panes };
    if (g.id === keepGroupId) {
      out.push(next);
      continue;
    }
    const compacted = compactGroup(next);
    if (compacted) out.push(compacted);
  }
  return out;
}

/**
 * Drop groups that are not on screen and hold fewer than two tabs. These are
 * leftovers from "Split right" on a tab whose second pane was never filled.
 */
function pruneOffscreen(groups, activeTabId) {
  const onScreen = findGroup(groups, activeTabId);
  return groups.filter((g) => g === onScreen || tabCount(g) >= 2);
}

/** Show a tab: its split if it belongs to one (focusing its pane), else full size. */
export function selectTab(ws, tabId, { fillEmptyPane = false } = {}) {
  if (!tabId) return ws;
  const view = currentView(ws);
  if (
    fillEmptyPane &&
    view.group &&
    !view.panes[view.focusedPane] &&
    !view.group.panes.includes(tabId)
  ) {
    return placeInPane(ws, tabId, view.focusedPane);
  }
  let groups = ws.groups;
  const g = findGroup(groups, tabId);
  if (g) groups = replaceGroup(groups, { ...g, focusedPane: g.panes.indexOf(tabId) });
  return { groups: pruneOffscreen(groups, tabId), activeTabId: tabId };
}

/**
 * A new tab was added. If the split on screen has a focused empty pane, and
 * the caller didn't ask for background, it fills that pane. Otherwise the tab
 * is standalone, and shown full size when `focus` is set.
 */
export function addTab(ws, tabId, { focus = true } = {}) {
  const view = currentView(ws);
  if (focus && view.group && !view.panes[view.focusedPane]) {
    return placeInPane(ws, tabId, view.focusedPane);
  }
  if (!focus) return ws.activeTabId ? ws : { ...ws, activeTabId: tabId };
  return selectTab(ws, tabId);
}

/** Tab closed: remove it everywhere and pick the next tab to show. */
export function removeTab(ws, tabId, remainingTabIds) {
  const before = findGroup(ws.groups, tabId);
  const groups = detachTab(ws.groups, tabId);
  if (ws.activeTabId !== tabId) return { groups, activeTabId: ws.activeTabId };
  // Prefer staying inside the same split (its focused, else first remaining member).
  const survivor = before && groups.find((g) => g.id === before.id);
  let next = null;
  if (survivor) next = survivor.panes[survivor.focusedPane] || survivor.panes.find(Boolean);
  else if (before) next = before.panes.find((p) => p && p !== tabId) || null;
  if (!next) next = remainingTabIds[remainingTabIds.length - 1] || null;
  return next ? selectTab({ groups, activeTabId: null }, next) : { groups, activeTabId: null };
}

/**
 * Put `tabId` into pane `paneIndex` of the split on screen. If the tab is
 * already in that split, it swaps with the pane's occupant. If it came from
 * another split, it leaves that one. If it replaced a tab, that tab becomes
 * standalone (still in the tab bar).
 */
export function placeInPane(ws, tabId, paneIndex) {
  const view = currentView(ws);
  if (!view.group) {
    // Single view: "placing" a tab just shows it.
    return tabId ? selectTab(ws, tabId) : ws;
  }
  const group = view.group;
  if (paneIndex < 0 || paneIndex >= group.panes.length) return ws;
  const panes = [...group.panes];
  const occupant = panes[paneIndex];
  const oldIdx = tabId ? panes.indexOf(tabId) : -1;
  if (oldIdx === paneIndex) return selectTab(ws, tabId);
  if (oldIdx !== -1) panes[oldIdx] = occupant; // swap within the split
  panes[paneIndex] = tabId || null;

  let groups = tabId ? detachTab(ws.groups, tabId, group.id) : ws.groups;
  let next = { ...group, panes, focusedPane: paneIndex };
  if (!tabId) {
    // Pane closed: its tab becomes standalone. Collapse if the split is now pointless.
    const compacted = compactGroup(next);
    groups = compacted ? replaceGroup(groups, compacted) : groups.filter((g) => g.id !== group.id);
    const focusTab = compacted
      ? compacted.panes[compacted.focusedPane] || compacted.panes.find(Boolean)
      : group.panes.find((p, i) => p && i !== paneIndex) || occupant;
    return selectTab({ groups, activeTabId: null }, focusTab);
  }
  groups = replaceGroup(groups, next);
  return { groups, activeTabId: tabId };
}

/**
 * Change the layout of what's on screen only. Other splits are untouched.
 *   - single: dissolves the split on screen, and its tabs become standalone.
 *     The focused tab stays in view.
 *   - a split mode on a standalone tab: new split with the tab in pane 0 and
 *     the next pane focused and empty, ready for a tab.
 *   - a split mode on a split: re-flows its tabs in order into the new pane
 *     count. Tabs that don't fit (grid → 2 panes) become standalone.
 */
export function setLayoutMode(ws, mode) {
  if (!PANE_COUNTS[mode]) return ws;
  const view = currentView(ws);
  if (mode === view.mode) return ws;

  if (mode === 'single') {
    if (!view.group) return ws;
    const keep = view.panes[view.focusedPane] || view.panes.find(Boolean) || ws.activeTabId;
    return { groups: ws.groups.filter((g) => g.id !== view.group.id), activeTabId: keep };
  }

  const count = PANE_COUNTS[mode];
  if (!view.group) {
    if (!ws.activeTabId) return ws;
    const panes = Array.from({ length: count }, (_, i) => (i === 0 ? ws.activeTabId : null));
    const group = { id: groupId(), mode, panes, focusedPane: 1 };
    return { groups: [...ws.groups, group], activeTabId: ws.activeTabId };
  }

  const members = view.panes.filter(Boolean);
  const focusedTab = view.panes[view.focusedPane] || null;
  // Keep the focused tab when some have to drop out.
  let fit = members.slice(0, count);
  if (focusedTab && !fit.includes(focusedTab)) fit = [...fit.slice(0, count - 1), focusedTab];
  const panes = Array.from({ length: count }, (_, i) => fit[i] || null);
  const focusedPane = focusedTab ? panes.indexOf(focusedTab) : Math.min(members.length, count - 1);
  const group = { ...view.group, mode, panes, focusedPane: Math.max(0, focusedPane) };
  return { groups: replaceGroup(ws.groups, group), activeTabId: ws.activeTabId };
}

/** Focus a pane of the split on screen. A pane with a tab also makes it active. */
export function focusPane(ws, paneIndex) {
  const view = currentView(ws);
  if (!view.group || paneIndex === view.focusedPane) return ws;
  const group = { ...view.group, focusedPane: paneIndex };
  const tab = group.panes[paneIndex];
  return { groups: replaceGroup(ws.groups, group), activeTabId: tab || ws.activeTabId };
}

/**
 * Drag a tab onto the pane area. `zone` is 'left' | 'right' | 'top' |
 * 'bottom' | 'center'.
 *
 *  - single view, edge zone → a new split of the shown tab and the dragged
 *    tab, with the dragged tab on the side it was dropped on. Center → just
 *    show the dragged tab.
 *  - 2-pane split, same-axis edge or center → the dragged tab goes into the
 *    hovered pane. It swaps if it was already in this split; otherwise the
 *    previous occupant becomes standalone.
 *  - 2-pane split, cross-axis edge → promote to a 2x2 grid. The hovered
 *    pane's column/row splits in two; the other pane's tab stays put and the
 *    fourth slot is left empty.
 *  - grid → the dragged tab goes into the hovered pane.
 *
 * The dragged tab always leaves any other split first. Dropping the shown
 * tab onto its own single view does nothing.
 */
export function dropTab(ws, tabId, paneIndex, zone) {
  const view = currentView(ws);

  if (!view.group) {
    const current = view.panes[0];
    if (!current || current === tabId) return selectTab(ws, tabId);
    if (zone === 'center') return selectTab(ws, tabId);
    const mode = zone === 'left' || zone === 'right' ? 'split-right' : 'split-down';
    const first = zone === 'left' || zone === 'top';
    const panes = first ? [tabId, current] : [current, tabId];
    const groups = detachTab(detachTab(ws.groups, tabId), current);
    const group = { id: groupId(), mode, panes, focusedPane: panes.indexOf(tabId) };
    return { groups: [...groups, group], activeTabId: tabId };
  }

  const group = view.group;
  const sameAxis =
    (group.mode === 'split-right' && (zone === 'left' || zone === 'right')) ||
    (group.mode === 'split-down' && (zone === 'top' || zone === 'bottom'));
  if (group.mode === 'grid' || zone === 'center' || sameAxis) {
    return placeInPane(ws, tabId, paneIndex);
  }

  // Cross-axis on a 2-pane split → 2x2 grid.
  const base = group.panes.map((p) => (p === tabId ? null : p));
  const otherIndex = paneIndex === 0 ? 1 : 0;
  const hovered = base[paneIndex];
  const other = base[otherIndex];
  const grid = [null, null, null, null];
  let target;
  if (group.mode === 'split-right') {
    const col = paneIndex;
    const draggedFirst = zone === 'top';
    grid[col] = draggedFirst ? tabId : hovered;
    grid[2 + col] = draggedFirst ? hovered : tabId;
    grid[otherIndex] = other;
    target = draggedFirst ? col : 2 + col;
  } else {
    const row = paneIndex;
    const draggedFirst = zone === 'left';
    grid[row * 2] = draggedFirst ? tabId : hovered;
    grid[row * 2 + 1] = draggedFirst ? hovered : tabId;
    grid[otherIndex * 2] = other;
    target = draggedFirst ? row * 2 : row * 2 + 1;
  }
  const groups = detachTab(ws.groups, tabId, group.id);
  const next = { ...group, mode: 'grid', panes: grid, focusedPane: target };
  return { groups: replaceGroup(groups, next), activeTabId: tabId };
}

/**
 * "Split right" / "Split down" from a tab's menu.
 *  - the tab is the one shown, full size → split it with an empty pane
 *    beside it, waiting for a tab.
 *  - another tab is on screen → put this tab beside what's shown, like
 *    dropping it on that edge of the focused pane.
 */
export function splitWith(ws, tabId, direction) {
  const zone = direction === 'right' ? 'right' : 'bottom';
  const view = currentView(ws);
  if (!view.group && (ws.activeTabId === tabId || !ws.activeTabId)) {
    const mode = direction === 'right' ? 'split-right' : 'split-down';
    const groups = detachTab(ws.groups, tabId);
    const group = { id: groupId(), mode, panes: [tabId, null], focusedPane: 1 };
    return { groups: [...groups, group], activeTabId: tabId };
  }
  if (view.group && view.group.panes.includes(tabId)) {
    // Already in this split: act on its own pane.
    return dropTab(ws, tabId, view.group.panes.indexOf(tabId), zone);
  }
  return dropTab(ws, tabId, view.focusedPane, zone);
}

/** "Remove from split" in a tab's menu: the tab becomes standalone, and so does
 *  its partner if that leaves a split with a single tab. */
export function removeFromSplit(ws, tabId) {
  if (!findGroup(ws.groups, tabId)) return ws;
  return { groups: detachTab(ws.groups, tabId), activeTabId: ws.activeTabId };
}

/** Keep only tabs that still exist, and make sure the state is consistent. */
export function sanitize(ws, tabIds) {
  const alive = new Set(tabIds);
  const seen = new Set();
  const groups = [];
  for (const g of ws.groups || []) {
    if (!g || !SPLIT_MODES.has(g.mode)) continue;
    const count = PANE_COUNTS[g.mode];
    const panes = Array.from({ length: count }, (_, i) => {
      const p = g.panes?.[i];
      return p && alive.has(p) && !seen.has(p) ? p : null;
    });
    const focusedPane = Number.isInteger(g.focusedPane) && g.focusedPane >= 0 && g.focusedPane < count ? g.focusedPane : 0;
    const compacted = compactGroup({ id: g.id || groupId(), mode: g.mode, panes, focusedPane });
    if (!compacted) continue; // its tabs stay free for a later group
    compacted.panes.forEach((p) => p && seen.add(p));
    groups.push(compacted);
  }
  const activeTabId = alive.has(ws.activeTabId) ? ws.activeTabId : tabIds[tabIds.length - 1] || null;
  return { groups: pruneOffscreen(groups, activeTabId), activeTabId };
}

/** Persisted v1 state had one global `layout`. Turn a real split into a group. */
export function migrateLegacyLayout(layout, activeTabId) {
  if (!layout || !SPLIT_MODES.has(layout.mode) || !Array.isArray(layout.panes)) return { groups: [], activeTabId };
  const group = { id: groupId(), mode: layout.mode, panes: layout.panes, focusedPane: 0 };
  const inGroup = activeTabId && layout.panes.includes(activeTabId);
  return { groups: [group], activeTabId: inGroup ? activeTabId : activeTabId || layout.panes.find(Boolean) || null };
}
