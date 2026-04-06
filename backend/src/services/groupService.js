import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';

function stripUser(user) {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
}

export async function listGroups(orgId) {
  const groups = await prisma.group.findMany({
    where: { orgId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { memberships: true } } },
  });
  return groups;
}

export async function getGroup(orgId, groupId) {
  const group = await prisma.group.findFirst({
    where: { id: groupId, orgId },
    include: {
      memberships: {
        include: { user: true, addedBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!group) throw new ApiError(404, 'Group not found');
  return {
    ...group,
    memberships: group.memberships.map((m) => ({
      ...m,
      user: stripUser(m.user),
    })),
  };
}

export async function createGroup(orgId, { name, description }) {
  if (!name || typeof name !== 'string') throw new ApiError(400, 'name is required');
  try {
    return await prisma.group.create({
      data: { orgId, name, description: description || null },
    });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'Group name already exists');
    throw err;
  }
}

export async function updateGroup(orgId, groupId, data) {
  const existing = await prisma.group.findFirst({ where: { id: groupId, orgId } });
  if (!existing) throw new ApiError(404, 'Group not found');
  const updateData = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  try {
    return await prisma.group.update({ where: { id: groupId }, data: updateData });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'Group name already exists');
    throw err;
  }
}

export async function deleteGroup(orgId, groupId) {
  const existing = await prisma.group.findFirst({ where: { id: groupId, orgId } });
  if (!existing) throw new ApiError(404, 'Group not found');
  await prisma.group.delete({ where: { id: groupId } });
  return { success: true };
}

export async function addMember(orgId, groupId, userId, addedById) {
  const group = await prisma.group.findFirst({ where: { id: groupId, orgId } });
  if (!group) throw new ApiError(404, 'Group not found');
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) throw new ApiError(404, 'User not found in organization');

  try {
    return await prisma.groupMembership.create({
      data: { groupId, userId, addedById: addedById || null },
    });
  } catch (err) {
    if (err.code === 'P2002') throw new ApiError(409, 'User is already a member');
    throw err;
  }
}

export async function removeMember(orgId, groupId, userId) {
  const group = await prisma.group.findFirst({ where: { id: groupId, orgId } });
  if (!group) throw new ApiError(404, 'Group not found');
  const membership = await prisma.groupMembership.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  if (!membership) throw new ApiError(404, 'Membership not found');
  await prisma.groupMembership.delete({ where: { id: membership.id } });
  return { success: true };
}

export async function getUserGroups(orgId, userId) {
  const memberships = await prisma.groupMembership.findMany({
    where: { userId, group: { orgId } },
    include: { group: true },
    orderBy: { createdAt: 'asc' },
  });
  return memberships.map((m) => m.group);
}
