import { describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import {
  countActiveFilters,
  envAccent,
  groupRows,
  pagedRows,
  storePage,
  mobileSpec,
  mobileWindow,
  resolveCardLayout,
  sortOptions,
  splitRowActions,
} from './mobileCard';

const keys = (fields) => fields.map((f) => f.key);
const actionsCol = (actions) => ({ key: 'actions', label: '', actions });

describe('mobileSpec', () => {
  it('normalises strings, false and objects', () => {
    expect(mobileSpec({})).toBeNull();
    expect(mobileSpec({ mobile: false })).toEqual({ slot: 'hidden' });
    expect(mobileSpec({ mobile: 'title' })).toEqual({ slot: 'title' });
    expect(mobileSpec({ mobile: 'bogus' })).toEqual({ slot: 'hidden' });
    expect(mobileSpec({ mobile: { slot: 'meta', showLabel: true } })).toEqual({ slot: 'meta', showLabel: true });
  });
});

describe('resolveCardLayout — defaults (no mobile config)', () => {
  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'slug', label: 'Slug' },
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
    { key: 'c', label: 'C' },
    { key: 'd', label: 'D' },
    { key: 'connect', label: '', render: () => 'btn' },
    actionsCol([{ label: 'Edit', onClick: () => {} }]),
  ];

  it('title = first column, secondary = second, next three = meta, rest hidden', () => {
    const l = resolveCardLayout(columns);
    expect(l.explicit).toBe(false);
    expect(l.title.key).toBe('name');
    expect(keys(l.secondary)).toEqual(['slug']);
    expect(keys(l.meta)).toEqual(['a', 'b', 'c']);
    expect(l.leading).toBeNull();
  });

  it('label-less columns become card controls and the actions column feeds the menu', () => {
    const l = resolveCardLayout(columns);
    expect(keys(l.extras)).toEqual(['connect']);
    expect(l.actionsColumn.key).toBe('actions');
  });

  it('respects maxMeta and ignores the internal select column', () => {
    const l = resolveCardLayout([{ key: '__select__', label: '' }, ...columns], { maxMeta: 1 });
    expect(keys(l.meta)).toEqual(['a']);
    expect(keys(l.extras)).toEqual(['connect']);
  });

  it('render falls back to the column render, then the raw value', () => {
    const l = resolveCardLayout([
      { key: 'name', label: 'Name', render: (r) => `<${r.name}>` },
      { key: 'slug', label: 'Slug' },
    ]);
    expect(l.title.render({ name: 'x' })).toBe('<x>');
    expect(l.secondary[0].render({ slug: 'y' })).toBe('y');
  });

  it('copes with empty / missing columns', () => {
    const l = resolveCardLayout(undefined);
    expect(l.title).toBeNull();
    expect(l.meta).toEqual([]);
    expect(l.actionsColumn).toBeNull();
  });
});

describe('resolveCardLayout — explicit mobile config', () => {
  const columns = [
    { key: 'name', label: 'Name', mobile: 'title' },
    { key: 'ip', label: 'IP', mobile: { slot: 'secondary', order: 2 } },
    { key: 'host', label: 'Host', mobile: { slot: 'secondary', order: 1 } },
    { key: 'env', label: 'Env', mobile: 'meta' },
    { key: 'health', label: 'Health', mobile: { slot: 'leading', render: () => 'dot' } },
    { key: 'os', label: 'OS' }, // undeclared → hidden in explicit mode
    { key: 'x', label: 'X', mobile: false },
    { key: 'connect', label: '', mobile: 'action' },
  ];

  it('places declared columns and hides the rest', () => {
    const l = resolveCardLayout(columns);
    expect(l.explicit).toBe(true);
    expect(l.title.key).toBe('name');
    expect(keys(l.secondary)).toEqual(['host', 'ip']);
    expect(keys(l.meta)).toEqual(['env']);
    expect(l.leading.key).toBe('health');
    expect(keys(l.extras)).toEqual(['connect']);
    const all = [l.title, l.leading, ...l.secondary, ...l.meta, ...l.extras].map((f) => f.key);
    expect(all).not.toContain('os');
    expect(all).not.toContain('x');
  });

  it('uses the mobile render override', () => {
    const l = resolveCardLayout(columns);
    expect(l.leading.render({})).toBe('dot');
  });

  it('caps meta chips', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((k) => ({ key: k, label: k, mobile: 'meta' }));
    expect(resolveCardLayout([{ key: 't', label: 'T', mobile: 'title' }, ...many]).meta).toHaveLength(3);
  });

  it('falls back to the first unused labelled column when no title is declared', () => {
    const l = resolveCardLayout([
      { key: 'status', label: 'Status', mobile: 'meta' },
      { key: 'name', label: 'Name' },
      { key: 'secret', label: 'Secret', mobile: 'hidden' },
    ]);
    expect(l.title.key).toBe('name');
  });
});

