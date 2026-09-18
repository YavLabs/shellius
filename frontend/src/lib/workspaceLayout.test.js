import { describe, it, expect } from 'vitest';
import {
  emptyWorkspace,
  currentView,
  addTab,
  selectTab,
  removeTab,
  setLayoutMode,
  dropTab,
  splitWith,
  placeInPane,
  focusPane,
  sanitize,
  migrateLegacyLayout,
  barItems,
  itemTabId,
  renameGroup,
  ungroup,
  moveBlock,
} from './workspaceLayout';

const open = (...ids) => ids.reduce((ws, id) => addTab(ws, id), emptyWorkspace());
const view = (ws) => {
  const v = currentView(ws);
  return { mode: v.mode, panes: v.panes };
};

describe('workspace layout: splits belong to their tabs', () => {
  it('a new tab opened while a split is on screen shows full size; the split survives', () => {
    let ws = open('A', 'B');
    ws = dropTab(ws, 'A', 0, 'right'); // B | A
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['B', 'A'] });

    ws = addTab(ws, 'C');
    expect(view(ws)).toEqual({ mode: 'single', panes: ['C'] });

    ws = selectTab(ws, 'A');
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['B', 'A'] });
    expect(currentView(ws).focusedPane).toBe(1);
    ws = selectTab(ws, 'B');
    expect(currentView(ws).focusedPane).toBe(0);
  });

  it('switching the third tab to single does not collapse the other split', () => {
    let ws = open('A', 'B');
    ws = dropTab(ws, 'A', 0, 'left'); // A | B
    ws = addTab(ws, 'C');
    ws = setLayoutMode(ws, 'single'); // C is already single → no-op
    expect(view(ws)).toEqual({ mode: 'single', panes: ['C'] });
    ws = selectTab(ws, 'A');
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['A', 'B'] });

    // The third tab gets its own split, then goes back to single: A | B is untouched.
    ws = addTab(ws, 'D');
    ws = selectTab(ws, 'C');
    ws = splitWith(ws, 'D', 'right'); // C | D
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['C', 'D'] });
    ws = setLayoutMode(ws, 'single');
    expect(view(ws)).toEqual({ mode: 'single', panes: ['D'] });
    ws = selectTab(ws, 'B');
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['A', 'B'] });
  });

  it('two independent splits coexist', () => {
    let ws = open('A', 'B');
    ws = dropTab(ws, 'A', 0, 'left'); // A | B
    ws = addTab(ws, 'C');
    ws = addTab(ws, 'D');
    ws = dropTab(ws, 'C', 0, 'bottom'); // D / C
    expect(view(ws)).toEqual({ mode: 'split-down', panes: ['D', 'C'] });
    ws = selectTab(ws, 'B');
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['A', 'B'] });
    ws = setLayoutMode(ws, 'single');
    expect(view(ws)).toEqual({ mode: 'single', panes: ['B'] });
    ws = selectTab(ws, 'C');
    expect(view(ws)).toEqual({ mode: 'split-down', panes: ['D', 'C'] });
    ws = selectTab(ws, 'A');
    expect(view(ws)).toEqual({ mode: 'single', panes: ['A'] });
  });

  it('moving a tab from one split into another dissolves the one it left', () => {
    let ws = open('A', 'B', 'C');
    ws = dropTab(ws, 'B', 0, 'right'); // C | B
    ws = selectTab(ws, 'A');
    ws = dropTab(ws, 'B', 0, 'right'); // A | B, old C|B loses B → dissolved
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['A', 'B'] });
    expect(ws.groups).toHaveLength(1);
    ws = selectTab(ws, 'C');
    expect(view(ws)).toEqual({ mode: 'single', panes: ['C'] });
  });
});

