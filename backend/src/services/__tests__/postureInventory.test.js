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
import { NONE } from '../../utils/groupTree.js';
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

describe('parseOwnerKinds', () => {
  it('combines a single ownerKind and a csv ownerKinds into one deduped set', () => {
    expect(inventory.parseOwnerKinds('docker', 'docker,docker-proxy, container')).toEqual([
      'docker',
      'docker-proxy',
      'container',
    ]);
  });

  it('returns null (no filter) when nothing was given', () => {
    expect(inventory.parseOwnerKinds(undefined, undefined)).toBeNull();
    expect(inventory.parseOwnerKinds('', '')).toBeNull();
  });
});

describe('matchesQuery', () => {
  it('matches a customer name and an IP address, same fields the export needs', () => {
    const row = {
      service: 'nginx',
      port: 80,
      proto: 'tcp',
      server: { hostname: 'web-1', displayName: null, ipAddress: '10.1.2.3', customer: { name: 'Acme Corp' } },
    };
    expect(inventory.matchesQuery(row, 'Acme')).toBe(true);
    expect(inventory.matchesQuery(row, '10.1.2.3')).toBe(true);
    expect(inventory.matchesQuery(row, 'Globex')).toBe(false);
  });

  it('an empty query matches everything', () => {
    expect(inventory.matchesQuery({ service: 'x' }, '')).toBe(true);
    expect(inventory.matchesQuery({ service: 'x' }, undefined)).toBe(true);
  });
});

