import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { isServerOnboarded } from './accessRequestService.js';

// ---------------------------------------------------------------------------
// searchService — global command-palette search across the org.
// Per docs/keystore-and-quick-connect.md "Global search":
//   servers/customers  — any member
//   identities/keys    — manager+
//   users/policies     — admin+
// Everything is org-scoped and case-insensitive (contains match). Results are
// ranked exact-match first, then prefix, then contains, within each type.
// ---------------------------------------------------------------------------

export const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, member: 1 };

export const SEARCH_TYPES = ['servers', 'customers', 'users', 'identities', 'keys', 'policies'];

/**
 * getAllowedTypes(role) — pure gating function: which result types a role
 * may see. Unknown/missing roles see nothing (fail closed).
 */
export function getAllowedTypes(role) {
  const rank = ROLE_RANK[role] ?? 0;
  if (rank <= 0) return [];
  const allowed = ['servers', 'customers'];
  if (rank >= ROLE_RANK.manager) allowed.push('identities', 'keys');
  if (rank >= ROLE_RANK.admin) allowed.push('users', 'policies');
  return allowed;
}

// ---------------------------------------------------------------------------
// Ranking — exact match (0) < prefix match (1) < contains match (2).
// ---------------------------------------------------------------------------

function fieldScore(field, qLower) {
  if (field === null || field === undefined || field === '') return 3;
  const fLower = String(field).toLowerCase();
  if (fLower === qLower) return 0;
  if (fLower.startsWith(qLower)) return 1;
  if (fLower.includes(qLower)) return 2;
  return 3;
}

/** Pure: best (lowest) score across a set of candidate fields for one item. */
export function bestScore(fields, q) {
  const qLower = String(q || '').toLowerCase();
  return fields.reduce((min, f) => Math.min(min, fieldScore(f, qLower)), 3);
}

/**
 * rankAndLimit(items, limit) — sorts by ascending _score (ties broken by
 * title, case-insensitive) and truncates to `limit`. Strips the internal
 * _score field from the returned items. Pure function.
 */
