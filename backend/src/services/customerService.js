import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { customerScopeWhere, isUnscoped } from '../lib/scope.js';

const SLUG_RE = /^[a-z0-9-]{3,30}$/;

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

// Whitelisted sort keys — never pass sortBy straight into Prisma's orderBy.
const CUSTOMER_SORTABLE = {
  name: (dir) => ({ name: dir }),
  slug: (dir) => ({ slug: dir }),
  servers: (dir) => ({ servers: { _count: dir } }),
  status: (dir) => ({ isActive: dir }),
};

export async function listCustomers(orgId, { page = 1, pageSize = 25, search, isActive, hasServers, sortBy, sortDir } = {}, scope) {
  page = parseInt(page, 10) || 1;
  pageSize = Math.min(parseInt(pageSize, 10) || 25, 100);

  const where = { orgId, ...customerScopeWhere(scope) };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { slug: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (isActive !== undefined) {
    where.isActive = isActive === true || isActive === 'true';
  }
  if (hasServers === 'yes' || hasServers === true) {
    where.servers = { some: {} };
  } else if (hasServers === 'no' || hasServers === false) {
    where.servers = { none: {} };
  }

  const dir = sortDir === 'desc' ? 'desc' : 'asc';
  const orderBy = CUSTOMER_SORTABLE[sortBy] ? CUSTOMER_SORTABLE[sortBy](dir) : { createdAt: 'desc' };

  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy,
      include: { _count: { select: { servers: true } } },
    }),
    prisma.customer.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getCustomer(orgId, customerId, scope) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, orgId, AND: [customerScopeWhere(scope)] },
    include: { _count: { select: { servers: true } } },
  });
  if (!customer) throw new ApiError(404, 'Customer not found');
  return customer;
}

/**
 * @param {string} orgId
 * @param {{ name, slug, description, metadata }} input
 * @param {{mode,customerIds}} [scope] - the creator's effective scope
 * @param {string} [creatorId] - when the creator is scoped, they're added to
 *   the new customer's UserCustomerScope below, so creating a customer they
 *   then can't see isn't a trap (spec §4.2 #30).
 */
export async function createCustomer(orgId, { name, slug, description, metadata } = {}, scope, creatorId) {
  if (!name) throw new ApiError(400, 'name is required');

  let finalSlug = slug ? String(slug).toLowerCase().trim() : slugify(name);
  if (!SLUG_RE.test(finalSlug)) {
    throw new ApiError(
      400,
      'slug must be 3-30 characters, lowercase letters, numbers and hyphens only'
    );
  }

  try {
    const customer = await prisma.customer.create({
      data: {
        orgId,
        name,
        slug: finalSlug,
        description: description || null,
        metadata: metadata ?? undefined,
      },
      include: { _count: { select: { servers: true } } },
    });
    // A scoped user who creates a customer would otherwise immediately lose
    // sight of it — nothing else grants them a UserCustomerScope row for a
    // customer that didn't exist a moment ago. Add them explicitly rather
    // than widening their scope to ALL or refusing the create (spec §4.2 #30).
    if (!isUnscoped(scope) && creatorId) {
      await prisma.userCustomerScope.create({
        data: { userId: creatorId, customerId: customer.id },
      });
    }
    return customer;
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'Customer slug already exists');
    throw err;
  }
}

export async function updateCustomer(orgId, customerId, { name, description, metadata, isActive } = {}, scope) {
  const existing = await prisma.customer.findFirst({ where: { id: customerId, orgId, AND: [customerScopeWhere(scope)] } });
  if (!existing) throw new ApiError(404, 'Customer not found');

  const data = {};
  if (name !== undefined) data.name = name;
  if (description !== undefined) data.description = description;
  if (metadata !== undefined) data.metadata = metadata;
  if (isActive !== undefined) data.isActive = !!isActive;

  const customer = await prisma.customer.update({
    where: { id: customerId },
    data,
    include: { _count: { select: { servers: true } } },
  });
  return customer;
}

