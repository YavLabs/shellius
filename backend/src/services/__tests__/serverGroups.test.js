/**
 * Servers list group-by: the shared `where` (buildServerWhere), NONE as
 * "is empty" on the list endpoint, and listServerGroups' tree — counted over
 * the whole filtered set, org + scope included, with every group opening
 * (through listServers) to exactly the rows it counted.
 *
 * buildServerWhere is pure and tested directly. The tree itself runs
 * against a live DB (dbReachable() skip pattern — jest.unstable_mockModule
 * is broken in this Jest + Node ESM combination, see caService.test.js).
 */
import prisma from '../../config/db.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';
import {
  buildServerWhere,
  resolveServerWhere,
  pickServerFilters,
  listServers,
  listServerGroups,
  SERVER_GROUP_DIMS,
} from '../serverService.js';
import { NONE } from '../../utils/groupTree.js';
import { UNSCOPED } from '../../lib/scope.js';

describe('buildServerWhere', () => {
  test('always org-scoped; unscoped caller adds no AND', () => {
    expect(buildServerWhere('org1', {}, UNSCOPED)).toEqual({ orgId: 'org1' });
  });

  test('customer scope is ANDed, never replaced by a customerId param', () => {
    const where = buildServerWhere('org1', { customerId: 'cB' }, { mode: 'customers', customerIds: ['cA'] });
    expect(where.customerId).toBe('cB');
    expect(where.AND).toContainEqual({ customerId: { in: ['cA'] } });
  });

  test('stored filters map to their columns', () => {
    const where = buildServerWhere('o', {
      environment: 'prod',
      healthStatus: 'healthy',
      protocol: 'ssh',
      osType: 'linux',
      cloudProvider: 'aws',
      isActive: 'false',
    });
    expect(where).toMatchObject({
      orgId: 'o',
      environment: 'prod',
      healthStatus: 'healthy',
      protocol: 'ssh',
      osType: 'linux',
      cloudProvider: 'aws',
      isActive: false,
    });
  });

  test('NONE on a nullable column means null or empty', () => {
    const where = buildServerWhere('o', { osType: NONE, cloudProvider: NONE });
    expect(where.osType).toBeUndefined();
    expect(where.cloudProvider).toBeUndefined();
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { OR: [{ osType: null }, { osType: '' }] },
        { OR: [{ cloudProvider: null }, { cloudProvider: '' }] },
      ])
    );
  });

  test('NONE on a column that is never empty matches nothing (never reaches Prisma as an enum)', () => {
    for (const key of ['environment', 'healthStatus', 'protocol', 'customerId', 'isActive']) {
      const where = buildServerWhere('o', { [key]: NONE });
      expect(where[key]).toBeUndefined();
      expect(where.AND).toContainEqual({ id: { in: [] } });
    }
  });

  test('search keeps its OR alongside NONE filters (they live in AND, not OR)', () => {
    const where = buildServerWhere('o', { search: 'web', osType: NONE });
    expect(where.OR).toHaveLength(3);
    expect(where.AND).toHaveLength(1);
  });

  test('empty isActive is ignored, not read as false', () => {
    expect(buildServerWhere('o', { isActive: '' }).isActive).toBeUndefined();
  });

  test('resolveServerWhere: NONE on a computed status matches nothing without a DB round trip', async () => {
    const where = await resolveServerWhere('o', { sshTrust: NONE });
    expect(where.AND).toContainEqual({ id: { in: [] } });
  });

  test('pickServerFilters drops page / sort / groupBy', () => {
    expect(pickServerFilters({ page: '2', sortBy: 'hostname', groupBy: 'customer', osType: 'linux', search: 'x' })).toEqual({
      osType: 'linux',
      search: 'x',
    });
  });

  test('every group dimension names a list param', () => {
    for (const d of Object.values(SERVER_GROUP_DIMS)) expect(typeof d.param).toBe('string');
  });
});

