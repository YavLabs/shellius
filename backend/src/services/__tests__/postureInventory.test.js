/**
 * postureInventory.test.js — the fleet service inventory, and the bulk
 * install plan.
 *
 * What is worth pinning:
 *   - customer scope holds on BOTH views. The inventory is a fleet-wide read
 *     of every listening port in the org; if scope leaks anywhere it leaks
 *     here, and it leaks as "which services this customer runs".
 *   - grouping puts a service on the right hosts. "Where is nginx deployed"
 *     is the question this page exists to answer, and an answer that is
 *     quietly incomplete is worse than no page.
 *   - the bulk plan skips what it cannot install on, and says why. A silent
 *     skip is how an operator ends up believing a fleet is covered.
 *   - an already-installed-but-stale collector counts as installed. Treating
 *     stale as uninstalled is the exact conflation that once hid real
 *     findings behind an install prompt.
 *
 * DB tests use the dbReachable() skip pattern (see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import * as inventory from '../postureInventoryService.js';
import { planBulkInstall } from '../bulkBootstrapService.js';
import { UNSCOPED } from '../../lib/scope.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

let seq = 0;
const unique = () => `${Date.now().toString(36)}${(seq += 1)}${Math.random().toString(36).slice(2, 6)}`;
const scopedTo = (customerIds) => ({ mode: 'customers', customerIds });

describe('serviceKey', () => {
  it('files a detected protocol under its own name', () => {
    expect(inventory.serviceKey({ service: 'PostgreSQL', ownerKind: 'docker', ownerName: 'db' })).toEqual({
      key: 'service:postgresql',
      name: 'PostgreSQL',
      kind: 'service',
    });
  });

  it('falls back to what the thing calls itself, not to "unknown"', () => {
    expect(inventory.serviceKey({ ownerKind: 'docker', ownerName: 'nginx' }).key).toBe('docker:nginx');
    expect(inventory.serviceKey({ ownerKind: 'systemd', ownerName: 'ssh.service' }).key).toBe('systemd:ssh.service');
  });

  it('buckets a socket with no attribution at all separately', () => {
    expect(inventory.serviceKey({ ownerKind: 'unknown' }).key).toBe('__unattributed__');
  });

  it('groups the same service across hosts under one key', () => {
    const a = inventory.serviceKey({ ownerKind: 'docker', ownerName: 'nginx' });
    const b = inventory.serviceKey({ ownerKind: 'docker', ownerName: 'NGINX' });
    expect(a.key).toBe(b.key);
  });
});

describe('inventory + bulk plan (DB)', () => {
  let org;
  let customerA;
  let customerB;
  let webA;
  let webB;
  let betaHost;
  let windowsHost;
  let rdpHost;

  const mkListener = (serverId, snapshotId, overrides) =>
    prisma.hostListener.create({
      data: {
        orgId: org.id,
        serverId,
        snapshotId,
        proto: 'tcp',
        bind: '0.0.0.0',
        port: 80,
        bindClass: 'wildcard',
        reachability: 'INTERNET',
        ownerKind: 'docker',
        ownerName: 'nginx',
        ...overrides,
      },
    });

  const mkSnapshot = (serverId) =>
    prisma.hostSnapshot.create({
      data: { orgId: org.id, serverId, collectedAt: new Date(), receivedAt: new Date() },
    });

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customerA = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${unique()}` },
    });
    customerB = await prisma.customer.create({
      data: { orgId: org.id, name: 'Beta', slug: `beta-${unique()}` },
    });

    const mkServer = (customerId, data) =>
      prisma.server.create({
        data: {
          orgId: org.id,
          customerId,
          hostname: `${unique()}.example.com`,
          ipAddress: '10.0.0.1',
          environment: 'prod',
          ...data,
        },
      });

    webA = await mkServer(customerA.id, { environment: 'prod' });
    webB = await mkServer(customerA.id, { environment: 'dev' });
    betaHost = await mkServer(customerB.id, {});
    windowsHost = await mkServer(customerA.id, { osType: 'windows' });
    rdpHost = await mkServer(customerA.id, { protocol: 'rdp' });

    // Two hosts run nginx; one of them also runs postgres. Beta runs redis.
    const sa = await mkSnapshot(webA.id);
    const sb = await mkSnapshot(webB.id);
    const sc = await mkSnapshot(betaHost.id);
    await mkListener(webA.id, sa.id, { port: 80 });
    await mkListener(webA.id, sa.id, {
      port: 5432,
      service: 'PostgreSQL',
      ownerName: 'db',
      reachability: 'LOOPBACK',
      bind: '127.0.0.1',
      bindClass: 'loopback',
    });
    await mkListener(webB.id, sb.id, { port: 80 });
    await mkListener(betaHost.id, sc.id, { port: 6379, ownerName: 'redis', reachability: 'LAN' });
  });

  afterAll(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.hostListener.deleteMany({ where: { orgId: org.id } });
    await prisma.hostSnapshot.deleteMany({ where: { orgId: org.id } });
    await prisma.exposureFinding.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.postureSettings.deleteMany({ where: { orgId: org.id } });
    await prisma.postureAlertRule.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  it('groups one service across every host running it', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listServices(org.id, {}, UNSCOPED);
    const nginx = out.items.find((i) => i.key === 'docker:nginx');
    expect(nginx.serverCount).toBe(2);
    expect(nginx.servers.map((s) => s.id).sort()).toEqual([webA.id, webB.id].sort());
    expect(nginx.environments.sort()).toEqual(['dev', 'prod']);
    expect(nginx.internetExposed).toBe(2);
  });

  it('never reports a service that only runs outside the caller’s scope', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listServices(org.id, {}, scopedTo([customerA.id]));
    const names = out.items.map((i) => i.name);
    expect(names).toContain('nginx');
    expect(names).not.toContain('redis');
    expect(out.meta.servers).toBe(2);
  });

  it('scopes the flat port list too', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listListeners(org.id, {}, scopedTo([customerB.id]));
    expect(out.items).toHaveLength(1);
    expect(out.items[0].port).toBe(6379);
  });

  it('filters by reachability and by environment', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const internet = await inventory.listListeners(org.id, { reachability: 'INTERNET' }, UNSCOPED);
    expect(internet.items.every((r) => r.reachability === 'INTERNET')).toBe(true);
    expect(internet.meta.total).toBe(2);

    const dev = await inventory.listListeners(org.id, { environment: 'dev' }, UNSCOPED);
    expect(dev.items.every((r) => r.server.id === webB.id)).toBe(true);
  });

  it('free-text search reaches the fields the row displays', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listListeners(org.id, { q: 'postgres' }, UNSCOPED);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].port).toBe(5432);
  });

  it('attaches the open findings for a port so the inventory flags it', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const finding = await prisma.exposureFinding.create({
      data: {
        orgId: org.id,
        serverId: webA.id,
        code: 'PORT_EXPOSED',
        proto: 'tcp',
        port: 80,
        severity: 'HIGH',
        message: 'exposed',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    const out = await inventory.listListeners(org.id, { port: 80, serverId: webA.id }, UNSCOPED);
    expect(out.items[0].findings.map((f) => f.id)).toContain(finding.id);
    await prisma.exposureFinding.delete({ where: { id: finding.id } });
  });

  // ---- bulk install plan -------------------------------------------------

  it('skips hosts that cannot run the installer, and says why', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const plan = await planBulkInstall(org.id, [], {
      mode: 'posture',
      hasFallbackCredentials: true,
      scope: UNSCOPED,
    });
    const byId = new Map(plan.skipped.map((s) => [s.id, s]));
    expect(byId.get(windowsHost.id)?.reason).toBe('windows');
    expect(byId.get(rdpHost.id)?.reason).toBe('rdp_only');
    // Every skip carries an explanation, not just a code.
    expect(plan.skipped.every((s) => typeof s.message === 'string' && s.message.length > 0)).toBe(true);
  });

  it('treats a host that has ever reported as already having the collector', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const plan = await planBulkInstall(org.id, [], {
      mode: 'posture',
      hasFallbackCredentials: true,
      scope: UNSCOPED,
    });
    const skipped = plan.skipped.find((s) => s.id === webA.id);
    expect(skipped?.reason).toBe('collector_installed');
    expect(plan.targets.map((t) => t.id)).not.toContain(webA.id);
  });

  it('includeDone puts the already-done hosts back on the list', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const plan = await planBulkInstall(org.id, [], {
      mode: 'posture',
      hasFallbackCredentials: true,
      includeDone: true,
      scope: UNSCOPED,
    });
    expect(plan.targets.map((t) => t.id)).toContain(webA.id);
  });

  it('skips a host with nothing to authenticate with rather than failing it later', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const plan = await planBulkInstall(org.id, [], {
      mode: 'posture',
      hasFallbackCredentials: false,
      // Without this the reporting hosts are skipped as already-done first
      // and never reach the credentials check — the skip order is
      // deliberate (an installed host needs no credentials).
      includeDone: true,
      scope: UNSCOPED,
    });
    // No server in this fixture has a bound identity, so every otherwise
    // eligible host lands in `no_credentials` — never silently in targets.
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped.some((s) => s.reason === 'no_credentials')).toBe(true);
  });

  it('never plans against a server outside the caller’s scope', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const plan = await planBulkInstall(org.id, [betaHost.id], {
      mode: 'posture',
      hasFallbackCredentials: true,
      includeDone: true,
      scope: scopedTo([customerA.id]),
    });
    expect(plan.counts.total).toBe(0);
    expect(plan.targets).toHaveLength(0);
  });
});

/**
 * The tiles on the Posture page are getSummary(); the table under them is
 * listFindings(). They were computed from different populations — the
 * summary counted active servers only, the list counted every server — so a
 * finding on a deactivated host appeared in the table and in no tile. The
 * property worth pinning is not either number, it is that they agree.
 */