describe('splitRowActions', () => {
  const onClick = vi.fn();
  const actions = [
    { label: 'Connect', primary: true, onClick },
    { label: 'View', primary: (r) => r.status === 'active', onClick },
    { label: 'Edit', primary: true, onClick },
    { label: 'Admin only', hidden: (r) => !r.admin, onClick },
    { separator: true },
    { label: 'Delete', variant: 'destructive', hidden: (r) => !r.admin, onClick },
  ];

  it('takes up to maxPrimary primary actions as buttons; the rest go to the menu', () => {
    const { primary, menu } = splitRowActions(actions, { status: 'active', admin: true });
    expect(primary.map((a) => a.label)).toEqual(['Connect', 'View']);
    expect(menu.map((a) => a.label || '—')).toEqual(['Edit', 'Admin only', '—', 'Delete']);
  });

  it('applies the same hidden(row) checks as the desktop menu and tidies separators', () => {
    const { primary, menu } = splitRowActions(actions, { status: 'x', admin: false });
    expect(primary.map((a) => a.label)).toEqual(['Connect', 'Edit']);
    // Admin-only items and the separator before them are gone.
    expect(menu.map((a) => a.label || '—')).toEqual(['View']);
  });

  it('never shows an empty menu or a stray separator', () => {
    const { menu } = splitRowActions(
      [{ separator: true }, { label: 'A', onClick }, { separator: true }, { separator: true }, { label: 'B', onClick }, { separator: true }],
      {}
    );
    expect(menu.map((a) => a.label || '—')).toEqual(['A', '—', 'B']);
    expect(splitRowActions([{ separator: true }], {}).menu).toEqual([]);
  });

  it('maxPrimary 0 keeps everything in the menu', () => {
    const { primary, menu } = splitRowActions(actions, { admin: true }, { maxPrimary: 0 });
    expect(primary).toEqual([]);
    expect(menu[0].label).toBe('Connect');
  });

  it('handles missing actions', () => {
    expect(splitRowActions(undefined, {})).toEqual({ primary: [], menu: [] });
  });
});

describe('sortOptions', () => {
  it('lists sortable data columns with a readable label', () => {
    expect(
      sortOptions([
        { key: 'name', label: 'Name', sortable: true },
        { key: 'ip', label: 'IP' },
        { key: 'env', label: createElement('b', null, 'Env'), sortable: true },
        { key: 'updated', label: 'Updated', sortable: true, sortLabel: 'Last updated' },
        { key: 'actions', label: '', sortable: true },
      ])
    ).toEqual([
      { key: 'name', label: 'Name' },
      { key: 'env', label: 'env' },
      { key: 'updated', label: 'Last updated' },
    ]);
  });
});

describe('countActiveFilters', () => {
  const Select = () => null;
  it('counts controls with a set value, ignoring empty and "all"', () => {
    const slot = createElement(
      Fragment,
      null,
      createElement(Select, { value: 'prod' }),
      createElement(Select, { value: '' }),
      createElement(Select, { value: 'all' }),
      createElement('div', null, createElement(Select, { value: ['a'] }), createElement(Select, { value: [] })),
      createElement('input', { type: 'checkbox', checked: true }),
      null,
      'text'
    );
    expect(countActiveFilters(slot)).toBe(3);
  });

  it('is 0 without filters', () => {
    expect(countActiveFilters(undefined)).toBe(0);
    expect(countActiveFilters(null)).toBe(0);
  });
});

describe('mobileWindow', () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ id: i }));
  it('grows client lists page by page (Load more)', () => {
    expect(mobileWindow({ rows, page: 1, pageSize: 20 })).toHaveLength(20);
    expect(mobileWindow({ rows, page: 2, pageSize: 20 })).toHaveLength(40);
    expect(mobileWindow({ rows, page: 3, pageSize: 20 })).toHaveLength(45);
  });
  it('shows server pages as-is', () => {
    expect(mobileWindow({ rows: rows.slice(0, 20), page: 3, pageSize: 20, server: true })).toHaveLength(20);
  });
});

describe('storePage / pagedRows (phone lists scroll instead of paging)', () => {
  const p1 = [{ id: 1 }, { id: 2 }];
  const p2 = [{ id: 3 }, { id: 4 }];

  it('keeps earlier pages and appends the next one in order', () => {
    let pages = storePage(new Map(), 1, p1);
    pages = storePage(pages, 2, p2);
    expect(pagedRows(pages).map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it('starts over on page 1 (new search or filter)', () => {
    let pages = storePage(storePage(new Map(), 1, p1), 2, p2);
    pages = storePage(pages, 1, [{ id: 9 }]);
    expect(pagedRows(pages).map((r) => r.id)).toEqual([9]);
  });

  it('refreshes a page in place and drops pages after it', () => {
    let pages = storePage(storePage(new Map(), 1, p1), 2, p2);
    pages = storePage(pages, 1, p1);
    pages = storePage(storePage(pages, 2, p2), 3, [{ id: 5 }]);
    pages = storePage(pages, 2, [{ id: 3 }]);
    expect(pagedRows(pages).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('skips rows that shifted onto the next page', () => {
    const pages = storePage(storePage(new Map(), 1, p1), 2, [{ id: 2 }, { id: 3 }]);
    expect(pagedRows(pages).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('does not mutate the map it was given', () => {
    const first = storePage(new Map(), 1, p1);
    storePage(first, 2, p2);
    expect([...first.keys()]).toEqual([1]);
  });
});

describe('envAccent', () => {
  it('maps environments to a tone and short code', () => {
    expect(envAccent('prod')).toEqual({ tone: 'danger', label: 'PROD' });
    expect(envAccent('dev')).toEqual({ tone: 'info', label: 'DEV' });
    expect(envAccent(null)).toBeNull();
  });
});

describe('groupRows', () => {
  it('groups in the given order and keeps row order inside a group', () => {
    const rows = [{ id: 1, a: false }, { id: 2, a: true }, { id: 3, a: true }];
    const g = groupRows(rows, (r) => (r.a ? { key: 'active', label: 'Active' } : { key: 'inactive', label: 'Inactive' }), ['active', 'inactive']);
    expect(g.map((x) => [x.key, x.rows.map((r) => r.id)])).toEqual([['active', [2, 3]], ['inactive', [1]]]);
  });
});