/** Dependents that must be handled before a customer can be deleted. */
export async function getDeleteImpact(orgId, customerId, scope) {
  const existing = await prisma.customer.findFirst({ where: { id: customerId, orgId, AND: [customerScopeWhere(scope)] } });
  if (!existing) throw new ApiError(404, 'Customer not found');
  const [servers, policies] = await Promise.all([
    prisma.server.findMany({
      where: { orgId, customerId },
      select: { id: true, hostname: true, displayName: true },
    }),
    prisma.accessPolicy.findMany({
      where: { orgId, customerId },
      select: { id: true, name: true },
    }),
  ]);
  return {
    customer: { id: existing.id, name: existing.name },
    servers,
    serverCount: servers.length,
    policies,
    policyCount: policies.length,
  };
}

/**
 * Delete a customer, resolving its dependents per the chosen strategy.
 * options.servers: 'reassign' (→ targetCustomerId) | 'delete' (cascade)
 * options.policies: 'orgwide' (default, SetNull) | 'delete'
 */
export async function deleteCustomer(orgId, customerId, options = {}, scope) {
  const existing = await prisma.customer.findFirst({
    where: { id: customerId, orgId, AND: [customerScopeWhere(scope)] },
    include: { _count: { select: { servers: true } } },
  });
  if (!existing) throw new ApiError(404, 'Customer not found');

  if (existing._count.servers > 0) {
    const strategy = options.servers;
    if (strategy === 'reassign') {
      const target = options.targetCustomerId;
      if (!target || target === customerId) {
        throw new ApiError(400, 'A different target customer is required to reassign servers');
      }
      const targetCustomer = await prisma.customer.findFirst({
        where: { id: target, orgId, AND: [customerScopeWhere(scope)] },
      });
      if (!targetCustomer) throw new ApiError(400, 'Target customer not found');
      await prisma.server.updateMany({ where: { customerId, orgId }, data: { customerId: target } });
    } else if (strategy !== 'delete') {
      // No explicit choice — refuse rather than silently cascade-delete servers.
      throw new ApiError(409, 'Customer has servers; choose to reassign or delete them.');
    }
    // strategy 'delete' → servers cascade-delete with the customer below.
  }

  if (options.policies === 'delete') {
    await prisma.accessPolicy.deleteMany({ where: { orgId, customerId } });
  } else if (options.policies === 'reassign') {
    const target = options.policiesTargetCustomerId || options.targetCustomerId;
    if (!target || target === customerId) {
      throw new ApiError(400, 'A different target customer is required to reassign policies');
    }
    const targetCustomer = await prisma.customer.findFirst({
      where: { id: target, orgId, AND: [customerScopeWhere(scope)] },
    });
    if (!targetCustomer) throw new ApiError(400, 'Target customer not found for policies');
    await prisma.accessPolicy.updateMany({ where: { orgId, customerId }, data: { customerId: target } });
  } else {
    // No explicit choice: switch the customer's policies OFF before the FK
    // nulls their customerId. Left active, a customer-scoped ALLOW policy
    // would silently start matching every server in the org (docs/rbac F-13).
    await prisma.accessPolicy.updateMany({ where: { orgId, customerId }, data: { isActive: false } });
  }

  await prisma.customer.delete({ where: { id: customerId } });
  return { success: true };
}

export async function getCustomerStats(orgId, customerId, scope) {
  const existing = await prisma.customer.findFirst({ where: { id: customerId, orgId, AND: [customerScopeWhere(scope)] } });
  if (!existing) throw new ApiError(404, 'Customer not found');

  const [envGroups, healthGroups, total] = await Promise.all([
    prisma.server.groupBy({
      by: ['environment'],
      where: { orgId, customerId },
      _count: { _all: true },
    }),
    prisma.server.groupBy({
      by: ['healthStatus'],
      where: { orgId, customerId },
      _count: { _all: true },
    }),
    prisma.server.count({ where: { orgId, customerId } }),
  ]);

  const byEnvironment = { demo: 0, dev: 0, staging: 0, prod: 0 };
  for (const g of envGroups) byEnvironment[g.environment] = g._count._all;

  const byHealth = { healthy: 0, unhealthy: 0, unknown: 0, maintenance: 0 };
  for (const g of healthGroups) byHealth[g.healthStatus] = g._count._all;

  return { byEnvironment, byHealth, total };
}
