/**
 * terminalRecoveryService + reconcileOrphanedSessions — what a workspace tab
 * can do after its live session is gone. Live-DB integration test
 * (dbReachable() skip pattern, see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import { describe as describeRecovery, reconnect } from '../terminalRecoveryService.js';
import { reconcileOrphanedSessions } from '../terminalService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

describe('terminal session recovery', () => {
  let reachable;
  let org;
  let user;
  let other;
  let server;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] terminalRecovery: no live DB');
      return;
    }
    org = await createTestOrg();
    user = await createTestUser(org.id, { role: 'member' });
    other = await createTestUser(org.id, { role: 'member' });
    const customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${Date.now()}` },
    });
    server = await prisma.server.create({
      data: { orgId: org.id, customerId: customer.id, hostname: 'app-1.internal', ipAddress: '10.20.0.1', environment: 'dev' },
    });
  });

  afterAll(async () => {
    if (reachable && org) await cleanupOrg(org.id);
  });

  const maybeTest = (name, fn) =>
    test(name, async () => {
      if (!reachable) return;
      await fn();
    });

  const inOneHour = () => new Date(Date.now() + 3600_000);

  function makeRequest(overrides = {}) {
    return prisma.accessRequest.create({
      data: {
        orgId: org.id,
        requesterId: user.id,
        serverId: server.id,
        status: 'APPROVED',
        reason: 'recovery test',
        requestedPrincipal: 'deploy',
        requestedDuration: 3600,
        expiresAt: inOneHour(),
        ...overrides,
      },
    });
  }

  function makeSession(overrides = {}) {
    return prisma.session.create({
      data: {
        orgId: org.id,
        userId: user.id,
        sessionType: 'SSH',
        authMethod: 'certificate',
        targetHost: '10.20.0.1',
        targetPort: 22,
        targetUser: 'deploy',
        status: 'ENDED',
        endedAt: new Date(),
        ...overrides,
      },
    });
  }

  const owner = () => ({ userId: user.id, orgId: org.id, role: 'member' });

  maybeTest('startup sweep closes ACTIVE SSH rows left by a crashed process', async () => {
    const orphan = await makeSession({ status: 'ACTIVE', endedAt: null, serverId: server.id });
    const rdp = await makeSession({ status: 'ACTIVE', endedAt: null, sessionType: 'RDP', serverId: server.id });
    await reconcileOrphanedSessions({ orgId: org.id });
    const after = await prisma.session.findUnique({ where: { id: orphan.id } });
    expect(after.status).toBe('ENDED');
    expect(after.metadata.endReason).toBe('server_restart');
    expect((await prisma.session.findUnique({ where: { id: rdp.id } })).status).toBe('ACTIVE');
  });

  maybeTest('access still valid → reconnect on the same request, keeping the principal', async () => {
    const ar = await makeRequest();
    const s = await makeSession({
      serverId: server.id,
      accessRequestId: ar.id,
      metadata: { endReason: 'server_restart', principal: 'deploy' },
    });
    const info = await describeRecovery(s.id, owner());
    expect(info).toMatchObject({ action: 'reconnect', endReason: 'server_restart', requestId: ar.id, principal: 'deploy' });
    expect(await reconnect(s.id, owner())).toEqual({ connect: { requestId: ar.id, principal: 'deploy' } });
  });

  maybeTest('an ACTIVE row with no live hub session reads as server_restart', async () => {
    const ar = await makeRequest();
    const s = await makeSession({ serverId: server.id, accessRequestId: ar.id, status: 'ACTIVE', endedAt: null });
    const info = await describeRecovery(s.id, owner());
    expect(info.endReason).toBe('server_restart');
    expect(info.live).toBe(false);
  });

  maybeTest('expired access → request access again; reconnect refused', async () => {
    await prisma.accessRequest.updateMany({ where: { orgId: org.id }, data: { status: 'EXPIRED' } });
    const ar = await makeRequest({ status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000) });
    const s = await makeSession({ serverId: server.id, accessRequestId: ar.id, metadata: { endReason: 'expired' } });
    const info = await describeRecovery(s.id, owner());
    expect(info.action).toBe('request_access');
    expect(info.actionDetail).toMatch(/expired/i);
    await expect(reconnect(s.id, owner())).rejects.toMatchObject({ statusCode: 409, code: 'CANNOT_RECONNECT' });
  });

  maybeTest('revoked access with a newer approved request → reconnect on the newer one', async () => {
    const old = await makeRequest({ status: 'REVOKED' });
    const newer = await makeRequest();
    const s = await makeSession({
      serverId: server.id,
      accessRequestId: old.id,
      metadata: { endReason: 'expired', principal: 'deploy' },
    });
    const info = await describeRecovery(s.id, owner());
    expect(info).toMatchObject({ action: 'reconnect', requestId: newer.id });
    expect(info.principal).toBeUndefined(); // principal only carried over on the same request
    await prisma.accessRequest.update({ where: { id: newer.id }, data: { status: 'EXPIRED' } });
  });

  maybeTest('a pending request for the server → open it', async () => {
    const old = await makeRequest({ status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000) });
    const pending = await makeRequest({ status: 'PENDING', expiresAt: null });
    const s = await makeSession({ serverId: server.id, accessRequestId: old.id });
    expect(await describeRecovery(s.id, owner())).toMatchObject({ action: 'pending', requestId: pending.id });
    await prisma.accessRequest.update({ where: { id: pending.id }, data: { status: 'DENIED' } });
  });

  maybeTest('Quick Connect with a one-off password → prefilled Quick Connect, no secrets', async () => {
    const s = await makeSession({
      authMethod: 'quick_connect',
      targetHost: '203.0.113.5',
      targetUser: 'root',
      metadata: { endReason: 'server_restart', quickConnect: { authType: 'password', credentialId: null } },
    });
    const info = await describeRecovery(s.id, owner());
    expect(info.action).toBe('quick_connect');
    expect(info.prefill).toEqual({ host: '203.0.113.5', port: 22, username: 'root', authTab: 'password' });
    expect(JSON.stringify(info)).not.toMatch(/password"\s*:\s*"/);
  });

  maybeTest('Quick Connect with a saved identity → reconnect', async () => {
    const cred = await prisma.credential.create({
      data: { orgId: org.id, name: `id-${Date.now()}`, username: 'deploy', authType: 'password', passwordEncrypted: 'enc' },
    });
    const s = await makeSession({
      authMethod: 'quick_connect',
      targetHost: '203.0.113.6',
      metadata: { quickConnect: { authType: 'credential', credentialId: cred.id } },
    });
    expect(await describeRecovery(s.id, owner())).toMatchObject({ action: 'reconnect', kind: 'quick_connect' });

    await prisma.credential.delete({ where: { id: cred.id } });
    const gone = await describeRecovery(s.id, owner());
    expect(gone.action).toBe('quick_connect');
    expect(gone.prefill.credentialId).toBeUndefined();
  });

  maybeTest("another user's session is a 404", async () => {
    const s = await makeSession({ serverId: server.id });
    await expect(describeRecovery(s.id, { userId: other.id, orgId: org.id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(reconnect(s.id, { userId: other.id, orgId: org.id, role: 'member' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
