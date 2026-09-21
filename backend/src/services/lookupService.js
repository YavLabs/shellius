/**
 * lookupService.js — small, searchable option lists for filter pickers.
 *
 * Filter dropdowns used to load `listServers({ pageSize: 200 })` and the
 * like, which the list APIs cap at 100 — so the 101st server could never be
 * picked, and nothing said so. A picker now asks for what matches what the
 * user typed (and, to label a value already in the URL, for specific ids).
 *
 * Every query is org-scoped; servers and customers are also narrowed to the
 * caller's customer scope, exactly as the full lists are.
 */
import prisma from '../config/db.js';
import { serverScopeWhere, customerScopeWhere } from '../lib/scope.js';

const contains = (q) => ({ contains: q, mode: 'insensitive' });

export async function lookupServers(orgId, scope, { q, ids, limit }) {
  const where = { orgId, ...serverScopeWhere(scope) };
  if (ids?.length) where.id = { in: ids };
  else if (q) where.OR = [{ hostname: contains(q) }, { displayName: contains(q) }, { ipAddress: contains(q) }];
  const rows = await prisma.server.findMany({
    where,
    take: limit,
    orderBy: [{ displayName: 'asc' }, { hostname: 'asc' }],
    select: { id: true, hostname: true, displayName: true, environment: true, customer: { select: { name: true } } },
  });
  return rows.map((r) => ({
    value: r.id,
    label: r.displayName || r.hostname,
    sublabel: [r.displayName && r.displayName !== r.hostname ? r.hostname : null, r.customer?.name, r.environment?.toUpperCase()]
      .filter(Boolean)
      .join(' · '),
  }));
}

export async function lookupCustomers(orgId, scope, { q, ids, limit }) {
  const where = { orgId, AND: [customerScopeWhere(scope)] };
  if (ids?.length) where.id = { in: ids };
  else if (q) where.name = contains(q);
  const rows = await prisma.customer.findMany({ where, take: limit, orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } });
  return rows.map((r) => ({ value: r.id, label: r.name, sublabel: r.slug }));
}

export async function lookupUsers(orgId, { q, ids, limit }) {
  const where = { orgId };
  if (ids?.length) where.id = { in: ids };
  else if (q) where.OR = [{ name: contains(q) }, { email: contains(q) }];
  const rows = await prisma.user.findMany({ where, take: limit, orderBy: { name: 'asc' }, select: { id: true, name: true, email: true } });
  return rows.map((r) => ({ value: r.id, label: r.name || r.email, sublabel: r.name ? r.email : '' }));
}

export default { lookupServers, lookupCustomers, lookupUsers };
