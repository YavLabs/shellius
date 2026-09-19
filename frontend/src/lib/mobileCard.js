import { Children, isValidElement } from 'react';
import { environmentTone } from '@/lib/badgeTones';

/**
 * Pure helpers behind DataTable's mobile card list (docs/plans/1.5.1-mobile.md §5).
 *
 * A column opts into the card with a `mobile` field:
 *
 *   mobile: 'title' | 'secondary' | 'meta' | 'leading' | 'action' | 'hidden'
 *   mobile: false                         // same as 'hidden'
 *   mobile: { slot, render?(row), label?, order? }
 *
 *   - leading   — avatar / icon / status dot left of the text
 *   - title     — the primary line (one column)
 *   - secondary — the muted line under the title (several are joined with " · ")
 *   - meta      — compact chips under the text (max `maxMeta`, default 3)
 *   - action    — a custom control shown with the row's buttons (e.g. Connect)
 *   - hidden    — not on the card
 *
 * Once ANY column declares `mobile`, the table is in explicit mode and every
 * column without it is hidden. With no declarations the default layout is:
 * first data column = title, second = secondary, the next three = meta chips,
 * label-less columns (inline buttons) = action, the rest hidden.
 *
 * The `key: 'actions'` column always feeds the card's buttons + "⋯" menu; an
 * action shows as a button when it has `primary: true` (or `primary(row)`).
 */

export const CARD_SLOTS = ['leading', 'title', 'secondary', 'meta', 'action', 'hidden'];
export const DEFAULT_MAX_META = 3;
export const DEFAULT_MAX_PRIMARY = 2;

function isActionsColumn(col) {
  return col?.key === 'actions' && Array.isArray(col.actions);
}

function hasLabel(col) {
  if (col.label == null) return false;
  if (typeof col.label === 'string') return col.label.trim() !== '';
  return true;
}

/** Normalises a column's `mobile` field to `{ slot, render?, label?, order? }` or null. */
export function mobileSpec(col) {
  const m = col?.mobile;
  if (m === undefined || m === null) return null;
  if (m === false) return { slot: 'hidden' };
  if (typeof m === 'string') return { slot: CARD_SLOTS.includes(m) ? m : 'hidden' };
  if (typeof m === 'object') {
    const slot = CARD_SLOTS.includes(m.slot) ? m.slot : 'hidden';
    return { ...m, slot };
  }
  return null;
}

/** A card field: the column plus how to render it on the card. */
function field(col, spec) {
  return {
    key: col.key,
    label: spec?.label ?? (typeof col.label === 'string' ? col.label : col.key),
    column: col,
    render: (row) => {
      if (typeof spec?.render === 'function') return spec.render(row);
      if (typeof col.render === 'function') return col.render(row);
      return row?.[col.key];
    },
  };
}

function byOrder(a, b) {
  return (a.order ?? 0) - (b.order ?? 0);
}

/**
 * Maps a column config to the card layout.
 * @returns {{ leading, title, secondary: [], meta: [], extras: [], actionsColumn, explicit }}
 */
export function resolveCardLayout(columns = [], { maxMeta = DEFAULT_MAX_META } = {}) {
  const cols = (columns || []).filter(Boolean);
  const actionsColumn = cols.find(isActionsColumn) || null;
  const dataCols = cols.filter((c) => !isActionsColumn(c) && c.key !== '__select__');
  const explicit = dataCols.some((c) => mobileSpec(c) !== null);

  const layout = { leading: null, title: null, secondary: [], meta: [], extras: [], actionsColumn, explicit };

  if (explicit) {
    const bySlot = { leading: [], title: [], secondary: [], meta: [], action: [] };
    dataCols.forEach((col, idx) => {
      const spec = mobileSpec(col);
      if (!spec || spec.slot === 'hidden') return;
      bySlot[spec.slot].push({ order: spec.order ?? idx, f: field(col, spec) });
    });
    const pick = (slot) => bySlot[slot].sort(byOrder).map((x) => x.f);
    layout.leading = pick('leading')[0] || null;
    layout.title = pick('title')[0] || null;
    layout.secondary = pick('secondary');
    layout.meta = pick('meta').slice(0, maxMeta);
    layout.extras = pick('action');
    // A table that configured other slots but forgot the title still needs one.
    if (!layout.title) {
      const used = new Set(
        [layout.leading, ...layout.secondary, ...layout.meta, ...layout.extras].filter(Boolean).map((f) => f.key)
      );
      const fallback = dataCols.find((c) => hasLabel(c) && !used.has(c.key) && mobileSpec(c)?.slot !== 'hidden');
      if (fallback) layout.title = field(fallback, null);
    }
    return layout;
  }

  for (const col of dataCols) {
    if (!hasLabel(col)) {
      // Label-less columns are inline controls (Connect buttons, toggles).
      layout.extras.push(field(col, null));
    } else if (!layout.title) {
      layout.title = field(col, null);
    } else if (layout.secondary.length === 0) {
      layout.secondary.push(field(col, null));
    } else if (layout.meta.length < maxMeta) {
      layout.meta.push(field(col, null));
    }
  }
  return layout;
}