describe('layout menu', () => {
  it('split on a single tab leaves a focused empty pane that the next tab fills', () => {
    let ws = open('A');
    ws = setLayoutMode(ws, 'split-right');
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['A', null] });
    expect(currentView(ws).focusedPane).toBe(1);
    ws = addTab(ws, 'B');
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['A', 'B'] });
    ws = addTab(ws, 'C'); // no empty pane focused → full size
    expect(view(ws)).toEqual({ mode: 'single', panes: ['C'] });
  });

  it('clicking a tab in the bar fills a focused empty pane', () => {
    let ws = open('A', 'B');
    ws = setLayoutMode(ws, 'split-down'); // B / empty
    ws = selectTab(ws, 'A', { fillEmptyPane: true });
    expect(view(ws)).toEqual({ mode: 'split-down', panes: ['B', 'A'] });
  });

  it('an unfilled split is discarded when you leave it', () => {
    let ws = open('A', 'B');
    ws = setLayoutMode(ws, 'grid');
    ws = selectTab(ws, 'A'); // plain selection (keyboard) doesn't fill
    expect(ws.groups).toHaveLength(0);
    ws = selectTab(ws, 'B');
    expect(view(ws)).toEqual({ mode: 'single', panes: ['B'] });
  });

  it('switching a split between modes keeps its tabs; grid → split keeps the focused one', () => {
    let ws = open('A', 'B');
    ws = dropTab(ws, 'A', 0, 'left'); // A | B
    ws = setLayoutMode(ws, 'split-down');
    expect(view(ws)).toEqual({ mode: 'split-down', panes: ['A', 'B'] });
    ws = setLayoutMode(ws, 'grid');
    expect(view(ws)).toEqual({ mode: 'grid', panes: ['A', 'B', null, null] });
    ws = addTab(ws, 'C'); // focused pane is 'A' (not empty) → C full size
    expect(view(ws).mode).toBe('single');
    ws = selectTab(ws, 'A');
    ws = focusPane(ws, 2);
    ws = selectTab(ws, 'C', { fillEmptyPane: true });
    expect(view(ws)).toEqual({ mode: 'grid', panes: ['A', 'B', 'C', null] });
    ws = setLayoutMode(ws, 'split-right'); // C focused, must stay
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['A', 'C'] });
    ws = selectTab(ws, 'B');
    expect(view(ws)).toEqual({ mode: 'single', panes: ['B'] });
  });
});

describe('drag and drop', () => {
  it('cross-axis drop on a 2-pane split promotes to a grid', () => {
    let ws = open('A', 'B', 'C');
    ws = selectTab(ws, 'A');
    ws = dropTab(ws, 'B', 0, 'right'); // A | B
    ws = dropTab(ws, 'C', 1, 'bottom'); // B's column splits: B over C
    expect(view(ws)).toEqual({ mode: 'grid', panes: ['A', 'B', null, 'C'] });
    expect(ws.activeTabId).toBe('C');
  });

  it('dropping a split member on the other pane swaps them', () => {
    let ws = open('A', 'B');
    ws = dropTab(ws, 'A', 0, 'left'); // A | B
    ws = dropTab(ws, 'A', 1, 'center');
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['B', 'A'] });
  });

  it('dropping an outside tab replaces the pane; the replaced tab becomes standalone', () => {
    let ws = open('A', 'B', 'C');
    ws = selectTab(ws, 'A');
    ws = dropTab(ws, 'B', 0, 'right'); // A | B
    ws = dropTab(ws, 'C', 0, 'center'); // C | B
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['C', 'B'] });
    ws = selectTab(ws, 'A');
    expect(view(ws)).toEqual({ mode: 'single', panes: ['A'] });
  });

  it('dropping the shown tab on itself does nothing', () => {
    let ws = open('A');
    expect(dropTab(ws, 'A', 0, 'right')).toEqual(selectTab(ws, 'A'));
  });
});

describe('tab menu split', () => {
  it('"Split right" on the shown tab adds an empty pane; on another tab it pairs them', () => {
    let ws = open('A', 'B');
    ws = splitWith(ws, 'B', 'right');
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['B', null] });
    ws = selectTab(ws, 'A'); // leaving discards the empty split
    ws = splitWith(ws, 'B', 'down');
    expect(view(ws)).toEqual({ mode: 'split-down', panes: ['A', 'B'] });
  });
});

describe('closing', () => {
  it('closing a tab of a 2-pane split collapses it and shows the survivor', () => {
    let ws = open('A', 'B', 'C');
    ws = selectTab(ws, 'A');
    ws = dropTab(ws, 'B', 0, 'right');
    ws = removeTab(ws, 'B', ['A', 'C']);
    expect(ws.groups).toHaveLength(0);
    expect(view(ws)).toEqual({ mode: 'single', panes: ['A'] });
  });

  it('closing a tab from a 3-tab grid leaves a side-by-side split', () => {
    let ws = open('A', 'B', 'C');
    ws = selectTab(ws, 'A');
    ws = dropTab(ws, 'B', 0, 'right');
    ws = dropTab(ws, 'C', 1, 'bottom');
    ws = removeTab(ws, 'A', ['B', 'C']);
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['B', 'C'] });
  });

  it('closing a tab that is not on screen leaves the view alone', () => {
    let ws = open('A', 'B', 'C');
    ws = dropTab(ws, 'A', 0, 'left'); // A | C
    ws = removeTab(ws, 'B', ['A', 'C']);
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['A', 'C'] });
  });

  it('closing a pane (✕ on the chip) makes its tab standalone', () => {
    let ws = open('A', 'B');
    ws = dropTab(ws, 'A', 0, 'left'); // A | B
    ws = placeInPane(ws, null, 1);
    expect(view(ws)).toEqual({ mode: 'single', panes: ['A'] });
    ws = selectTab(ws, 'B');
    expect(view(ws)).toEqual({ mode: 'single', panes: ['B'] });
  });
});

