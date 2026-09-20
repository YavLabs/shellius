/**
 * POST /api/hosts/posture + postureService.ingest — live-DB tests.
 *
 * Covers the parts computeFindings' pure unit tests can't: persistence,
 * the open/continuing/resolved diff against ExposureFinding, the clock-skew
 * / idempotency rule (spec §3 — a late/out-of-order snapshot must never
 * resurrect a resolved finding), and the owner-change close+reopen rule
 * (spec §9.9). Auto-skips when there's no live DB (see testDbHelper.js).
 */

import express from 'express';
import request from 'supertest';
import prisma from '../../config/db.js';
import hostsRouter from '../../routes/hosts.js';
import errorHandler from '../../middleware/errorHandler.js';
import { generateAgentToken } from '../../utils/agentToken.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

function buildApp() {
  const app = express();
  // Mirror app.js's real limit (512kb) — the default 100kb would make
  // body-parser itself reject anything used to exercise the route's own
  // 256KB check before it ever got there.
  app.use(express.json({ limit: '512kb' }));
  app.use('/api/hosts', hostsRouter);
  app.use(errorHandler);
  return app;
}

let seq = 0;
function uniq() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

async function createServer(orgId, overrides = {}) {
  const customer = await prisma.customer.create({
    data: { orgId, name: 'Posture Test Customer', slug: `posture-${uniq()}` },
  });
  return prisma.server.create({
    data: { orgId, customerId: customer.id, hostname: `host-${uniq()}`, ipAddress: '10.0.1.5', ...overrides },
  });
}

function basePayload(overrides = {}) {
  return {
    collectedAt: new Date().toISOString(),
    hostname: 'test-host',
    // No unrelated ALLOW rules with nothing listening on them — that would
    // also raise STALE_FIREWALL_RULE and throw off the finding counts below.
    firewall: {
      engine: 'ufw',
      active: true,
      defaultIncoming: 'deny',
      rules: [
        { port: '5432', proto: 'tcp', action: 'DENY', from: 'Anywhere' },
      ],
    },
    listeners: [
      {
        proto: 'tcp', bind: '0.0.0.0', port: 5432, containerPort: 5432,
        ownerKind: 'docker', ownerName: 'pg-main', ownerDetail: 'postgres:16-alpine', source: 'docker',
      },
    ],
    ...overrides,
  };
}