/** Drops leading/trailing/doubled separators left behind by hidden actions. */
function tidySeparators(items) {
  const out = [];
  for (const item of items) {
    if (item.separator) {
      if (out.length === 0 || out[out.length - 1].separator) continue;
    }
    out.push(item);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

function isHidden(action, row) {
  if (typeof action.hidden === 'function') return !!action.hidden(row);
  return action.hidden === true;
}

function isPrimary(action, row) {
  if (typeof action.primary === 'function') return !!action.primary(row);
  return action.primary === true;
}

/**
 * Splits a row's actions into card buttons and the "⋯" menu. Only actions the
 * row may show are considered (the same `hidden(row)` checks as the desktop
 * menu). Primary actions become buttons (max `maxPrimary`); everything else —
 * including primary ones past the limit — stays in the menu.
 */
export function splitRowActions(actions = [], row, { maxPrimary = DEFAULT_MAX_PRIMARY } = {}) {
  const visible = (actions || []).filter((a) => a && !isHidden(a, row));
  const primary = [];
  const menu = [];
  for (const action of visible) {
    if (!action.separator && primary.length < maxPrimary && isPrimary(action, row)) primary.push(action);
    else menu.push(action);
  }
  const tidy = tidySeparators(menu);
  return { primary, menu: tidy.some((a) => !a.separator) ? tidy : [] };
}

/** Sortable columns as Sort-menu options. */
export function sortOptions(columns = []) {
  return (columns || [])
    .filter((c) => c && c.sortable && c.key !== 'actions' && c.key !== '__select__')
    .map((c) => ({
      key: c.key,
      label: c.sortLabel || (typeof c.label === 'string' && c.label.trim() ? c.label : c.key),
    }));
}

/** Values that mean "no filter" in the filter controls used across the app. */
function isActiveValue(v) {
  if (v === undefined || v === null || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s !== '' && s !== 'all' && s !== 'any';
  }
  return true;
}

/**
 * Counts active filters in a `filters` slot: every element with a `value` prop
 * (SearchableSelect, Input, …) whose value is set and isn't "all". Pages can
 * override with an explicit count when their controls don't expose `value`.
 */
export function countActiveFilters(node) {
  let count = 0;
  const walk = (n) => {
    Children.forEach(n, (child) => {
      if (!isValidElement(child)) return;
      const props = child.props || {};
      if (Object.prototype.hasOwnProperty.call(props, 'value')) {
        if (isActiveValue(props.value)) count += 1;
        return;
      }
      if (Object.prototype.hasOwnProperty.call(props, 'checked')) {
        if (props.checked) count += 1;
        return;
      }
      if (props.children) walk(props.children);
    });
  };
  walk(node);
  return count;
}

/**
 * Which rows the mobile list shows: client-paginated tables grow with
 * "Load more" (pages 1..page), server-paginated ones show the current page.
 */
export function mobileWindow({ rows = [], page = 1, pageSize = 20, server = false }) {
  if (server) return rows;
  return rows.slice(0, Math.max(1, page) * pageSize);
}

/**
 * Server-paginated lists on phones scroll instead of paging: the pages seen
 * so far are kept (page → rows) and shown as one list. Page 1 starts over
 * (new search, filter or sort); pages after the current one are dropped.
 * Returns the next page map; never mutates the one passed in.
 */
export function storePage(pages, page, rows) {
  const next = new Map(page <= 1 ? [] : [...pages].filter(([p]) => p < page));
  next.set(Math.max(1, page), rows || []);
  return next;
}

/** The stored pages in order as one list, without repeats (rows can shift between pages). */
export function pagedRows(pages) {
  const seen = new Set();
  const out = [];
  [...pages.keys()]
    .sort((a, b) => a - b)
    .forEach((p) => {
      for (const row of pages.get(p) || []) {
        const id = row?.id;
        if (id != null) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        out.push(row);
      }
    });
  return out;
}

/**
 * A card's accent for a server environment: the card is tinted with the
 * environment's tone and its code sits small in the bottom-left corner,
 * instead of a DEV / PROD chip in the meta row.
 */
export function envAccent(environment) {
  if (!environment) return null;
  return environmentTone(environment);
}

/**
 * Splits rows into headed sections: `group(row)` returns `{ key, label }`.
 * Sections follow `order` (a list of keys) and then first appearance; rows
 * keep their order inside a section. Empty sections are left out.
 */
export function groupRows(rows = [], group, order = []) {
  const byKey = new Map();
  for (const row of rows) {
    const g = group(row) || { key: 'other', label: 'Other' };
    if (!byKey.has(g.key)) byKey.set(g.key, { key: g.key, label: g.label, rows: [] });
    byKey.get(g.key).rows.push(row);
  }
  const rank = (k) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key));
}
