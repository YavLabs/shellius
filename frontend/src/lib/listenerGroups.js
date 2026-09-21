/**
 * listenerGroups.js — one row per socket a person would call "one socket".
 *
 * `ss` reports a dual-stack listener as two sockets, 0.0.0.0:22 and [::]:22,
 * and systemd-resolved's stub as 127.0.0.53:53 and 127.0.0.54:53. Each is
 * true and each is stored (the API keeps every socket), but in the table
 * they read as the same port listed twice — as if a reinstall had
 * duplicated the data. Rows are grouped here, for display only, by what
 * makes them the same thing: protocol, port, container port and owner. The
 * binds are kept, all of them, and the worst reachability wins.
 */

// Same order as the backend's roll-up (postureService REACH_RANK).
const REACH_RANK = { INTERNET: 5, LAN: 4, FIREWALLED: 3, UNKNOWN: 2, LOOPBACK: 1 };

const bindOrder = (b) => {
  if (b === '0.0.0.0') return 0;
  if (b === '::') return 1;
  if (/^\d/.test(b)) return 2;
  return 3;
};

/** "IPv4 + IPv6" style note for a set of binds, or null. */
export function bindNote(binds = []) {
  const set = new Set(binds);
  if (set.has('0.0.0.0') && set.has('::')) return 'all interfaces, IPv4 + IPv6';
  if (set.size === 1 && (set.has('0.0.0.0') || set.has('::'))) return 'all interfaces';
  if ([...set].every((b) => b.startsWith('127.') || b === '::1')) return 'loopback only';
  return null;
}

/**
 * @param {Array<object>} listeners  HostListener rows
 * @returns {Array<object>} one row per group: the first row's fields, plus
 *   `binds` (every bind, IPv4 first), `bind` (joined, for search/detail),
 *   `ids` (every underlying row), `reachability` (worst).
 */
export function groupListeners(listeners = []) {
  const groups = new Map();
  for (const l of listeners) {
    const key = [l.proto, l.port, l.containerPort ?? '', l.ownerKind ?? '', l.ownerName ?? '', l.pid ?? ''].join('|');
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...l, binds: [l.bind].filter(Boolean), ids: [l.id] });
      continue;
    }
    if (l.bind && !g.binds.includes(l.bind)) g.binds.push(l.bind);
    g.ids.push(l.id);
    if ((REACH_RANK[l.reachability] || 0) > (REACH_RANK[g.reachability] || 0)) {
      g.reachability = l.reachability;
      g.bindClass = l.bindClass;
    }
  }
  return [...groups.values()].map((g) => {
    const binds = [...g.binds].sort((a, b) => bindOrder(a) - bindOrder(b) || a.localeCompare(b));
    return { ...g, binds, bind: binds.join(', ') };
  });
}
