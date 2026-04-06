import bcrypt from 'bcryptjs';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import config from '../config/index.js';

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };

function strip(user) {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
}

export async function listUsers(orgId, { page = 1, pageSize = 25, role, status, managerId, search } = {}) {
  page = parseInt(page, 10) || 1;
  pageSize = Math.min(parseInt(pageSize, 10) || 25, 100);

  const where = { orgId };
  if (role) where.role = role;
  if (status) where.status = status;
  if (managerId) where.managerId = managerId;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: { manager: { select: { id: true, name: true } } },
    }),
    prisma.user.count({ where }),
  ]);

  return { items: items.map(strip), total, page, pageSize };
}

export async function getUser(orgId, userId) {
  const user = await prisma.user.findFirst({
    where: { id: userId, orgId },
    include: {
      manager: { select: { id: true, name: true, email: true } },
      directReports: { select: { id: true, name: true, email: true, role: true, status: true } },
    },
  });
  if (!user) throw new ApiError(404, 'User not found');
  return strip(user);
}

export async function createUser(orgId, data, actorRole) {
  const { email, name, password, role = 'viewer', managerId } = data;
  if (!email || !name || !password) {
    throw new ApiError(400, 'email, name, and password are required');
  }

  if (!ROLE_RANK[actorRole] || ROLE_RANK[actorRole] < ROLE_RANK.admin) {
    throw new ApiError(403, 'Insufficient permissions to create users');
  }
  if (!ROLE_RANK[role]) {
    throw new ApiError(400, 'Invalid role');
  }
  if (ROLE_RANK[role] > ROLE_RANK[actorRole]) {
    throw new ApiError(403, 'Cannot create a user with a higher role than your own');
  }
  if (role === 'super_admin' && actorRole !== 'super_admin') {
    throw new ApiError(403, 'Only super_admin can create super_admin');
  }

  if (managerId) {
    const mgr = await prisma.user.findFirst({ where: { id: managerId, orgId } });
    if (!mgr) throw new ApiError(400, 'Manager not found in organization');
  }

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

  try {
    const user = await prisma.user.create({
      data: {
        orgId,
        email,
        name,
        passwordHash,
        role,
        status: 'active',
        managerId: managerId || null,
      },
    });
    return strip(user);
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'Email already exists in organization');
    throw err;
  }
}

async function wouldCreateCycle(orgId, userId, newManagerId) {
  let current = newManagerId;
  const seen = new Set();
  while (current) {
    if (current === userId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const m = await prisma.user.findFirst({
      where: { id: current, orgId },
      select: { managerId: true },
    });
    if (!m) return false;
    current = m.managerId;
  }
  return false;
}

export async function updateUser(orgId, userId, data, actorUserId, actorRole) {
  const existing = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!existing) throw new ApiError(404, 'User not found');

  const updateData = {};

  if (data.name !== undefined) updateData.name = data.name;
  if (data.email !== undefined) updateData.email = data.email;
  if (data.avatarUrl !== undefined) updateData.avatarUrl = data.avatarUrl;

  if (data.role !== undefined && data.role !== existing.role) {
    if (!['super_admin', 'admin'].includes(actorRole)) {
      throw new ApiError(403, 'Only admins can change roles');
    }
    if (!ROLE_RANK[data.role]) throw new ApiError(400, 'Invalid role');
    if (ROLE_RANK[data.role] > ROLE_RANK[actorRole]) {
      throw new ApiError(403, 'Cannot elevate role above your own');
    }
    updateData.role = data.role;
  }

  if (data.status !== undefined) {
    if (!['super_admin', 'admin'].includes(actorRole)) {
      throw new ApiError(403, 'Only admins can change status');
    }
    updateData.status = data.status;
  }

  if (data.managerId !== undefined) {
    if (data.managerId === null) {
      updateData.managerId = null;
    } else {
      if (data.managerId === userId) throw new ApiError(400, 'User cannot be their own manager');
      const mgr = await prisma.user.findFirst({ where: { id: data.managerId, orgId } });
      if (!mgr) throw new ApiError(400, 'Manager not found in organization');
      const cycle = await wouldCreateCycle(orgId, userId, data.managerId);
      if (cycle) throw new ApiError(400, 'Circular manager reference detected');
      updateData.managerId = data.managerId;
    }
  }

  if (data.password) {
    updateData.passwordHash = await bcrypt.hash(data.password, config.bcryptRounds);
  }

  const updated = await prisma.user.update({ where: { id: userId }, data: updateData });
  return strip(updated);
}

export async function deleteUser(orgId, userId) {
  const existing = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!existing) throw new ApiError(404, 'User not found');
  await prisma.user.update({ where: { id: userId }, data: { status: 'deactivated' } });
  return { success: true };
}

const SSH_PREFIXES = ['ssh-rsa ', 'ssh-ed25519 ', 'ecdsa-sha2-'];

export async function uploadSshKey(orgId, userId, publicKey) {
  if (typeof publicKey !== 'string') throw new ApiError(400, 'publicKey must be a string');
  const trimmed = publicKey.trim();
  if (trimmed.length < 20 || trimmed.length > 8192) {
    throw new ApiError(400, 'Invalid SSH key length');
  }
  const hasPrefix = SSH_PREFIXES.some((p) => trimmed.startsWith(p));
  if (!hasPrefix) throw new ApiError(400, 'Unsupported SSH key type');
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || !parts[1]) throw new ApiError(400, 'Invalid SSH key format');

  const existing = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!existing) throw new ApiError(404, 'User not found');

  await prisma.user.update({ where: { id: userId }, data: { sshPublicKey: trimmed } });
  return { success: true };
}

export async function removeSshKey(orgId, userId) {
  const existing = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!existing) throw new ApiError(404, 'User not found');
  await prisma.user.update({ where: { id: userId }, data: { sshPublicKey: null } });
  return { success: true };
}

export async function getDirectReports(orgId, managerId) {
  const users = await prisma.user.findMany({
    where: { orgId, managerId },
    orderBy: { name: 'asc' },
  });
  return users.map(strip);
}