describe('listServerGroups (live DB)', () => {
  let org;
  let acme;
  let beta;
  let reachable;

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) return;
    org = await createTestOrg();
    const sfx = Date.now().toString(36);
    acme = await prisma.customer.create({ data: { orgId: org.id, name: 'Acme', slug: `acme-${sfx}` } });
    beta = await prisma.customer.create({ data: { orgId: org.id, name: 'Beta', slug: `beta-${sfx}` } });
    const mk = (customerId, hostname, extra = {}) =>
      prisma.server.create({ data: { orgId: org.id, customerId, hostname, ipAddress: `10.9.0.${Math.floor(Math.random() * 250) + 1}`, ...extra } });
    await mk(acme.id, 'a-prod-1', { environment: 'prod', osType: 'linux' });
    await mk(acme.id, 'a-prod-2', { environment: 'prod', osType: null });
    await mk(acme.id, 'a-dev-1', { environment: 'dev', osType: 'linux', provisionStatus: 'provisioned', agentLastSeen: new Date(), agentTokenHash: `h-${sfx}` });
    await mk(beta.id, 'b-dev-1', { environment: 'dev', osType: '' });
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
    await prisma.$disconnect().catch(() => {});
  });

  test('no (valid) levels → empty tree', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    expect(await listServerGroups(org.id, { groupBy: 'bogus' }, UNSCOPED)).toEqual({ groupBy: [], tree: [] });
  });

  test('customer › environment: names as labels, prod first, counts over the whole set', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const { groupBy, tree } = await listServerGroups(org.id, { groupBy: 'customer,environment', pageSize: 1 }, UNSCOPED);
    expect(groupBy).toEqual(['customer', 'environment']);
    const a = tree.find((n) => n.value === acme.id);
    expect(a.label).toBe('Acme');
    expect(a.count).toBe(3);
    expect(a.children.map((c) => [c.value, c.count])).toEqual([
      ['prod', 2],
      ['dev', 1],
    ]);
    expect(tree.find((n) => n.value === beta.id).count).toBe(1);
  });

  test('osType: null and empty fold into one NONE group that the list opens to', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const { tree } = await listServerGroups(org.id, { groupBy: 'osType' }, UNSCOPED);
    const none = tree.find((n) => n.value === NONE);
    expect(none.count).toBe(2);
    expect(tree[tree.length - 1].value).toBe(NONE);
    const rows = await listServers(org.id, { osType: NONE }, UNSCOPED);
    expect(rows.total).toBe(2);
    expect(rows.items.map((r) => r.hostname).sort()).toEqual(['a-prod-2', 'b-dev-1']);
  });

  test('computed sshTrust level: human labels, and each group opens to its own rows', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const { tree } = await listServerGroups(org.id, { groupBy: 'sshTrust,environment' }, UNSCOPED);
    const healthy = tree.find((n) => n.value === 'healthy');
    expect(healthy.label).toBe('Healthy');
    expect(healthy.count).toBe(1);
    const notInstalled = tree.find((n) => n.value === 'not_installed');
    expect(notInstalled.label).toBe('Not installed');
    expect(notInstalled.count).toBe(3);
    const prodNotInstalled = notInstalled.children.find((c) => c.value === 'prod');
    const rows = await listServers(org.id, { sshTrust: 'not_installed', environment: 'prod' }, UNSCOPED);
    expect(rows.total).toBe(prodNotInstalled.count);
  });

  test('filters and search narrow the tree like the list', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const { tree } = await listServerGroups(org.id, { groupBy: 'customer', environment: 'dev', search: 'b-' }, UNSCOPED);
    expect(tree.map((n) => [n.value, n.count])).toEqual([[beta.id, 1]]);
  });

  test('a scoped caller only gets groups for customers in scope', async () => {
    if (!reachable) return console.warn('[skip] DB unreachable');
    const { tree } = await listServerGroups(org.id, { groupBy: 'customer' }, { mode: 'customers', customerIds: [beta.id] });
    expect(tree.map((n) => n.value)).toEqual([beta.id]);
    const none = await listServerGroups(org.id, { groupBy: 'environment', customerId: acme.id }, { mode: 'customers', customerIds: [beta.id] });
    expect(none.tree).toEqual([]);
  });
});
