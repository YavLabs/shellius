import net from 'net';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { encrypt } from '../utils/crypto.js';
import * as terminalService from './terminalService.js';

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
  'dynamicIp',
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
  'authMode',
  'credentialId',
];

const CUSTOMER_SELECT = { select: { id: true, name: true, slug: true } };
const CREDENTIAL_SELECT = { select: { id: true, name: true, username: true, authType: true } };
const SERVER_INCLUDE = { customer: CUSTOMER_SELECT, credential: CREDENTIAL_SELECT };

function validateIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return net.isIP(ip) !== 0;
}

/**
 * Validate authMode/credentialId consistency and that credentialId (when
 * present) belongs to this org. Returns a patch to merge into the write
 * payload (credentialId forced to null for authMode='certificate').
 */
async function validateAuthMode(orgId, { authMode, credentialId }) {
  if (authMode === undefined && credentialId === undefined) return {};
  if (authMode === 'credential') {
    if (!credentialId) {
      throw new ApiError(400, 'credentialId is required when authMode is "credential"');
    }
    const credential = await prisma.credential.findFirst({ where: { id: credentialId, orgId } });
    if (!credential) throw new ApiError(400, 'credentialId not found in organization');
    return { authMode: 'credential', credentialId };
  }
  if (authMode === 'certificate') {
    return { authMode: 'certificate', credentialId: null };
  }
  // authMode not changing, but credentialId was — validate it belongs to org.
  if (credentialId) {
    const credential = await prisma.credential.findFirst({ where: { id: credentialId, orgId } });
    if (!credential) throw new ApiError(400, 'credentialId not found in organization');
  }
  return credentialId !== undefined ? { credentialId } : {};
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
      include: SERVER_INCLUDE,
    }),
    prisma.server.count({ where }),
  ]);

  return { items: items.map(stripRdpSecrets), total, page, pageSize };
}

export async function getServer(orgId, serverId) {
  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId },
    include: SERVER_INCLUDE,
  });
  if (!server) throw new ApiError(404, 'Server not found');
  return stripRdpSecrets(server);
}

export async function createServer(orgId, customerId, data = {}) {
  if (!customerId) throw new ApiError(400, 'customerId is required');
  const customer = await prisma.customer.findFirst({ where: { id: customerId, orgId } });
  if (!customer) throw new ApiError(400, 'Customer not found in organization');

  if (!data.hostname) throw new ApiError(400, 'hostname is required');
  // dynamicIp servers resolve their address at connect time, so an ipAddress is
  // optional at create. If one is supplied it must still be valid. Static
  // servers require a valid IP.
  const isDynamic = data.dynamicIp === true;
  const ip = (data.ipAddress ?? '').trim();
  if (isDynamic) {
    if (ip && !validateIp(ip)) throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');
  } else if (!validateIp(ip)) {
    throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');
  }

  const payload = {
    orgId,
    customerId,
    hostname: data.hostname,
    ipAddress: ip,
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

  const authPatch = await validateAuthMode(orgId, { authMode: data.authMode, credentialId: data.credentialId });
  Object.assign(payload, authPatch);

  const server = await prisma.server.create({
    data: payload,
    include: SERVER_INCLUDE,
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

  if (updateData.ipAddress !== undefined) {
    // Determine the effective dynamicIp state after this update.
    const willBeDynamic =
      data.dynamicIp !== undefined ? data.dynamicIp === true : existing.dynamicIp === true;
    const ip = (updateData.ipAddress ?? '').trim();
    if (willBeDynamic) {
      if (ip && !validateIp(ip)) {
        throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');
      }
    } else if (!validateIp(ip)) {
      throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');
    }
    updateData.ipAddress = ip;
  }
  if (data.rdpPassword) {
    updateData.rdpPasswordEncrypted = encrypt(data.rdpPassword);
  }

  if (updateData.authMode !== undefined || updateData.credentialId !== undefined) {
    const authPatch = await validateAuthMode(orgId, {
      authMode: updateData.authMode,
      credentialId: updateData.credentialId,
    });
    Object.assign(updateData, authPatch);
  }

  const server = await prisma.server.update({
    where: { id: serverId },
    data: updateData,
    include: SERVER_INCLUDE,
  });
  return stripRdpSecrets(server);
}

/**
 * Clear a server's pinned SSH host key (TOFU reset). Admin-only at the route
 * level; audited. The next ssh2 connect will re-pin on first contact.
 */
export async function resetHostKey(orgId, serverId) {
  const existing = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!existing) throw new ApiError(404, 'Server not found');
  const server = await prisma.server.update({
    where: { id: serverId },
    data: { hostKeyFingerprint: null, hostKeyAlgorithm: null, hostKeyPinnedAt: null },
    include: SERVER_INCLUDE,
  });
  return stripRdpSecrets(server);
}

/** Dependents removed when this server is deleted (for the confirm dialog). */
export async function getDeleteImpact(orgId, serverId) {
  const server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!server) throw new ApiError(404, 'Server not found');
  const [activeSessions, totalSessions, pendingRequests, certificates] = await Promise.all([
    prisma.session.count({ where: { orgId, serverId, status: 'ACTIVE' } }),
    prisma.session.count({ where: { orgId, serverId } }),
    prisma.accessRequest.count({ where: { orgId, serverId, status: { in: ['PENDING', 'APPROVED'] } } }),
    prisma.certificate.count({ where: { orgId, issuedForId: serverId } }),
  ]);
  return {
    server: { id: server.id, hostname: server.hostname, displayName: server.displayName },
    isCloud: !!server.cloudProvider,
    cloudProvider: server.cloudProvider || null,
    activeSessions,
    totalSessions,
    pendingRequests,
    certificates,
  };
}

/**
 * Hard-delete a server. Force-terminates any live session first (so the cascade
 * removes already-terminated rows), then deletes — which cascades AccessRequest
 * + Session rows and SetNulls issued certificates.
 */
export async function deleteServer(orgId, serverId, callerId = null) {
  const existing = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!existing) throw new ApiError(404, 'Server not found');
  await terminalService.terminateActiveSessionsFor(orgId, { serverId }, callerId);
  await prisma.server.delete({ where: { id: serverId } });
  return { success: true };
}

