/**
 * posture.test.js — read/management API for exposure posture
 * (docs/posture/posture-spec.md §7, §8, §9; docs/rbac/customer-scope-spec.md
 * §3 "customer scope is mandatory here").
 *
 * Covers:
 *   - customer scope filtering of `listFindings` and `getSummary` (an
 *     aggregate leak is still a leak — §6.3 of the scope spec)
 *   - `muteFinding` requires a non-empty reason
 *   - stale vs reporting vs not-installed server classification (§9.1: a
 *     dead collector must not make its findings disappear)
 *   - `PostureSettings` create-on-read defaults
 *
 * DB tests use the dbReachable() skip pattern (see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import * as postureQueryService from '../postureQueryService.js';
import * as postureSettingsService from '../postureSettingsService.js';
import { resolveScope } from '../../lib/scope.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

async function createCustomer(orgId, name) {
  const suffix = unique();
  return prisma.customer.create({ data: { orgId, name, slug: `${name.toLowerCase()}-${suffix}` } });
}

async function createServer(orgId, customerId, hostname, overrides = {}) {
  return prisma.server.create({
    data: {
      orgId,
      customerId,
      hostname,
      ipAddress: `10.${Math.floor(Math.random() * 200) + 1}.0.${Math.floor(Math.random() * 200) + 1}`,
      environment: 'dev',
      ...overrides,
    },
  });
}

async function createSnapshot(orgId, serverId, { collectedAt, receivedAt } = {}) {
  return prisma.hostSnapshot.create({
    data: {
      orgId,
      serverId,
      collectedAt: collectedAt || new Date(),
      ...(receivedAt ? { receivedAt } : {}),
      agentVersion: '1.0.0',
      firewall: { engine: 'ufw', active: true, defaultIncoming: 'deny' },
      raw: {},
    },
  });
}

async function createFinding(orgId, serverId, overrides = {}) {
  const now = new Date();
  return prisma.exposureFinding.create({
    data: {
      orgId,
      serverId,
      code: overrides.code || 'PORT_EXPOSED',
      severity: overrides.severity || 'HIGH',
      proto: overrides.proto ?? 'tcp',
      port: overrides.port ?? 8080,
      message: overrides.message || 'Port exposed to the internet',
      firstSeenAt: overrides.firstSeenAt || now,
      lastSeenAt: overrides.lastSeenAt || now,
      resolvedAt: overrides.resolvedAt ?? null,
      mutedUntil: overrides.mutedUntil ?? null,
      mutedReason: overrides.mutedReason ?? null,
    },
  });
}

describe('posture — read/management API', () => {
  let reachable;
  let org;
  let roles;
  let customerA;
  let customerB;
  let serverA;
  let serverB;
  let scopedUser;
  let unscopedUser;
  let scopedScope;
  let unscopedScope;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] posture tests: no live DB');
      return;
    }

    const { syncSystemRoles } = await import('../roleService.js');

    org = await createTestOrg();
    await syncSystemRoles(org.id);
    roles = Object.fromEntries((await prisma.role.findMany({ where: { orgId: org.id } })).map((r) => [r.key, r]));

    customerA = await createCustomer(org.id, `posture-a-${unique()}`);
    customerB = await createCustomer(org.id, `posture-b-${unique()}`);
    serverA = await createServer(org.id, customerA.id, `posture-a-host-${unique()}`);
    serverB = await createServer(org.id, customerB.id, `posture-b-host-${unique()}`);

    scopedUser = await createTestUser(org.id, {
      role: 'member',
      data: { roleId: roles.member.id, accessScope: 'CUSTOMERS' },
    });
    await prisma.userCustomerScope.create({ data: { userId: scopedUser.id, customerId: customerA.id } });

    unscopedUser = await createTestUser(org.id, { role: 'member', data: { roleId: roles.member.id } });

    scopedScope = await resolveScope({ id: scopedUser.id, role: 'member', accessScope: 'CUSTOMERS' });
    unscopedScope = await resolveScope({ id: unscopedUser.id, role: 'member', accessScope: 'ALL' });

    expect(scopedScope).toEqual({ mode: 'customers', customerIds: [customerA.id] });
  });

  afterAll(async () => {
    if (!reachable) return;
    await prisma.exposureFinding.deleteMany({ where: { orgId: org.id } });
    await prisma.hostListener.deleteMany({ where: { orgId: org.id } });
    await prisma.hostSnapshot.deleteMany({ where: { orgId: org.id } });
    await prisma.hostMetricSample.deleteMany({ where: { orgId: org.id } });
    await prisma.postureSettings.deleteMany({ where: { orgId: org.id } });
    await prisma.userCustomerScope.deleteMany({ where: { user: { orgId: org.id } } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.role.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const dbTest = (name, fn) => test(name, async () => {
    if (!reachable) return;
    await fn();
  });

  // ---------------------------------------------------------------------
  // Scope filtering — findings list
  // ---------------------------------------------------------------------

  dbTest('listFindings: scoped user sees only findings for their customer; unscoped user sees both, and the total is scoped too', async () => {
    const findingA = await createFinding(org.id, serverA.id, { code: 'SCOPE_TEST_A', port: 9001 });
    const findingB = await createFinding(org.id, serverB.id, { code: 'SCOPE_TEST_B', port: 9002 });

    const scoped = await postureQueryService.listFindings(org.id, {}, scopedScope);
    expect(scoped.findings.map((f) => f.id)).toContain(findingA.id);
    expect(scoped.findings.map((f) => f.id)).not.toContain(findingB.id);
    expect(scoped.total).toBe(scoped.findings.length);

    const unscoped = await postureQueryService.listFindings(org.id, {}, unscopedScope);
    const unscopedIds = unscoped.findings.map((f) => f.id);
    expect(unscopedIds).toEqual(expect.arrayContaining([findingA.id, findingB.id]));

    // A scoped user naming B's customerId directly still gets nothing —
    // the scope filter is ANDed with the caller's own filter, never
    // overridden by it.
    const scopedWithBFilter = await postureQueryService.listFindings(
      org.id,
      { customerId: customerB.id },
      scopedScope
    );
    expect(scopedWithBFilter.findings).toEqual([]);
    expect(scopedWithBFilter.total).toBe(0);

    // A finding's `server` DTO never leaks an out-of-scope customer object.
    const found = scoped.findings.find((f) => f.id === findingA.id);
    expect(found.server.customer.id).toBe(customerA.id);
  });

  // ---------------------------------------------------------------------
  // Scope filtering — summary aggregate counts (the leak-in-a-total case)
  // ---------------------------------------------------------------------

  dbTest('getSummary: server and finding counts are computed after the scope filter, not before', async () => {
    await createFinding(org.id, serverA.id, { code: 'SUMMARY_A', severity: 'CRITICAL', port: 9101 });
    await createFinding(org.id, serverB.id, { code: 'SUMMARY_B', severity: 'CRITICAL', port: 9102 });

    const scoped = await postureQueryService.getSummary(org.id, scopedScope);
    const unscoped = await postureQueryService.getSummary(org.id, unscopedScope);

    // The scoped total can never exceed the unscoped total, and — since B
    // has its own server + finding — must be strictly smaller here.
    expect(scoped.servers.total).toBeLessThan(unscoped.servers.total);
    expect(scoped.findings.critical).toBeLessThan(unscoped.findings.critical);
    expect(scoped.servers.total).toBe(1);
  });

  // ---------------------------------------------------------------------
  // getServerPosture — 404, never 403, for an out-of-scope server
  // ---------------------------------------------------------------------

  dbTest('getServerPosture: out-of-scope server is a 404 for the scoped user; in-scope works', async () => {
    await expect(postureQueryService.getServerPosture(org.id, serverB.id, scopedScope)).rejects.toMatchObject({
      statusCode: 404,
    });

    const data = await postureQueryService.getServerPosture(org.id, serverA.id, scopedScope);
    expect(data.server.id).toBe(serverA.id);
  });

  // ---------------------------------------------------------------------
  // Mute requires a reason
  // ---------------------------------------------------------------------

  dbTest('muteFinding: rejects an empty/missing reason and rejects when neither days nor until is given', async () => {
    const finding = await createFinding(org.id, serverA.id, { code: 'MUTE_TEST', port: 9201 });

    await expect(
      postureQueryService.muteFinding(org.id, finding.id, { days: 7, reason: '' }, scopedUser.id, scopedScope)
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      postureQueryService.muteFinding(org.id, finding.id, { reason: 'expected, ticket JIRA-1' }, scopedUser.id, scopedScope)
    ).rejects.toMatchObject({ statusCode: 400 });

    const muted = await postureQueryService.muteFinding(
      org.id,
      finding.id,
      { days: 7, reason: 'expected, ticket JIRA-1' },
      scopedUser.id,
      scopedScope
    );
    expect(muted.status).toBe('muted');
    expect(muted.mutedReason).toBe('expected, ticket JIRA-1');
    expect(new Date(muted.mutedUntil).getTime()).toBeGreaterThan(Date.now());

    // A scoped user can never mute a finding on an out-of-scope server.
    const findingB = await createFinding(org.id, serverB.id, { code: 'MUTE_TEST_B', port: 9202 });
    await expect(
      postureQueryService.muteFinding(org.id, findingB.id, { days: 1, reason: 'x' }, scopedUser.id, scopedScope)
    ).rejects.toMatchObject({ statusCode: 404 });

    const unmuted = await postureQueryService.unmuteFinding(org.id, finding.id, scopedScope);
    expect(unmuted.status).toBe('open');
    expect(unmuted.mutedReason).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Stale detection
  // ---------------------------------------------------------------------

  dbTest('getSummary / getServerPosture classify servers as reporting, stale, or not-installed', async () => {
    // Force a short collect interval so "3x interval" is easy to cross
    // without sleeping in the test.
    await postureSettingsService.updateSettings(org.id, { collectIntervalSeconds: 60 });

    const freshServer = await createServer(org.id, customerA.id, `posture-fresh-${unique()}`);
    const staleServer = await createServer(org.id, customerA.id, `posture-stale-${unique()}`);
    const neverServer = await createServer(org.id, customerA.id, `posture-never-${unique()}`);

    await createSnapshot(org.id, freshServer.id, { receivedAt: new Date() });
    // 3x60s = 180s threshold — 10 minutes ago is comfortably stale.
    await createSnapshot(org.id, staleServer.id, { receivedAt: new Date(Date.now() - 10 * 60 * 1000) });
    // neverServer gets no snapshot at all.

    const freshPosture = await postureQueryService.getServerPosture(org.id, freshServer.id, unscopedScope);
    expect(freshPosture.collector.installed).toBe(true);
    expect(freshPosture.collector.stale).toBe(false);

    const stalePosture = await postureQueryService.getServerPosture(org.id, staleServer.id, unscopedScope);
    expect(stalePosture.collector.installed).toBe(true);
    expect(stalePosture.collector.stale).toBe(true);

    const neverPosture = await postureQueryService.getServerPosture(org.id, neverServer.id, unscopedScope);
    expect(neverPosture.collector.installed).toBe(false);
    expect(neverPosture.collector.stale).toBe(false);

    const summary = await postureQueryService.getSummary(org.id, unscopedScope);
    expect(summary.servers.reporting).toBeGreaterThanOrEqual(1);
    expect(summary.servers.stale).toBeGreaterThanOrEqual(1);
    expect(summary.servers.notInstalled).toBeGreaterThanOrEqual(1);

    // A finding on the stale server must still be reported as open — a dead
    // collector must not make findings silently vanish (spec §9.1).
    const staleFinding = await createFinding(org.id, staleServer.id, { code: 'STALE_HOST_FINDING', port: 9301 });
    const staleFindingList = await postureQueryService.listFindings(org.id, { status: 'open' }, unscopedScope);
    expect(staleFindingList.findings.map((f) => f.id)).toContain(staleFinding.id);

    await prisma.server.deleteMany({ where: { id: { in: [freshServer.id, staleServer.id, neverServer.id] } } });
  });

  // ---------------------------------------------------------------------
  // Settings defaults (create-on-read)
  // ---------------------------------------------------------------------

  dbTest('postureSettingsService.getSettings creates the row with schema defaults on first read', async () => {
    const freshOrg = await createTestOrg();
    try {
      const before = await prisma.postureSettings.findUnique({ where: { orgId: freshOrg.id } });
      expect(before).toBeNull();

      const settings = await postureSettingsService.getSettings(freshOrg.id);
      expect(settings.enabled).toBe(false);
      expect(settings.collectIntervalSeconds).toBe(300);
      expect(settings.snapshotRetentionDays).toBe(7);
      expect(settings.metricRetentionHours).toBe(24);
      expect(settings.findingRetentionDays).toBe(90);
      expect(settings.expectedPublicPorts).toEqual([]);

      // Idempotent — a second read doesn't create a second row or change values.
      const again = await postureSettingsService.getSettings(freshOrg.id);
      expect(again.id).toBe(settings.id);

      // Floor enforcement: a caller asking for a faster-than-allowed cadence
      // is clamped to the 60s floor, not rejected and not honored as-is.
      const updated = await postureSettingsService.updateSettings(freshOrg.id, { collectIntervalSeconds: 5 });
      expect(updated.collectIntervalSeconds).toBe(60);
    } finally {
      await prisma.postureSettings.deleteMany({ where: { orgId: freshOrg.id } });
      await prisma.organization.deleteMany({ where: { id: freshOrg.id } });
    }
  });
});
