/**
 * groupTree.js — nested "group by" for server-paginated lists.
 *
 * A grouped list cannot be built from the page the client already has: the
 * groups of page 1 are not the groups of the list. So the server answers the
 * question "what are the groups, how many rows in each, nested in this
 * order?" over the whole filtered set, and the client loads each group's rows
 * — through the ordinary list endpoint, with the group's values added as
 * filters — only when someone opens it.
 *
 * This file is the shared, pure half: parse the requested levels, and fold
 * counted rows into a tree. Each list service decides how to get the counted
 * rows (a Prisma `groupBy` over stored columns, or a narrow `findMany` when a
 * level is computed, like a server's SSH trust state).
 *
 * Null / empty values become one group whose value is NONE, which every
 * list endpoint that offers a level accepts back as "is empty" — otherwise
 * the "No OS reported" group could be counted but never opened.
 */

export const NONE = '__none__';
export const MAX_GROUP_LEVELS = 3;

/**
 * `groupBy=customer,environment` → ['customer', 'environment'], keeping only
 * keys this list offers, without repeats, at most MAX_GROUP_LEVELS deep.
 */
export function parseGroupBy(raw, allowed, max = MAX_GROUP_LEVELS) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const out = [];
  for (const k of list.map((s) => String(s).trim())) {
    if (k && allowed.includes(k) && !out.includes(k)) out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

const valueKey = (v) => (v === null || v === undefined || v === '' ? NONE : String(v));

/**
 * @param {Array<{ values: Record<string, any>, count?: number }>} rows
 *   one entry per row (count 1) or per distinct combination (count n)
 * @param {Array<{
 *   key: string,
 *   label?: (value: string) => string,   // NONE included
 *   order?: string[],                    // fixed order of values; others after, by count
 * }>} dims  the levels, outermost first
 * @returns {Array<{ dim, value, label, count, children: Array|null }>}
 */
export function buildGroupTree(rows, dims) {
  if (!dims.length) return [];
  return level(rows, dims, 0);
}

function level(rows, dims, depth) {
  const dim = dims[depth];
  const buckets = new Map();
  for (const r of rows) {
    const v = valueKey(r.values?.[dim.key]);
    if (!buckets.has(v)) buckets.set(v, []);
    buckets.get(v).push(r);
  }

  const nodes = [...buckets.entries()].map(([value, members]) => {
    const count = members.reduce((n, r) => n + (Number.isFinite(r.count) ? r.count : 1), 0);
    return {
      dim: dim.key,
      value,
      label: dim.label ? dim.label(value) : value === NONE ? 'None' : value,
      count,
      children: depth + 1 < dims.length ? level(members, dims, depth + 1) : null,
    };
  });

  // A fixed order where the values have one (severity, environment), then
  // the biggest groups first; "None" always last.
  const rank = (n) => {
    if (n.value === NONE) return Number.MAX_SAFE_INTEGER;
    const i = dim.order ? dim.order.indexOf(n.value) : -1;
    return i === -1 ? Number.MAX_SAFE_INTEGER - 1 : i;
  };
  nodes.sort((a, b) => rank(a) - rank(b) || b.count - a.count || String(a.label).localeCompare(String(b.label)));
  return nodes;
}

/** How many groups a tree has, at every level. */
export function countGroups(nodes) {
  let groups = 0;
  for (const n of nodes || []) groups += 1 + countGroups(n.children);
  return groups;
}

export default { NONE, MAX_GROUP_LEVELS, parseGroupBy, buildGroupTree, countGroups };
