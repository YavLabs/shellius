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

/**
 * The severity filter took the UI's lowercase key and matched it against a
 * column storing CRITICAL/HIGH/…, so every severity filter either 400'd at
 * the route or matched nothing. Clicking a severity tile is the single most
 * common thing anyone does on the Posture page.
 */
describe('severity filtering is case-insensitive at the edge', () => {
  let org;
  let customer;
  let server;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    const q = await import('../postureQueryService.js');
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${unique()}` },
    });
    server = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: `sev-${unique()}`,
        ipAddress: '10.0.0.9',
        environment: 'prod',
      },
    });
    await prisma.exposureFinding.create({
      data: {
        orgId: org.id,
        serverId: server.id,
        code: 'SENSITIVE_PORT_EXPOSED',
        proto: 'tcp',
        port: 5432,
        severity: 'CRITICAL',
        message: 'exposed',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    global.__sevq = q;
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

  it('matches a lowercase severity, as the UI sends it', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await global.__sevq.listFindings(org.id, { severity: 'critical' }, UNSCOPED);
    expect(out.total).toBe(1);
  });

  it('still matches the stored uppercase form', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await global.__sevq.listFindings(org.id, { severity: 'CRITICAL' }, UNSCOPED);
    expect(out.total).toBe(1);
  });

  it('does not match a severity nothing has', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await global.__sevq.listFindings(org.id, { severity: 'low' }, UNSCOPED);
    expect(out.total).toBe(0);
  });
});

/**
 * A host running forty containers commonly shows eighteen open ports,
 * because most containers only ever talk to each other. Those containers
 * are not exposed — and they are also not absent. The inventory used to
 * load only `running: false` services, so every running container with no
 * published port was collected, stored, and never shown anywhere.
 */
describe('running services with no host port', () => {
  let org;
  let customer;
  let host;
  let snapshot;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${unique()}` },
    });
    host = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: `svc-${unique()}`,
        ipAddress: '10.0.0.20',
        environment: 'prod',
      },
    });
    snapshot = await prisma.hostSnapshot.create({
      data: { orgId: org.id, serverId: host.id, collectedAt: new Date(), receivedAt: new Date() },
    });
    // One published port, visible as a host socket.
    await prisma.hostListener.create({
      data: {
        orgId: org.id,
        serverId: host.id,
        snapshotId: snapshot.id,
        proto: 'tcp',
        bind: '0.0.0.0',
        port: 8000,
        bindClass: 'wildcard',
        reachability: 'INTERNET',
        ownerKind: 'docker',
        ownerName: 'coolify',
      },
    });
    await prisma.hostService.createMany({
      data: [
        {
          orgId: org.id,
          serverId: host.id,
          snapshotId: snapshot.id,
          kind: 'docker',
          name: 'coolify',
          state: 'running',
          running: true,
          ports: [{ proto: 'tcp', port: 8000, containerPort: 8080, bind: '0.0.0.0' }],
        },
        {
          orgId: org.id,
          serverId: host.id,
          snapshotId: snapshot.id,
          kind: 'docker',
          name: 'coolify-db',
          state: 'running',
          running: true,
          // EXPOSEd, never published: listening in its own namespace only.
          ports: [{ proto: 'tcp', port: 5432, containerPort: 5432, bind: 'container' }],
        },
        {
          orgId: org.id,
          serverId: host.id,
          snapshotId: snapshot.id,
          kind: 'docker',
          name: 'retired-api',
          state: 'exited',
          running: false,
          ports: [{ proto: 'tcp', port: 9100, containerPort: 3000, bind: '0.0.0.0' }],
        },
      ],
    });
  });

  afterAll(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.hostService.deleteMany({ where: { orgId: org.id } });
    await prisma.hostListener.deleteMany({ where: { orgId: org.id } });
    await prisma.hostSnapshot.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.postureSettings.deleteMany({ where: { orgId: org.id } });
    await prisma.postureAlertRule.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  it('shows a container that only listens inside itself', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listListeners(org.id, { serverId: host.id }, UNSCOPED);
    const row = out.items.find((r) => r.port === 5432);
    expect(row).toBeDefined();
    expect(row.containerInternal).toBe(true);
    // It IS listening — just nowhere the host can reach.
    expect(row.listening).toBe(true);
    expect(row.reachability).toBe('CONTAINER');
  });

  it('never double-counts a published port that already has a socket', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listListeners(org.id, { serverId: host.id }, UNSCOPED);
    const rows = out.items.filter((r) => r.port === 8000);
    expect(rows).toHaveLength(1);
    // The socket wins: it is the better evidence for the same port.
    expect(rows[0].reachability).toBe('INTERNET');
  });

  it('still shows a stopped container’s declared port', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listListeners(org.id, { serverId: host.id }, UNSCOPED);
    const row = out.items.find((r) => r.port === 9100);
    expect(row.listening).toBe(false);
    expect(row.containerInternal).toBe(false);
  });

  it('separates "listening on the host" from "container-internal"', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const exposed = await inventory.listListeners(org.id, { serverId: host.id, state: 'exposed' }, UNSCOPED);
    expect(exposed.items.map((r) => r.port)).toEqual([8000]);

    const internal = await inventory.listListeners(org.id, { serverId: host.id, state: 'internal' }, UNSCOPED);
    expect(internal.items.map((r) => r.port)).toEqual([5432]);
  });

  it('groups a running container into the services view even with no host port', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listServices(org.id, { serverId: host.id }, UNSCOPED);
    const db = out.items.find((i) => i.name === 'coolify-db');
    expect(db).toBeDefined();
    expect(db.runningOn).toBe(1);
    expect(db.stoppedOn).toBe(0);
    expect(db.ports).toContain(5432);
    // Declared, not observed on the host — it must not read as exposed.
    expect(db.internetExposed).toBe(0);
  });
});