describe('listener sort whitelist', () => {
  it('accepts every column the page can sort, and nothing else', () => {
    for (const key of ['service', 'type', 'port', 'proto', 'bind', 'state', 'server', 'customer', 'environment', 'reachability', 'findings']) {
      expect(inventory.parseListenerSort(key, 'asc')).toEqual({ key, dir: 'asc' });
    }
    expect(inventory.parseListenerSort('ownerName', 'asc')).toBeNull();
    expect(inventory.parseListenerSort('__proto__', 'asc')).toBeNull();
    expect(inventory.parseListenerSort('constructor', 'asc')).toBeNull();
    expect(inventory.parseListenerSort('', 'asc')).toBeNull();
    expect(inventory.parseListenerSort(undefined)).toBeNull();
  });

  it('defaults the direction to ascending', () => {
    expect(inventory.parseListenerSort('port', 'sideways')).toEqual({ key: 'port', dir: 'asc' });
    expect(inventory.parseListenerSort('port', 'DESC')).toEqual({ key: 'port', dir: 'desc' });
  });

  const rows = [
    { id: 'c', port: 443, proto: 'tcp', server: { hostname: 'b-host', customer: { name: 'Beta' }, environment: 'dev' }, reachability: 'LAN', listening: true },
    { id: 'a', port: 22, proto: 'tcp', server: { hostname: 'a-host', customer: { name: 'Acme' }, environment: 'prod' }, reachability: 'INTERNET', listening: true },
    { id: 'b', port: 22, proto: 'tcp', server: { hostname: 'c-host', customer: { name: 'Acme' }, environment: 'staging' }, reachability: null, listening: false },
  ];

  it('an unknown sort keeps the rows in the order they came', () => {
    expect(inventory.sortListenerRows(rows, inventory.parseListenerSort('nope'))).toBe(rows);
  });

  it('sorts by server, customer, environment and reachability, ties broken by port then id', () => {
    const ids = (key, dir = 'asc') => inventory.sortListenerRows(rows, { key, dir }).map((r) => r.id);
    expect(ids('server')).toEqual(['a', 'c', 'b']);
    expect(ids('server', 'desc')).toEqual(['b', 'c', 'a']);
    expect(ids('customer')).toEqual(['a', 'b', 'c']);
    expect(ids('environment')).toEqual(['a', 'b', 'c']); // prod, staging, dev
    expect(ids('reachability')).toEqual(['a', 'c', 'b']); // INTERNET, LAN, none last
    expect(ids('state')).toEqual(['a', 'c', 'b']); // listening before stopped
    expect(ids('port', 'desc')).toEqual(['c', 'a', 'b']);
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

  // ---- new filters (1.7.5): ownerKinds, findingSeverity, scoped facets ---

  it('ownerKinds (csv) filters to a SET — grouping docker + docker-proxy as one "Type"', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const snap = await mkSnapshot(webA.id);
    const proxy = await mkListener(webA.id, snap.id, {
      port: 9443,
      ownerKind: 'docker-proxy',
      ownerName: 'docker-proxy',
      reachability: 'INTERNET',
    });
    try {
      const dockerOnly = await inventory.listListeners(org.id, { ownerKind: 'docker' }, UNSCOPED);
      expect(dockerOnly.items.some((r) => r.port === 9443)).toBe(false);

      const grouped = await inventory.listListeners(org.id, { ownerKinds: 'docker,docker-proxy' }, UNSCOPED);
      expect(grouped.items.some((r) => r.port === 9443)).toBe(true);
      expect(grouped.items.some((r) => r.ownerKind === 'docker')).toBe(true);
    } finally {
      await prisma.hostListener.delete({ where: { id: proxy.id } });
    }
  });

  it('findingSeverity filters to rows carrying an OPEN finding of that severity, on both views', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const critical = await prisma.exposureFinding.create({
      data: {
        orgId: org.id,
        serverId: webA.id,
        code: 'SENSITIVE_PORT_EXPOSED',
        proto: 'tcp',
        port: 5432,
        severity: 'CRITICAL',
        message: 'sensitive',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    const high = await prisma.exposureFinding.create({
      data: {
        orgId: org.id,
        serverId: webB.id,
        code: 'PORT_EXPOSED',
        proto: 'tcp',
        port: 80,
        severity: 'HIGH',
        message: 'exposed',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    try {
      const criticalOnly = await inventory.listListeners(org.id, { findingSeverity: 'CRITICAL' }, UNSCOPED);
      expect(criticalOnly.items).toHaveLength(1);
      expect(criticalOnly.items[0].port).toBe(5432);

      const servicesCritical = await inventory.listServices(org.id, { findingSeverity: 'CRITICAL' }, UNSCOPED);
      expect(servicesCritical.items.every((i) => (i.severityCounts.CRITICAL || 0) > 0)).toBe(true);
      // nginx (webA + webB) only carries the HIGH finding, not the CRITICAL
      // one, so a CRITICAL filter must drop it even though it has findings.
      expect(servicesCritical.items.map((i) => i.key)).not.toContain('docker:nginx');
    } finally {
      await prisma.exposureFinding.deleteMany({ where: { id: { in: [critical.id, high.id] } } });
    }
  });

  it(
    'listFacets is scoped (a literal `server: {isActive:true}` after the scope spread used to silently ' +
      'drop it) and merges in HostService kinds a socket scan never sees',
    async () => {
      if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
      const snap = await mkSnapshot(betaHost.id);
      const stoppedOnly = await prisma.hostService.create({
        data: {
          orgId: org.id,
          serverId: betaHost.id,
          snapshotId: snap.id,
          kind: 'systemd-user',
          name: 'backup-timer',
          state: 'stopped',
          running: false,
          ports: [],
        },
      });
      try {
        const unscoped = await inventory.listFacets(org.id, UNSCOPED);
        expect(unscoped.ownerKinds.map((k) => k.value)).toContain('systemd-user');

        const scopedToA = await inventory.listFacets(org.id, scopedTo([customerA.id]));
        expect(scopedToA.ownerKinds.map((k) => k.value)).not.toContain('systemd-user');
        // customerA's own kinds must still be there — proof the scope fix
        // didn't just make the facet empty for everyone.
        expect(scopedToA.ownerKinds.map((k) => k.value)).toContain('docker');

        const scopedToB = await inventory.listFacets(org.id, scopedTo([customerB.id]));
        expect(scopedToB.ownerKinds.map((k) => k.value)).toContain('systemd-user');
      } finally {
        await prisma.hostService.delete({ where: { id: stoppedOnly.id } });
      }
    }
  );

  it('a scoped caller naming an out-of-scope serverId directly still sees nothing', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listListeners(org.id, { serverId: betaHost.id }, scopedTo([customerA.id]));
    expect(out.items).toHaveLength(0);
    expect(out.meta.total).toBe(0);
  });

  it('a scoped caller naming an out-of-scope customerId directly still sees nothing', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listListeners(org.id, { customerId: customerB.id }, scopedTo([customerA.id]));
    expect(out.items).toHaveLength(0);
  });

  // ---- group by ----------------------------------------------------------

  // Every leaf of a tree, with the list filters that open it.
  const PARAM_FOR = {
    server: 'serverId',
    customer: 'customerId',
    type: 'ownerKind',
    protocol: 'service',
    findings: 'hasFindings',
  };
  const leaves = (nodes, filters = {}) =>
    nodes.flatMap((n) => {
      const next = { ...filters, [PARAM_FOR[n.dim] || n.dim]: n.value };
      return n.children ? leaves(n.children, next) : [{ node: n, filters: next }];
    });

  it('groups honour customer scope: a scoped caller only sees their own customers', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listListenerGroups(
      org.id,
      { groupBy: 'customer,server' },
      scopedTo([customerA.id])
    );
    expect(out.tree.map((n) => n.value)).toEqual([customerA.id]);
    expect(out.tree[0].label).toBe('Acme');
    const serverIds = out.tree[0].children.map((n) => n.value);
    expect(serverIds).not.toContain(betaHost.id);
  });

  it('groups honour customer scope even when the caller names an out-of-scope customer', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listListenerGroups(
      org.id,
      { groupBy: 'customer', customerId: customerB.id },
      scopedTo([customerA.id])
    );
    expect(out.tree).toEqual([]);
    expect(out.total).toBe(0);
  });

  it('every group opens, through the list, to exactly the rows it counted', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    for (const groupBy of ['customer,environment', 'type,protocol', 'reachability,port', 'status,findings,proto']) {
      const out = await inventory.listListenerGroups(org.id, { groupBy }, UNSCOPED);
      const all = await inventory.listListeners(org.id, { limit: 200 }, UNSCOPED);
      expect(out.total).toBe(all.meta.total);
      for (const { node, filters } of leaves(out.tree)) {
        const page = await inventory.listListeners(org.id, { ...filters, limit: 200 }, UNSCOPED);
        expect({ groupBy, value: node.value, total: page.meta.total }).toEqual({
          groupBy,
          value: node.value,
          total: node.count,
        });
      }
    }
  });

  it('the NONE group of an optional value (no recognised protocol) opens to those rows', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listListenerGroups(org.id, { groupBy: 'protocol' }, UNSCOPED);
    const none = out.tree.find((n) => n.value === NONE);
    expect(none).toBeDefined();
    const rows = await inventory.listListeners(org.id, { service: NONE, limit: 200 }, UNSCOPED);
    expect(rows.meta.total).toBe(none.count);
    expect(rows.items.every((r) => !r.service)).toBe(true);
  });

  it('NONE on a column that is never empty matches nothing instead of throwing', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    for (const f of [{ customerId: NONE }, { environment: NONE }, { serverId: NONE }, { ownerKind: NONE }]) {
      const out = await inventory.listListeners(org.id, f, UNSCOPED);
      expect(out.meta.total).toBe(0);
    }
  });

  it('sorts the whole filtered set by a whitelisted column, server-side', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const desc = await inventory.listListeners(org.id, { sortBy: 'port', sortDir: 'desc', limit: 1 }, UNSCOPED);
    const all = await inventory.listListeners(org.id, { limit: 200 }, UNSCOPED);
    expect(desc.items[0].port).toBe(Math.max(...all.items.map((r) => r.port)));
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

  it('groups declared ports too: status and an empty reachability open to their exact rows', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await inventory.listListenerGroups(org.id, { groupBy: 'status,reachability', serverId: host.id }, UNSCOPED);
    const byStatus = Object.fromEntries(out.tree.map((n) => [n.value, n]));
    expect(byStatus.exposed.count).toBe(1); // 8000, the socket
    expect(byStatus.internal.count).toBe(1); // 5432, inside the container
    expect(byStatus.stopped.count).toBe(1); // 9100, declared by a stopped container
    expect(byStatus.stopped.children.map((n) => n.value)).toEqual([NONE]);
    for (const s of out.tree) {
      for (const r of s.children) {
        const rows = await inventory.listListeners(
          org.id,
          { serverId: host.id, status: s.value, reachability: r.value },
          UNSCOPED
        );
        expect(rows.meta.total).toBe(r.count);
      }
    }
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

  // Last in this block: it adds a port the assertions above do not expect.
  it('a type group opens to its counted rows even when another kind owns the socket', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    // docker-proxy holds the socket for 7000; the docker scan declares it.
    const extraListener = await prisma.hostListener.create({
      data: {
        orgId: org.id,
        serverId: host.id,
        snapshotId: snapshot.id,
        proto: 'tcp',
        bind: '0.0.0.0',
        port: 7000,
        bindClass: 'wildcard',
        reachability: 'INTERNET',
        ownerKind: 'docker-proxy',
        ownerName: 'docker-proxy',
      },
    });
    const extraService = await prisma.hostService.create({
      data: {
        orgId: org.id,
        serverId: host.id,
        snapshotId: snapshot.id,
        kind: 'docker',
        name: 'web',
        state: 'running',
        running: true,
        ports: [{ proto: 'tcp', port: 7000, containerPort: 80, bind: '0.0.0.0' }],
      },
    });
    try {
      const out = await inventory.listListenerGroups(org.id, { groupBy: 'type', serverId: host.id }, UNSCOPED);
      for (const n of out.tree) {
        const rows = await inventory.listListeners(org.id, { serverId: host.id, ownerKind: n.value }, UNSCOPED);
        expect({ kind: n.value, total: rows.meta.total }).toEqual({ kind: n.value, total: n.count });
      }
      const docker = await inventory.listListeners(org.id, { serverId: host.id, ownerKind: 'docker' }, UNSCOPED);
      expect(docker.items.some((r) => r.port === 7000)).toBe(false);
    } finally {
      await prisma.hostListener.delete({ where: { id: extraListener.id } });
      await prisma.hostService.delete({ where: { id: extraService.id } });
    }
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

describe('bulk install fallback credentials', () => {
  // Typed credentials used to produce no fallback at all, so every host that
  // needed them failed with "No credentials available for this host".
  it('turns typed credentials into a usable fallback', async () => {
    const { typedFallbackAuth } = await import('../bulkBootstrapService.js');
    expect(typedFallbackAuth({ sshUser: 'ubuntu', password: 'pw' })).toEqual({
      username: 'ubuntu', password: 'pw', privateKey: undefined, passphrase: undefined,
    });
    expect(typedFallbackAuth({ sshUser: 'ubuntu' })).toBeNull();
  });

  it('retries with them after a certificate OR a saved identity fails — never with what just failed', async () => {
    const { shouldRetryWithFallback } = await import('../bulkBootstrapService.js');
    const fb = { password: 'x' };
    expect(shouldRetryWithFallback({ usedCertificate: true, fallbackAuth: fb, attemptedAuth: {} })).toBe(true);
    expect(shouldRetryWithFallback({ usedOwnIdentity: true, fallbackAuth: fb, attemptedAuth: {} })).toBe(true);
    expect(shouldRetryWithFallback({ usedOwnIdentity: true, fallbackAuth: fb, attemptedAuth: fb })).toBe(false);
    expect(shouldRetryWithFallback({ usedCertificate: true, fallbackAuth: null, attemptedAuth: {} })).toBe(false);
    expect(shouldRetryWithFallback({ fallbackAuth: fb, attemptedAuth: {} })).toBe(false);
  });
});

describe('withContainerNames', () => {
  it('names a cgroup-attributed container from the container scan, by its 12-char id', async () => {
    const { withContainerNames } = await import('../postureInventoryService.js');
    const rows = [
      { serverId: 's1', ownerKind: 'container', ownerName: 'docker:3f2a9c1b7d4e', ownerRef: '3f2a9c1b7d4e', port: 8080 },
      { serverId: 's2', ownerKind: 'container', ownerName: 'docker:3f2a9c1b7d4e', ownerRef: '3f2a9c1b7d4e', port: 8080 },
      { serverId: 's1', ownerKind: 'systemd', ownerName: 'ssh.service', port: 22 },
    ];
    const services = [{ serverId: 's1', kind: 'docker', ref: '3f2a9c1b7d4e', name: 'api', detail: 'myorg/api:1.4' }];
    const out = withContainerNames(rows, services);
    expect(out[0]).toMatchObject({ containerName: 'api', containerImage: 'myorg/api:1.4' });
    // Same id on another host is another container.
    expect(out[1].containerName).toBeUndefined();
    expect(out[2]).toBe(rows[2]);
  });
});

describe('withServiceIdentity', () => {
  const services = [
    { serverId: 's1', kind: 'docker', ref: 'fe07ecd8db89aa', name: 'op-dashboard', detail: 'openpanel/dashboard:2', sourcePath: '/srv/op/docker-compose.yml', ports: [{ proto: 'tcp', port: 3005, containerPort: 3000, bind: '0.0.0.0' }] },
    { serverId: 's1', kind: 'pm2', ref: 'ithadmin:ksb-fe', name: 'ksb-fe', detail: '/usr/lib/node_modules/serve/build/main.js', sourcePath: '/home/ithadmin/.pm2', statusText: 'online (pid 4242)', ports: [] },
    { serverId: 's1', kind: 'systemd', ref: 'grafana.service', name: 'grafana', ports: [{ proto: 'tcp', port: 9000 }] },
  ];

  it('names a docker-proxy port from the container that publishes it', async () => {
    const { withServiceIdentity } = await import('../postureInventoryService.js');
    const [r] = withServiceIdentity([{ serverId: 's1', ownerKind: 'docker-proxy', ownerName: 'docker-proxy', ownerDetail: '-> 172.27.0.2:3000', proto: 'tcp', port: 3005 }], services);
    expect(r).toMatchObject({ containerName: 'op-dashboard', containerId: 'fe07ecd8db89', containerImage: 'openpanel/dashboard:2', sourcePath: '/srv/op/docker-compose.yml' });
  });

  it('names a pm2 app by its running pid, even when the socket owner looked like its launcher', async () => {
    const { withServiceIdentity } = await import('../postureInventoryService.js');
    const [r] = withServiceIdentity([{ serverId: 's1', ownerKind: 'pm2', ownerName: 'serve', ownerRef: '#3', pid: 4242, proto: 'tcp', port: 3004 }], services);
    expect(r).toMatchObject({ pm2Name: 'ksb-fe', pm2Script: '/usr/lib/node_modules/serve/build/main.js', pm2Home: '/home/ithadmin/.pm2' });
  });

  it('an unknown owner is "declared by" the one service that declares the port', async () => {
    const { withServiceIdentity } = await import('../postureInventoryService.js');
    const [r, other] = withServiceIdentity(
      [
        { serverId: 's1', ownerKind: 'unknown', ownerName: 'unknown', proto: 'tcp', port: 9000 },
        { serverId: 's2', ownerKind: 'unknown', ownerName: 'unknown', proto: 'tcp', port: 9000 },
      ],
      services
    );
    expect(r.declaredBy).toEqual({ kind: 'systemd', name: 'grafana', ref: 'grafana.service' });
    // Another host's inventory never names this host's port.
    expect(other.declaredBy).toBeUndefined();
  });

  it('never overwrites what the collector itself reported, and leaves systemd alone', async () => {
    const { withServiceIdentity } = await import('../postureInventoryService.js');
    const rows = [
      { serverId: 's1', ownerKind: 'docker-proxy', proto: 'tcp', port: 3005, sourcePath: '/own/path' },
      { serverId: 's1', ownerKind: 'systemd', ownerName: 'ssh.service', proto: 'tcp', port: 22 },
    ];
    const out = withServiceIdentity(rows, services);
    expect(out[0].sourcePath).toBe('/own/path');
    expect(out[1]).toBe(rows[1]);
  });
});