describe('POST /api/hosts/posture (live DB)', () => {
  const app = buildApp();
  let org;
  let server;
  let token;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    const { token: t, hash } = generateAgentToken();
    token = t;
    server = await createServer(org.id, { agentTokenHash: hash, agentTokenIssuedAt: new Date() });
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.exposureFinding.deleteMany({ where: { orgId: org.id } });
    await prisma.hostListener.deleteMany({ where: { orgId: org.id } });
    await prisma.hostMetricSample.deleteMany({ where: { orgId: org.id } });
    await prisma.hostSnapshot.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
    await prisma.$disconnect().catch(() => {});
  });

  test('rejects without a per-host token (no legacy fallback for posture)', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const res = await request(app)
      .post('/api/hosts/posture')
      .set('x-agent-token', 'shag_bogus_token')
      .send(basePayload());
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('rejects a listeners array over the 500 cap (400, not silent truncation)', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const listeners = Array.from({ length: 501 }, (_, i) => ({
      proto: 'tcp', bind: '127.0.0.1', port: 20000 + i, ownerKind: 'process', ownerName: 'x', source: 'ss',
    }));
    const res = await request(app)
      .post('/api/hosts/posture')
      .set('x-agent-token', token)
      .send(basePayload({ listeners }));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('POSTURE_INVALID_PAYLOAD');
  });

  test('rejects a body over the 256KB cap with 413', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    // Genuinely oversized (real bytes on the wire — a spoofed Content-Length
    // header just makes the server wait for bytes that never arrive), but
    // within the listener-count cap (500) and per-string cap (512) so this
    // exercises the route's own 256KB gate specifically, not Joi's caps and
    // not the shared body-parser's separate 512kb ceiling.
    const listeners = Array.from({ length: 500 }, (_, i) => ({
      proto: 'tcp', bind: '10.0.0.1', port: 1024 + i, ownerName: 'x'.repeat(500), source: 'ss',
    }));
    const res = await request(app)
      .post('/api/hosts/posture')
      .set('x-agent-token', token)
      .send(basePayload({ listeners }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('POSTURE_PAYLOAD_TOO_LARGE');
  }, 15000);

  test('ingests a snapshot: persists it, replaces listeners, opens a DOCKER_FIREWALL_BYPASS finding', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');

    const res = await request(app)
      .post('/api/hosts/posture')
      .set('x-agent-token', token)
      .send(basePayload());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.outOfOrder).toBe(false);
    expect(res.body.data.findings.opened).toBe(1);

    const snap = await prisma.hostSnapshot.findUnique({ where: { id: res.body.data.snapshotId } });
    expect(snap).not.toBeNull();
    expect(snap.serverId).toBe(server.id);

    const listeners = await prisma.hostListener.findMany({ where: { serverId: server.id } });
    expect(listeners).toHaveLength(1);
    expect(listeners[0].reachability).toBe('INTERNET');

    const open = await prisma.exposureFinding.findMany({ where: { orgId: org.id, serverId: server.id, resolvedAt: null } });
    expect(open).toHaveLength(1);
    expect(open[0].code).toBe('DOCKER_FIREWALL_BYPASS');
    expect(open[0].ownerLabel).toBe('docker/pg-main');
  });

  test('a later snapshot that fixes the bind resolves the finding', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');

    const later = new Date(Date.now() + 60_000).toISOString();
    const res = await request(app)
      .post('/api/hosts/posture')
      .set('x-agent-token', token)
      .send(basePayload({
        collectedAt: later,
        listeners: [
          {
            proto: 'tcp', bind: '127.0.0.1', port: 5432, containerPort: 5432,
            ownerKind: 'docker', ownerName: 'pg-main', ownerDetail: 'postgres:16-alpine', source: 'docker',
          },
        ],
      }));

    expect(res.status).toBe(200);
    expect(res.body.data.findings.resolved).toBe(1);

    const open = await prisma.exposureFinding.findMany({ where: { orgId: org.id, serverId: server.id, resolvedAt: null } });
    expect(open).toHaveLength(0);

    const resolved = await prisma.exposureFinding.findMany({ where: { orgId: org.id, serverId: server.id, code: 'DOCKER_FIREWALL_BYPASS' } });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].resolvedAt).not.toBeNull();
  });

  test('clock skew: a late/older retry of the vulnerable snapshot does not resurrect the resolved finding', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');

    // Same (earlier) collectedAt as the very first request in this suite —
    // a retried/duplicated send, arriving after the fix was already recorded.
    const stale = new Date(Date.now() - 3_600_000).toISOString();
    const res = await request(app)
      .post('/api/hosts/posture')
      .set('x-agent-token', token)
      .send(basePayload({ collectedAt: stale }));

    expect(res.status).toBe(200);
    expect(res.body.data.outOfOrder).toBe(true);
    expect(res.body.data.findings).toEqual({ opened: 0, continuing: 0, reopened: 0, resolved: 0 });

    // The already-resolved finding must still be resolved — not reopened.
    const open = await prisma.exposureFinding.findMany({ where: { orgId: org.id, serverId: server.id, resolvedAt: null } });
    expect(open).toHaveLength(0);

    // The stale snapshot is still persisted for history.
    const snap = await prisma.hostSnapshot.findUnique({ where: { id: res.body.data.snapshotId } });
    expect(snap).not.toBeNull();

    // The listener set on display must still reflect the newer, fixed state
    // — a late snapshot must not roll the "current" view backwards either.
    const listeners = await prisma.hostListener.findMany({ where: { serverId: server.id } });
    expect(listeners).toHaveLength(1);
    expect(listeners[0].bind).toBe('127.0.0.1');
  });

  test('owner change on the same (code, proto, port) closes the old finding and opens a fresh one', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');

    // Re-expose 5432 owned by pg-main. A row for this (code, proto, port)
    // already exists (resolved) from the earlier tests, so this is a
    // reopen (UPDATE clearing resolvedAt), not a fresh create — the unique
    // constraint has no open/resolved dimension, so create() would collide.
    const t1 = new Date(Date.now() + 120_000).toISOString();
    const first = await request(app)
      .post('/api/hosts/posture')
      .set('x-agent-token', token)
      .send(basePayload({ collectedAt: t1 }));
    expect(first.body.data.findings.reopened).toBe(1);

    const firstOpen = await prisma.exposureFinding.findFirst({
      where: { orgId: org.id, serverId: server.id, code: 'DOCKER_FIREWALL_BYPASS', resolvedAt: null },
    });
    expect(firstOpen).not.toBeNull();
    expect(firstOpen.ownerLabel).toBe('docker/pg-main');
    const firstId = firstOpen.id;

    // A different container now occupies the same port.
    const t2 = new Date(Date.now() + 180_000).toISOString();
    const second = await request(app)
      .post('/api/hosts/posture')
      .set('x-agent-token', token)
      .send(basePayload({
        collectedAt: t2,
        listeners: [
          {
            proto: 'tcp', bind: '0.0.0.0', port: 5432, containerPort: 5432,
            ownerKind: 'docker', ownerName: 'pg-replica', ownerDetail: 'postgres:16-alpine', source: 'docker',
          },
        ],
      }));

    expect(second.status).toBe(200);
    // Old one closes, new one opens — not a silent mutation.
    expect(second.body.data.findings.opened).toBe(1);

    const stillOpen = await prisma.exposureFinding.findMany({
      where: { orgId: org.id, serverId: server.id, code: 'DOCKER_FIREWALL_BYPASS', resolvedAt: null },
    });
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0].ownerLabel).toBe('docker/pg-replica');
    expect(stillOpen[0].id).not.toBe(firstId);
  });
});