/**
 * A bootstrapped host trusts the org CA, so it needs no stored identity to
 * install on — it needs a certificate. The planner used to skip exactly
 * these hosts for "no credentials", which is the inverse of the truth and
 * the reason a long-established fleet could plan to zero targets.
 *
 * Its own org: the tests above assert over "every server in the org", and a
 * bootstrapped host would change their counts.
 */
describe('bulk plan — certificate-eligible hosts (DB)', () => {
  let org;
  let customer;
  let bootstrapped;
  let plain;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: `cust-${unique()}`, slug: `c-${unique()}` },
    });
    const mk = (data) =>
      prisma.server.create({
        data: {
          orgId: org.id,
          customerId: customer.id,
          hostname: `${unique()}.example.com`,
          ipAddress: '10.0.0.9',
          environment: 'dev',
          ...data,
        },
      });
    bootstrapped = await mk({ provisionStatus: 'provisioned', sshUser: 'ubuntu' });
    plain = await mk({});
  });

  afterAll(async () => {
    if (org) await cleanupOrg(org.id);
  });

  it('plans a bootstrapped host with no identity as a certificate install', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const plan = await planBulkInstall(org.id, [], {
      mode: 'posture',
      hasFallbackCredentials: false,
      scope: UNSCOPED,
    });
    const target = plan.targets.find((t) => t.id === bootstrapped.id);
    expect(target).toBeDefined();
    expect(target.credentialSource).toBe('certificate');
    expect(target.bootstrapped).toBe(true);
    expect(plan.counts.usingCertificate).toBe(1);
  });

  it('still skips a host that trusts nothing and was given nothing', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const plan = await planBulkInstall(org.id, [], {
      mode: 'posture',
      hasFallbackCredentials: false,
      scope: UNSCOPED,
    });
    expect(plan.skipped.find((s) => s.id === plain.id)?.reason).toBe('no_credentials');
  });

  it('prefers a certificate over the batch fallback credentials', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const plan = await planBulkInstall(org.id, [], {
      mode: 'posture',
      hasFallbackCredentials: true,
      scope: UNSCOPED,
    });
    // The fallback is one account typed once for hosts that have nothing;
    // there is no reason to believe it exists on a host that never needed it.
    expect(plan.targets.find((t) => t.id === bootstrapped.id).credentialSource).toBe('certificate');
    // ...and a host that is not bootstrapped still uses it.
    expect(plan.targets.find((t) => t.id === plain.id).credentialSource).toBe('supplied');
  });

  it('full-agent mode still treats a bootstrapped host as already done', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const plan = await planBulkInstall(org.id, [], {
      mode: 'full',
      hasFallbackCredentials: false,
      scope: UNSCOPED,
    });
    expect(plan.skipped.find((s) => s.id === bootstrapped.id)?.reason).toBe('already_provisioned');
  });
});
