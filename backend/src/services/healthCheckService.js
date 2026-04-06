import net from 'net';
import prisma from '../config/db.js';
import logger from '../utils/logger.js';

const CONCURRENCY = 10;
const TIMEOUT_MS = 10000;

export async function checkServer(server) {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(TIMEOUT_MS);
    socket.on('connect', () => {
      finish({
        status: 'healthy',
        latency: Date.now() - start,
        message: 'TCP connection successful',
      });
    });
    socket.on('timeout', () => {
      finish({ status: 'unhealthy', message: 'Connection timeout' });
    });
    socket.on('error', (err) => {
      finish({ status: 'unhealthy', message: err.code || err.message });
    });
    try {
      socket.connect(server.port, server.ipAddress);
    } catch (err) {
      finish({ status: 'unhealthy', message: err.message });
    }
  });
}

async function applyResultAndAudit(server, result) {
  const transition =
    (server.healthStatus === 'healthy' && result.status === 'unhealthy') ||
    (server.healthStatus === 'unhealthy' && result.status === 'healthy');

  await prisma.server.update({
    where: { id: server.id },
    data: {
      healthStatus: result.status,
      lastHealthCheck: new Date(),
      healthMessage: result.message || null,
    },
  });

  if (transition) {
    try {
      await prisma.auditLog.create({
        data: {
          orgId: server.orgId,
          action: 'server.health_transition',
          resourceType: 'server',
          resourceId: server.id,
          metadata: {
            from: server.healthStatus,
            to: result.status,
            message: result.message || null,
            latency: result.latency ?? null,
          },
        },
      });
    } catch (err) {
      logger.error('Failed to write health transition audit log:', err);
    }
  }
}

export async function checkAllServers(orgId) {
  const where = { isActive: true, healthStatus: { not: 'maintenance' } };
  if (orgId) where.orgId = orgId;
  const servers = await prisma.server.findMany({ where });

  let checked = 0;
  for (let i = 0; i < servers.length; i += CONCURRENCY) {
    const batch = servers.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (s) => {
        const r = await checkServer(s);
        await applyResultAndAudit(s, r);
        return r;
      })
    );
    checked += results.length;
  }
  return { total: servers.length, checked };
}

export async function checkCustomerServers(customerId) {
  const servers = await prisma.server.findMany({
    where: { customerId, isActive: true, healthStatus: { not: 'maintenance' } },
  });
  for (let i = 0; i < servers.length; i += CONCURRENCY) {
    const batch = servers.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (s) => {
        const r = await checkServer(s);
        await applyResultAndAudit(s, r);
      })
    );
  }
  return { total: servers.length };
}

export async function getHealthSummary(orgId) {
  const groups = await prisma.server.groupBy({
    by: ['healthStatus'],
    where: { orgId },
    _count: { _all: true },
  });
  const summary = { healthy: 0, unhealthy: 0, unknown: 0, maintenance: 0, total: 0 };
  for (const g of groups) {
    summary[g.healthStatus] = g._count._all;
    summary.total += g._count._all;
  }
  return summary;
}

export async function runHealthCheckForServer(orgId, serverId) {
  const server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!server) return null;
  const result = await checkServer(server);
  await applyResultAndAudit(server, result);
  return prisma.server.findFirst({
    where: { id: serverId, orgId },
    include: { customer: { select: { id: true, name: true, slug: true } } },
  });
}