describe('summary and list describe the same findings', () => {
  let org;
  let customer;
  let liveServer;
  let retiredServer;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    const q = await import('../postureQueryService.js');
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${unique()}` },
    });
    liveServer = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: `live-${unique()}`,
        ipAddress: '10.0.0.5',
        environment: 'prod',
        isActive: true,
      },
    });
    retiredServer = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: `retired-${unique()}`,
        ipAddress: '10.0.0.6',
        environment: 'prod',
        isActive: false,
      },
    });
    const mk = (serverId, severity, port) =>
      prisma.exposureFinding.create({
        data: {
          orgId: org.id,
          serverId,
          code: 'PORT_EXPOSED',
          proto: 'tcp',
          port,
          severity,
          message: 'exposed',
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
    await mk(liveServer.id, 'HIGH', 8080);
    await mk(liveServer.id, 'INFO', 8081);
    await mk(retiredServer.id, 'CRITICAL', 5432);
    global.__q = q;
  });

  afterAll(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.exposureFinding.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.postureSettings.deleteMany({ where: { orgId: org.id } });
    await prisma.postureAlertRule.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  it('neither the tiles nor the list count a deactivated server', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const q = global.__q;
    const summary = await q.getSummary(org.id, UNSCOPED, {});
    const list = await q.listFindings(org.id, { status: 'open', limit: 100 }, UNSCOPED);
    expect(summary.findings.critical).toBe(0);
    expect(list.findings.map((f) => f.serverId ?? f.server?.id)).not.toContain(retiredServer.id);
  });

  it('the severity tiles add up to the open list', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const q = global.__q;
    const summary = await q.getSummary(org.id, UNSCOPED, {});
    const list = await q.listFindings(org.id, { status: 'open', limit: 100 }, UNSCOPED);
    const tileTotal = ['critical', 'high', 'medium', 'low', 'info'].reduce(
      (n, k) => n + summary.findings[k],
      0
    );
    expect(tileTotal).toBe(list.total);
  });

  it('the summary follows the page’s environment filter, as the list does', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const q = global.__q;
    const summary = await q.getSummary(org.id, UNSCOPED, { environment: 'dev' });
    const list = await q.listFindings(org.id, { status: 'open', environment: 'dev', limit: 100 }, UNSCOPED);
    expect(summary.findings.high).toBe(0);
    expect(list.total).toBe(0);
  });
});
