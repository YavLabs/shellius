import net from 'net';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { encrypt } from '../utils/crypto.js';

const RDP_SENSITIVE_FIELDS = ['rdpPasswordEncrypted', 'rdpPasswordIv', 'rdpPasswordTag'];

function stripRdpSecrets(server) {
  if (!server) return server;
  const result = { ...server };
  result.hasRdpPassword = !!result.rdpPasswordEncrypted;
  for (const f of RDP_SENSITIVE_FIELDS) delete result[f];
  return result;
}

const READ_ONLY = [
  'healthStatus',
  'lastHealthCheck',
  'healthMessage',
  'agentId',
  'agentVersion',
  'agentLastSeen',
  'provisionStatus',
  'provisionError',
  'provisionedAt',
  'lastProvisionAt',
];

const MUTABLE_FIELDS = [
  'hostname',
  'displayName',
  'description',
  'ipAddress',
  'port',
  'protocol',
  'environment',
  'labels',
  'osType',
  'osVersion',
  'cloudProvider',
  'cloudInstanceId',
  'cloudRegion',
  'cloudAccountId',
  'sshUser',
  'sshKeyPath',
  'rdpUsername',
  'isActive',
];

function validateIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return net.isIP(ip) !== 0;
}

export async function listServers(orgId, {
  customerId,
  page = 1,
  pageSize = 25,
  environment,
  healthStatus,
  cloudProvider,
  search,
  isActive,
} = {}) {
  page = parseInt(page, 10) || 1;
  pageSize = Math.min(parseInt(pageSize, 10) || 25, 100);

  const where = { orgId };
  if (customerId) where.customerId = customerId;
  if (environment) where.environment = environment;
  if (healthStatus) where.healthStatus = healthStatus;
  if (cloudProvider) where.cloudProvider = cloudProvider;
  if (isActive !== undefined) where.isActive = isActive === true || isActive === 'true';
  if (search) {
    where.OR = [
      { hostname: { contains: search, mode: 'insensitive' } },
      { displayName: { contains: search, mode: 'insensitive' } },
      { ipAddress: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.server.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: { customer: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.server.count({ where }),
  ]);

  return { items: items.map(stripRdpSecrets), total, page, pageSize };
}

export async function getServer(orgId, serverId) {
  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId },
    include: { customer: { select: { id: true, name: true, slug: true } } },
  });
  if (!server) throw new ApiError(404, 'Server not found');
  return stripRdpSecrets(server);
}

export async function createServer(orgId, customerId, data = {}) {
  if (!customerId) throw new ApiError(400, 'customerId is required');
  const customer = await prisma.customer.findFirst({ where: { id: customerId, orgId } });
  if (!customer) throw new ApiError(400, 'Customer not found in organization');

  if (!data.hostname) throw new ApiError(400, 'hostname is required');
  if (!validateIp(data.ipAddress)) throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');

  const payload = {
    orgId,
    customerId,
    hostname: data.hostname,
    ipAddress: data.ipAddress,
    healthStatus: 'unknown',
  };
  for (const f of MUTABLE_FIELDS) {
    if (data[f] !== undefined && payload[f] === undefined) {
      payload[f] = data[f];
    }
  }
  if (data.rdpPassword) {
    payload.rdpPasswordEncrypted = encrypt(data.rdpPassword);
  }

  const server = await prisma.server.create({
    data: payload,
    include: { customer: { select: { id: true, name: true, slug: true } } },
  });
  return stripRdpSecrets(server);
}

export async function updateServer(orgId, serverId, data = {}) {
  const existing = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!existing) throw new ApiError(404, 'Server not found');

  const updateData = {};
  for (const key of Object.keys(data)) {
    if (READ_ONLY.includes(key)) continue;
    if (!MUTABLE_FIELDS.includes(key)) continue;
    updateData[key] = data[key];
  }

  if (updateData.ipAddress !== undefined && !validateIp(updateData.ipAddress)) {
    throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');
  }
  if (data.rdpPassword) {
    updateData.rdpPasswordEncrypted = encrypt(data.rdpPassword);
  }

  const server = await prisma.server.update({
    where: { id: serverId },
    data: updateData,
    include: { customer: { select: { id: true, name: true, slug: true } } },
  });
  return stripRdpSecrets(server);
}

export async function deleteServer(orgId, serverId) {
  const existing = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!existing) throw new ApiError(404, 'Server not found');
  await prisma.server.delete({ where: { id: serverId } });
  return { success: true };
}

export async function bulkUpdateEnvironment(orgId, serverIds, environment) {
  if (!Array.isArray(serverIds) || serverIds.length === 0) {
    throw new ApiError(400, 'serverIds must be a non-empty array');
  }
  const result = await prisma.server.updateMany({
    where: { id: { in: serverIds }, orgId },
    data: { environment },
  });
  return { updated: result.count };
}

export async function getServersByLabel(orgId, labels) {
  const labelArray = Array.isArray(labels) ? labels : [labels];
  try {
    return await prisma.server.findMany({
      where: { orgId, labels: { array_contains: labelArray } },
      include: { customer: { select: { id: true, name: true, slug: true } } },
    });
  } catch {
    const all = await prisma.server.findMany({
      where: { orgId },
      include: { customer: { select: { id: true, name: true, slug: true } } },
    });
    return all.filter((s) => {
      const arr = Array.isArray(s.labels) ? s.labels : [];
      return labelArray.every((l) => arr.includes(l));
    });
  }
}
