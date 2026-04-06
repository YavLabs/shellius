import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';

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

export async function listCustomers(orgId, { page = 1, pageSize = 25, search, isActive } = {}) {
  page = parseInt(page, 10) || 1;
  pageSize = Math.min(parseInt(pageSize, 10) || 25, 100);

  const where = { orgId };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { slug: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (isActive !== undefined) {
    where.isActive = isActive === true || isActive === 'true';
  }

  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { servers: true } } },
    }),
    prisma.customer.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getCustomer(orgId, customerId) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, orgId },
    include: { _count: { select: { servers: true } } },
  });
  if (!customer) throw new ApiError(404, 'Customer not found');
  return customer;
}

export async function createCustomer(orgId, { name, slug, description, metadata } = {}) {
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
    return customer;
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'Customer slug already exists');
    throw err;
  }
}

export async function updateCustomer(orgId, customerId, { name, description, metadata, isActive } = {}) {
  const existing = await prisma.customer.findFirst({ where: { id: customerId, orgId } });
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

export async function deleteCustomer(orgId, customerId) {
  const existing = await prisma.customer.findFirst({
    where: { id: customerId, orgId },
    include: { _count: { select: { servers: true } } },
  });
  if (!existing) throw new ApiError(404, 'Customer not found');
  if (existing._count.servers > 0) {
    throw new ApiError(
      409,
      'Cannot delete customer with existing servers. Deactivate instead.'
    );
  }
  await prisma.customer.delete({ where: { id: customerId } });
  return { success: true };
}

export async function getCustomerStats(orgId, customerId) {
  const existing = await prisma.customer.findFirst({ where: { id: customerId, orgId } });
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