export function rankAndLimit(items, limit) {
  return [...items]
    .sort((a, b) => {
      if (a._score !== b._score) return a._score - b._score;
      return String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' });
    })
    .slice(0, limit)
    .map(({ _score, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Per-type fetchers — each returns raw candidate rows already mapped to the
// { id, type, title, subtitle, href, meta, _score } shape. Overfetch beyond
// `limit` so ranking has something to sort before truncation.
// ---------------------------------------------------------------------------

const overfetchFor = (limit) => Math.min(Math.max(limit * 4, 10), 40);

async function searchServers(orgId, q, limit) {
  const like = `%${q}%`;
  const rows = await prisma.$queryRaw`
    SELECT s.id, s.hostname, s.display_name AS "displayName", s.ip_address AS "ipAddress",
           s.description, s.environment, s.protocol, s.auth_mode AS "authMode",
           s.provision_status AS "provisionStatus", s.agent_id AS "agentId",
           s.agent_last_seen AS "agentLastSeen", s.labels::text AS "labelsText",
           c.name AS "customerName"
    FROM servers s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.org_id = ${orgId}
      AND (
        s.hostname ILIKE ${like} OR
        s.display_name ILIKE ${like} OR
        s.ip_address ILIKE ${like} OR
        s.description ILIKE ${like} OR
        s.labels::text ILIKE ${like}
      )
    LIMIT ${overfetchFor(limit)}
  `;

  return rows.map((s) => ({
    id: s.id,
    type: 'servers',
    title: s.displayName || s.hostname,
    subtitle: s.customerName,
    href: `/servers/${s.id}`,
    meta: {
      environment: s.environment,
      protocol: s.protocol,
      authMode: s.authMode,
      ipAddress: s.ipAddress,
      hostname: s.hostname,
      onboarded: isServerOnboarded({
        provisionStatus: s.provisionStatus,
        protocol: s.protocol,
        authMode: s.authMode,
        agentId: s.agentId,
        agentLastSeen: s.agentLastSeen,
      }),
    },
    _score: bestScore([s.hostname, s.displayName, s.ipAddress, s.description, s.labelsText], q),
  }));
}

async function searchCustomers(orgId, q, limit) {
  const rows = await prisma.customer.findMany({
    where: {
      orgId,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: overfetchFor(limit),
    select: { id: true, name: true, slug: true, _count: { select: { servers: true } } },
  });

  return rows.map((c) => ({
    id: c.id,
    type: 'customers',
    title: c.name,
    subtitle: c.slug,
    href: `/customers/${c.id}`,
    meta: { serverCount: c._count.servers },
    _score: bestScore([c.name, c.slug], q),
  }));
}

async function searchUsers(orgId, q, limit) {
  const rows = await prisma.user.findMany({
    where: {
      orgId,
      status: { not: 'deleted' },
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: overfetchFor(limit),
    select: { id: true, name: true, email: true, role: true, status: true },
  });

  return rows.map((u) => ({
    id: u.id,
    type: 'users',
    title: u.name,
    subtitle: u.email,
    href: `/users?highlight=${u.id}`,
    meta: { email: u.email, role: u.role, status: u.status },
    _score: bestScore([u.name, u.email], q),
  }));
}

async function searchIdentities(orgId, q, limit) {
  const rows = await prisma.credential.findMany({
    where: {
      orgId,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: overfetchFor(limit),
    select: { id: true, name: true, username: true, authType: true },
  });

  return rows.map((i) => ({
    id: i.id,
    type: 'identities',
    title: i.name,
    subtitle: i.username,
    href: `/keystore?tab=identities&highlight=${i.id}`,
    meta: { username: i.username, authType: i.authType },
    _score: bestScore([i.name, i.username], q),
  }));
}

async function searchKeys(orgId, q, limit) {
  const rows = await prisma.sshKey.findMany({
    where: {
      orgId,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { fingerprint: { contains: q, mode: 'insensitive' } },
        { comment: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: overfetchFor(limit),
    select: { id: true, name: true, fingerprint: true, keyType: true, comment: true },
  });

  return rows.map((k) => ({
    id: k.id,
    type: 'keys',
    title: k.name,
    subtitle: k.fingerprint,
    href: `/keystore?tab=keys&highlight=${k.id}`,
    meta: { fingerprint: k.fingerprint, keyType: k.keyType },
    _score: bestScore([k.name, k.fingerprint, k.comment], q),
  }));
}

async function searchPolicies(orgId, q, limit) {
  const rows = await prisma.accessPolicy.findMany({
    where: {
      orgId,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: overfetchFor(limit),
    select: { id: true, name: true, description: true, effect: true, isActive: true },
  });

  return rows.map((p) => ({
    id: p.id,
    type: 'policies',
    title: p.name,
    subtitle: p.description || p.effect,
    href: `/policies?highlight=${p.id}`,
    meta: { effect: p.effect, isActive: p.isActive },
    _score: bestScore([p.name, p.description], q),
  }));
}

const FETCHERS = {
  servers: searchServers,
  customers: searchCustomers,
  users: searchUsers,
  identities: searchIdentities,
  keys: searchKeys,
  policies: searchPolicies,
};

/**
 * search({ orgId, role, q, limit }) — role-gated, org-scoped global search.
 * Types the role isn't allowed to see are omitted entirely (empty array,
 * count 0) rather than filtered post-hoc, so nothing gated ever touches the
 * network response.
 */
export async function search({ orgId, role, q, limit = 5 }) {
  const query = String(q || '').trim();
  const allowedTypes = getAllowedTypes(role);

  const results = {};
  const counts = {};
  for (const type of SEARCH_TYPES) {
    results[type] = [];
    counts[type] = 0;
  }

  if (!query || allowedTypes.length === 0) {
    return { results, counts };
  }

  const settled = await Promise.all(
    allowedTypes.map(async (type) => {
      try {
        const items = await FETCHERS[type](orgId, query, limit);
        return [type, items];
      } catch (err) {
        logger.error('[searchService] fetch failed', { type, error: err.message });
        return [type, []];
      }
    }),
  );

  for (const [type, items] of settled) {
    const ranked = rankAndLimit(items, limit);
    results[type] = ranked;
    counts[type] = ranked.length;
  }

  return { results, counts };
}

export default { search, getAllowedTypes, rankAndLimit, bestScore, SEARCH_TYPES, ROLE_RANK };