export async function bulkUpdateEnvironment(orgId, serverIds, environment) {
  return bulkUpdate(orgId, serverIds, { environment });
}

// Fields that can be changed in bulk. customerId is validated below.
const BULK_FIELDS = ['environment', 'protocol', 'osType', 'osVersion', 'sshUser', 'isActive', 'customerId'];

export async function bulkUpdate(orgId, serverIds, patch = {}) {
  if (!Array.isArray(serverIds) || serverIds.length === 0) {
    throw new ApiError(400, 'serverIds must be a non-empty array');
  }
  const data = {};
  for (const f of BULK_FIELDS) {
    if (patch[f] !== undefined) data[f] = patch[f];
  }
  if (Object.keys(data).length === 0) {
    throw new ApiError(400, 'No updatable fields provided');
  }
  // If reassigning the customer, ensure it belongs to this org.
  if (data.customerId) {
    const customer = await prisma.customer.findFirst({ where: { id: data.customerId, orgId } });
    if (!customer) throw new ApiError(400, 'Customer not found in organization');
  }
  const result = await prisma.server.updateMany({
    where: { id: { in: serverIds }, orgId },
    data,
  });
  return { updated: result.count };
}

/**
 * Update just the connection IP of a server whose IP is marked non-static.
 * Available to anyone who can connect (members included) so a changed cloud IP
 * doesn't block access; only allowed when the server is flagged dynamicIp.
 */
export async function updateConnectionIp(orgId, serverId, ipAddress) {
  const server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!server) throw new ApiError(404, 'Server not found');
  if (!server.dynamicIp) {
    throw new ApiError(400, 'This server does not have a changeable IP');
  }
  if (!validateIp(ipAddress)) {
    throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');
  }
  const updated = await prisma.server.update({
    where: { id: serverId },
    data: { ipAddress },
    include: SERVER_INCLUDE,
  });
  return stripRdpSecrets(updated);
}

export async function getServersByLabel(orgId, labels) {
  const labelArray = Array.isArray(labels) ? labels : [labels];
  try {
    return await prisma.server.findMany({
      where: { orgId, labels: { array_contains: labelArray } },
      include: SERVER_INCLUDE,
    });
  } catch {
    const all = await prisma.server.findMany({
      where: { orgId },
      include: SERVER_INCLUDE,
    });
    return all.filter((s) => {
      const arr = Array.isArray(s.labels) ? s.labels : [];
      return labelArray.every((l) => arr.includes(l));
    });
  }
}