describe('persistence', () => {
  it('sanitize drops dead tabs, duplicates and 1-tab splits', () => {
    const ws = sanitize(
      {
        groups: [
          { id: 'g1', mode: 'split-right', panes: ['A', 'X'], focusedPane: 0 },
          { id: 'g2', mode: 'grid', panes: ['B', 'C', 'A', null], focusedPane: 9 },
        ],
        activeTabId: 'Z',
      },
      ['A', 'B', 'C']
    );
    expect(ws.activeTabId).toBe('C');
    expect(ws.groups).toHaveLength(1);
    expect(ws.groups[0]).toMatchObject({ mode: 'grid', panes: ['B', 'C', 'A', null], focusedPane: 0 });
  });

  it('migrates the old single global layout', () => {
    const ws = sanitize(migrateLegacyLayout({ mode: 'split-right', panes: ['A', 'B'] }, 'B'), ['A', 'B', 'C']);
    expect(view(ws)).toEqual({ mode: 'split-right', panes: ['A', 'B'] });
    expect(sanitize(migrateLegacyLayout({ mode: 'single', panes: ['A'] }, 'A'), ['A']).groups).toHaveLength(0);
  });
});

describe('workspace tabs (merged splits in the tab bar)', () => {
  const T = (...ids) => ids.map((id) => ({ id }));

  it('a split of two or more tabs shows as one named workspace item at its first member', () => {
    let ws = open('A', 'B', 'C', 'D');
    ws = selectTab(ws, 'B');
    ws = dropTab(ws, 'D', 0, 'right'); // B | D
    const items = barItems(T('A', 'B', 'C', 'D'), ws.groups);
    expect(items.map((i) => (i.type === 'tab' ? i.tab.id : `${i.group.name}[${i.tabs.map((t) => t.id)}]`))).toEqual([
      'A',
      'Workspace[B,D]',
      'C',
    ]);
    expect(itemTabId(items[1])).toBe('D'); // focused pane
  });

  it('numbers additional workspaces and keeps names through reloads', () => {
    let ws = open('A', 'B', 'C', 'D');
    ws = selectTab(ws, 'A');
    ws = dropTab(ws, 'B', 0, 'right');
    ws = selectTab(ws, 'C');
    ws = dropTab(ws, 'D', 0, 'right');
    expect(ws.groups.map((g) => g.name)).toEqual(['Workspace', 'Workspace 2']);
    ws = renameGroup(ws, ws.groups[0].id, '  Prod debugging  ');
    const reloaded = sanitize(JSON.parse(JSON.stringify(ws)), ['A', 'B', 'C', 'D']);
    expect(reloaded.groups.map((g) => g.name)).toEqual(['Prod debugging', 'Workspace 2']);
  });

  it('a split waiting for its second tab is still a plain tab', () => {
    let ws = open('A');
    ws = setLayoutMode(ws, 'split-right');
    expect(barItems(T('A'), ws.groups).map((i) => i.type)).toEqual(['tab']);
  });

  it('ungroup returns the tabs to the bar and keeps the focused one on screen', () => {
    let ws = open('A', 'B');
    ws = dropTab(ws, 'A', 0, 'left'); // A | B, A focused
    ws = ungroup(ws, ws.groups[0].id);
    expect(ws.groups).toHaveLength(0);
    expect(view(ws)).toEqual({ mode: 'single', panes: ['A'] });
    expect(barItems(T('A', 'B'), ws.groups).map((i) => i.type)).toEqual(['tab', 'tab']);
  });

  it('moveBlock moves a workspace’s members together', () => {
    expect(moveBlock(T('A', 'B', 'C', 'D'), ['B', 'D'], 0).map((t) => t.id)).toEqual(['B', 'D', 'A', 'C']);
    expect(moveBlock(T('A', 'B', 'C', 'D'), ['A', 'B'], 2).map((t) => t.id)).toEqual(['C', 'D', 'A', 'B']);
  });
});
