/**
 * Collector state — degraded, refused, stale — and the bookkeeping that
 * makes a refused host visible.
 *
 * The bug this pins: a host whose every snapshot the API refused looked, in
 * the UI, exactly like a host whose collector had died ("stopped reporting",
 * last snapshot hours old, old degraded banner still up), and reinstalling
 * the collector changed nothing. And a DEGRADED host was listed by the
 * installer as "Already done — reporting", with no way to re-run on it.
 */

import express from 'express';
import request from 'supertest';
import prisma from '../../config/db.js';
import hostsRouter from '../../routes/hosts.js';
import errorHandler from '../../middleware/errorHandler.js';
import { generateAgentToken } from '../../utils/agentToken.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';
import { classifyCollector } from '../postureCollectorState.js';
import { listServerCoverage, getSummary, getServerPosture } from '../postureQueryService.js';
import { planBulkInstall } from '../bulkBootstrapService.js';
import { UNSCOPED } from '../../lib/scope.js';

const SETTINGS = { collectIntervalSeconds: 300 };
const MIN = 60 * 1000;

describe('classifyCollector (pure)', () => {
  const linux = { osType: 'linux', protocol: 'ssh' };
  const now = Date.now();

  it('orders the states the way a person acts on them', () => {
    expect(classifyCollector({ osType: 'windows', protocol: 'rdp' }, undefined, SETTINGS, now)).toBe('not_applicable');
    expect(classifyCollector(linux, undefined, SETTINGS, now)).toBe('not_installed');
    expect(classifyCollector(linux, { receivedAt: new Date(now - 2 * MIN), collectorOk: true }, SETTINGS, now)).toBe('reporting');
    expect(classifyCollector(linux, { receivedAt: new Date(now - 2 * MIN), collectorOk: false }, SETTINGS, now)).toBe('degraded');
    expect(classifyCollector(linux, { receivedAt: new Date(now - 60 * MIN), collectorOk: true }, SETTINGS, now)).toBe('stale');
  });

  it('a refusal newer than the last accepted snapshot is "rejected", not "stale"', () => {
    const server = { ...linux, postureRejectedAt: new Date(now - 1 * MIN) };
    expect(classifyCollector(server, { receivedAt: new Date(now - 7 * 60 * MIN), collectorOk: false }, SETTINGS, now)).toBe('rejected');
    expect(classifyCollector(server, undefined, SETTINGS, now)).toBe('rejected');
  });

  it('an old refusal (host has since gone quiet) falls back to stale / not installed', () => {
    const server = { ...linux, postureRejectedAt: new Date(now - 120 * MIN) };
    expect(classifyCollector(server, { receivedAt: new Date(now - 7 * 60 * MIN), collectorOk: true }, SETTINGS, now)).toBe('stale');
    expect(classifyCollector(server, undefined, SETTINGS, now)).toBe('not_installed');
  });

  it('an accepted snapshot newer than the refusal wins', () => {
    const server = { ...linux, postureRejectedAt: new Date(now - 10 * MIN) };
    expect(classifyCollector(server, { receivedAt: new Date(now - 1 * MIN), collectorOk: true }, SETTINGS, now)).toBe('reporting');
  });
});

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '512kb' }));
  app.use('/api/hosts', hostsRouter);
  app.use(errorHandler);
  return app;
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}${Math.random().toString(36).slice(2, 6)}`;

function payload(overrides = {}) {
  return {
    collectedAt: new Date().toISOString(),
    firewall: { engine: 'ufw', active: true, defaultIncoming: 'deny', rules: [] },
    listeners: [{ proto: 'tcp', bind: '0.0.0.0', port: 22, ownerKind: 'systemd', ownerName: 'ssh.service', source: 'ss' }],
    ...overrides,
  };
}

describe('refused snapshots and collector state (live DB)', () => {
  const app = buildApp();
  let org;
  let customer;
  const scope = UNSCOPED;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({ data: { orgId: org.id, name: 'State Co', slug: `state-${uniq()}` } });
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.exposureFinding.deleteMany({ where: { orgId: org.id } });
    await prisma.hostListener.deleteMany({ where: { orgId: org.id } });
    await prisma.hostService.deleteMany({ where: { orgId: org.id } });
    await prisma.hostSnapshot.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
    await prisma.$disconnect().catch(() => {});
  });

  async function hostWithToken(extra = {}) {
    const { token, hash } = generateAgentToken();
    const server = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: `h-${uniq()}`,
        ipAddress: '10.0.0.9',
        agentTokenHash: hash,
        agentTokenIssuedAt: new Date(),
        provisionStatus: 'provisioned',
        sshUser: 'ubuntu',
        ...extra,
      },
    });
    return { server, token };
  }

  test('a refused snapshot is recorded against the host, with the reason', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { server, token } = await hostWithToken();
    const res = await request(app)
      .post('/api/hosts/posture')
      .set('x-agent-token', token)
      .send(payload({ firewall: { engine: 'made-up', active: true } }));
    expect(res.status).toBe(400);
    const row = await prisma.server.findUnique({ where: { id: server.id } });
    expect(row.postureRejectedAt).toBeInstanceOf(Date);
    expect(row.postureRejectReason).toMatch(/engine/);

    const coverage = await listServerCoverage(org.id, scope, {});
    expect(coverage.items.find((i) => i.id === server.id).collectorState).toBe('rejected');
    const posture = await getServerPosture(org.id, server.id, scope);
    expect(posture.collector.state).toBe('rejected');
    expect(posture.collector.rejection.reason).toMatch(/engine/);
  });

  test('the next accepted snapshot clears it', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { server, token } = await hostWithToken({ postureRejectedAt: new Date(), postureRejectReason: 'x' });
    const res = await request(app).post('/api/hosts/posture').set('x-agent-token', token).send(payload());
    expect(res.status).toBe(200);
    const row = await prisma.server.findUnique({ where: { id: server.id } });
    expect(row.postureRejectedAt).toBeNull();
    expect(row.postureRejectReason).toBeNull();
  });

  test('a NAT-derived listener (source "nat") is accepted, and is a Docker publish', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { server, token } = await hostWithToken();
    const res = await request(app)
      .post('/api/hosts/posture')
      .set('x-agent-token', token)
      .send(payload({
        listeners: [{ proto: 'tcp', bind: '0.0.0.0', port: 9000, containerPort: 9000, ownerKind: 'docker', ownerName: 'runtime:172.17.0.3:9000', ownerId: '-', source: 'nat' }],
        // Legacy (<= 1.0.0) placement of the rules — folded in by the route.
        firewallRules: [{ port: '9000', proto: 'tcp', action: 'DENY', from: 'Anywhere' }],
      }));
    expect(res.status).toBe(200);
    const findings = await prisma.exposureFinding.findMany({ where: { serverId: server.id, resolvedAt: null } });
    // DENY on the host firewall + a DNAT publish = the firewall is bypassed.
    expect(findings.map((f) => f.code)).toContain('DOCKER_FIREWALL_BYPASS');
    const snap = await prisma.hostSnapshot.findFirst({ where: { serverId: server.id } });
    expect(snap.agentVersion).toBeNull(); // legacy payload had no scanner string here
  });

  test('a degraded snapshot makes the host "degraded" everywhere — coverage, summary, installer', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { server, token } = await hostWithToken();
    const res = await request(app)
      .post('/api/hosts/posture')
      .set('x-agent-token', token)
      .send(payload({
        collectorOk: false,
        degradedReason: "could not run 'ss'",
        degradedReasons: ["could not run 'ss'", 'nftables input chain has rules this collector cannot evaluate'],
        scanner: 'shellius-posture-collect/1.1.0',
      }));
    expect(res.status).toBe(200);

    const coverage = await listServerCoverage(org.id, scope, {});
    const item = coverage.items.find((i) => i.id === server.id);
    expect(item.collectorState).toBe('degraded');
    // The firewall one is a limitation, so it is a note, not a fault.
    expect(item.degradedReasons).toEqual(["could not run 'ss'"]);
    expect(item.notes).toHaveLength(1);
    expect(item.collectorVersion).toBe('1.1.0');
    expect(coverage.counts.degraded).toBeGreaterThanOrEqual(1);

    const summary = await getSummary(org.id, scope, { customerId: customer.id });
    expect(summary.servers.degraded).toBeGreaterThanOrEqual(1);
    // Degraded hosts are still reporting — never counted twice.
    expect(summary.servers.reporting).toBeGreaterThanOrEqual(summary.servers.degraded);

    const plan = await planBulkInstall(org.id, [server.id], { mode: 'posture', scope });
    const entry = plan.skipped.find((s) => s.id === server.id);
    expect(entry).toMatchObject({ reason: 'collector_installed', degraded: true, needsReinstall: true, installable: true });
    expect(entry.degradedReasons).toHaveLength(1);
  });

  test('POST /posture/problem records what the host says went wrong, and nothing else', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { server, token } = await hostWithToken();
    const res = await request(app)
      .post('/api/hosts/posture/problem')
      .set('x-agent-token', token)
      .send({ reason: 'the collector exited 2 with no output: ss: command not found' });
    expect(res.status).toBe(200);
    const row = await prisma.server.findUnique({ where: { id: server.id } });
    expect(row.postureRejectReason).toBe('reported by the host: the collector exited 2 with no output: ss: command not found');
    expect(await prisma.hostSnapshot.count({ where: { serverId: server.id } })).toBe(0);

    const bad = await request(app).post('/api/hosts/posture/problem').set('x-agent-token', 'shag_nope').send({ reason: 'x' });
    expect(bad.status).toBe(401);
  });
});
