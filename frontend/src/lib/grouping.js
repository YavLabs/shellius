/**
 * grouping.js — the pure half of "group by" on server-paginated lists.
 *
 * The server returns the group tree (backend utils/groupTree.js): nested
 * nodes of { dim, value, label, count, children }. A group's rows are loaded
 * through the page's ordinary list endpoint, with every level's value on the
 * way down added as a filter — so a group opens to exactly the rows it
 * counted, and the filters already applied still hold.
 *
 * NONE mirrors the backend: "this value is empty", accepted back as a filter.
 */

export const NONE = '__none__';
export const MAX_GROUP_LEVELS = 3;

/** `'customer,environment'` → ['customer', 'environment'], only offered keys, no repeats. */
export function parseGroupKeys(raw, options, max = MAX_GROUP_LEVELS) {
  const allowed = new Set((options || []).map((o) => o.value));
  const out = [];
  for (const k of String(raw || '').split(',').map((s) => s.trim())) {
    if (k && allowed.has(k) && !out.includes(k)) out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

export const serializeGroupKeys = (keys) => (keys || []).join(',');

/**
 * The filters a group adds: its own value and every ancestor's, mapped from
 * group dimension to list-API param by `paramFor` (defaults to the dimension
 * key itself).
 *
 * @param {Array<{dim, value}>} path  root → this node
 * @param {Record<string,string>} [paramFor]
 */
export function groupFilters(path, paramFor = {}) {
  const out = {};
  for (const step of path || []) out[paramFor[step.dim] || step.dim] = step.value;
  return out;
}

/** A stable id for a node, from its path: `customer=abc/environment=prod`. */
export const pathId = (path) => (path || []).map((p) => `${p.dim}=${p.value}`).join('/');

/** Every node's path id, for Expand all. */
export function allPathIds(nodes, parent = []) {
  const out = [];
  for (const n of nodes || []) {
    const path = [...parent, { dim: n.dim, value: n.value }];
    out.push(pathId(path));
    if (n.children) out.push(...allPathIds(n.children, path));
  }
  return out;
}

/**
 * Which groups start open. Every level above the leaves opens (they are only
 * headings), and the leaves — each one a request for its rows — open only
 * when there are few enough of them that opening them all is cheap.
 */
export function defaultOpenIds(nodes, { maxOpenLeaves = 4 } = {}) {
  const inner = [];
  const leaves = [];
  const walk = (list, parent) => {
    for (const n of list || []) {
      const path = [...parent, { dim: n.dim, value: n.value }];
      if (n.children) {
        inner.push(pathId(path));
        walk(n.children, path);
      } else {
        leaves.push(pathId(path));
      }
    }
  };
  walk(nodes, []);
  return new Set(leaves.length <= maxOpenLeaves ? [...inner, ...leaves] : inner);
}

/** Leaf groups and total rows, for the "N groups · M rows" line. */
export function treeStats(nodes) {
  let groups = 0;
  let rows = 0;
  for (const n of nodes || []) {
    if (n.children) {
      const s = treeStats(n.children);
      groups += s.groups;
      rows += s.rows;
    } else {
      groups += 1;
      rows += n.count || 0;
    }
  }
  return { groups, rows };
}

export default { NONE, MAX_GROUP_LEVELS, parseGroupKeys, serializeGroupKeys, groupFilters, pathId, allPathIds, defaultOpenIds, treeStats };
