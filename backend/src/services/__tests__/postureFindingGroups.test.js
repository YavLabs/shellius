/**
 * postureFindingGroups.test.js — the Posture inbox's group tree
 * (GET /api/posture/findings/groups) and the filters its groups open with.
 *
 * What is worth pinning:
 *   - the groups' where keeps the customer-scope predicate as an AND. A
 *     previous bug let a filter replace the scope predicate; a grouped view
 *     is an aggregate, and an aggregate leak is still a leak.
 *   - the section partition is applied exactly as the list applies it, so a
 *     group's count is the number of rows it opens to.
 *   - server / customer / environment ride on serverId and are labelled
 *     from org-scoped lookups; port groups carry `proto/port` or NONE.
 *   - every group value is accepted back by the list as a filter.
 *
 * Prisma calls are stubbed with jest.spyOn on the shared client (no DB).
 */

import { jest } from '@jest/globals';
import prisma from '../../config/db.js';
import * as postureQueryService from '../postureQueryService.js';
import { NONE } from '../../utils/groupTree.js';

const ORG = 'org-1';
const scoped = { mode: 'customers', customerIds: ['cust-a'] };

/** Every { server: … } clause in an AND list, flattened. */
function serverClauses(and) {
  const out = [];
  for (const c of and) {
    if (!c.server) continue;
    if (c.server.AND) out.push(...c.server.AND);
    else out.push(c.server);
  }
  return out;
}

describe('getFindingGroups', () => {
  let groupBy;
  let serverFindMany;
  let customerFindMany;

  beforeEach(() => {
    groupBy = jest.spyOn(prisma.exposureFinding, 'groupBy');
    serverFindMany = jest.spyOn(prisma.server, 'findMany');
    customerFindMany = jest.spyOn(prisma.customer, 'findMany');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns an empty tree without querying when no level is valid', async () => {
    const out = await postureQueryService.getFindingGroups(ORG, { groupBy: 'status,bogus' }, scoped);
    expect(out).toEqual({ groupBy: [], tree: [] });
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('keeps the customer-scope predicate ANDed with a customerId filter, never replaced by it', async () => {
    groupBy.mockResolvedValue([]);
    await postureQueryService.getFindingGroups(
      ORG,
      { groupBy: 'severity', section: 'open', customerId: 'cust-b' },
      scoped
    );

    const { where } = groupBy.mock.calls[0][0];
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toContainEqual({ orgId: ORG });
    const clauses = serverClauses(where.AND);
    // Both, side by side: the scope AND the requested customer.
    expect(clauses).toContainEqual({ customerId: { in: ['cust-a'] } });
    expect(clauses).toContainEqual({ customerId: 'cust-b' });
    expect(clauses).toContainEqual({ isActive: true });
  });

  it('applies the section partition the same way the list does', async () => {
    groupBy.mockResolvedValue([]);
    const findMany = jest.spyOn(prisma.exposureFinding, 'findMany').mockResolvedValue([]);
    const count = jest.spyOn(prisma.exposureFinding, 'count').mockResolvedValue(0);

    const query = { section: 'acknowledged', severity: 'high', code: 'PORT_EXPOSED' };
    await postureQueryService.getFindingGroups(ORG, { ...query, groupBy: 'code' }, scoped);
    await postureQueryService.listFindings(ORG, query, scoped);

    const strip = (and) => JSON.stringify(and, (k, v) => (k === 'lte' || k === 'gt' ? 'now' : v));
    expect(strip(groupBy.mock.calls[0][0].where.AND)).toBe(strip(findMany.mock.calls[0][0].where.AND));
    expect(count).toHaveBeenCalled();
  });

  it('groups server › severity with labels resolved from org-scoped lookups and severities in order', async () => {
    groupBy.mockResolvedValue([
      { serverId: 's1', severity: 'LOW', _count: { _all: 2 } },
      { serverId: 's1', severity: 'CRITICAL', _count: { _all: 1 } },
      { serverId: 's2', severity: 'HIGH', _count: { _all: 5 } },
    ]);
    serverFindMany.mockResolvedValue([
      { id: 's1', hostname: 'web-1', displayName: 'Web one', environment: 'prod', customerId: 'cust-a' },
      { id: 's2', hostname: 'db-1', displayName: null, environment: 'dev', customerId: 'cust-a' },
    ]);

    const out = await postureQueryService.getFindingGroups(ORG, { groupBy: 'server,severity' }, scoped);

    expect(groupBy.mock.calls[0][0].by).toEqual(['serverId', 'severity']);
    expect(serverFindMany.mock.calls[0][0].where).toEqual({ orgId: ORG, id: { in: ['s1', 's2'] } });
    expect(customerFindMany).not.toHaveBeenCalled();
    expect(out.groupBy).toEqual(['server', 'severity']);
    // Biggest server first.
    expect(out.tree.map((n) => [n.value, n.label, n.count])).toEqual([
      ['s2', 'db-1', 5],
      ['s1', 'Web one', 3],
    ]);
    expect(out.tree[1].children.map((n) => [n.value, n.label])).toEqual([
      ['CRITICAL', 'Critical'],
      ['LOW', 'Low'],
    ]);
  });

  it('customer › environment rides on serverId; environments in prod-first order', async () => {
    groupBy.mockResolvedValue([
      { serverId: 's1', _count: { _all: 1 } },
      { serverId: 's2', _count: { _all: 4 } },
      { serverId: 's3', _count: { _all: 2 } },
    ]);
    serverFindMany.mockResolvedValue([
      { id: 's1', hostname: 'a', displayName: null, environment: 'prod', customerId: 'cust-a' },
      { id: 's2', hostname: 'b', displayName: null, environment: 'dev', customerId: 'cust-a' },
      { id: 's3', hostname: 'c', displayName: null, environment: 'staging', customerId: 'cust-b' },
    ]);
    customerFindMany.mockResolvedValue([
      { id: 'cust-a', name: 'Acme' },
      { id: 'cust-b', name: 'Beta' },
    ]);

    const out = await postureQueryService.getFindingGroups(ORG, { groupBy: 'customer,environment' }, undefined);

    expect(groupBy.mock.calls[0][0].by).toEqual(['serverId']);
    expect(customerFindMany.mock.calls[0][0].where).toEqual({ orgId: ORG, id: { in: ['cust-a', 'cust-b'] } });
    expect(out.tree.map((n) => [n.value, n.label, n.count])).toEqual([
      ['cust-a', 'Acme', 5],
      ['cust-b', 'Beta', 2],
    ]);
    expect(out.tree[0].children.map((n) => n.value)).toEqual(['prod', 'dev']);
    expect(out.tree[0].children[0].label).toBe('Production');
  });

  it('port groups carry proto/port, and findings with no port fall in NONE (last)', async () => {
    groupBy.mockResolvedValue([
      { proto: null, port: null, _count: { _all: 9 } },
      { proto: 'tcp', port: 443, _count: { _all: 3 } },
      { proto: 'udp', port: 53, _count: { _all: 1 } },
    ]);
    const out = await postureQueryService.getFindingGroups(ORG, { groupBy: 'port' }, undefined);
    expect(groupBy.mock.calls[0][0].by).toEqual(['proto', 'port']);
    expect(out.tree.map((n) => [n.value, n.label, n.count])).toEqual([
      ['tcp/443', 'tcp/443', 3],
      ['udp/53', 'udp/53', 1],
      [NONE, 'No port', 9],
    ]);
  });
});

describe('findingsPortWhere — a port group opens through the list', () => {
  it('maps proto/port, a bare port and NONE', () => {
    expect(postureQueryService.findingsPortWhere('tcp/443')).toEqual({ AND: [{ port: 443 }, { proto: 'tcp' }] });
    expect(postureQueryService.findingsPortWhere('22')).toEqual({ port: 22 });
    expect(postureQueryService.findingsPortWhere(NONE)).toEqual({ port: null });
  });

  it('ignores an empty value and matches nothing for garbage', () => {
    expect(postureQueryService.findingsPortWhere('')).toBeNull();
    expect(postureQueryService.findingsPortWhere(undefined)).toBeNull();
    expect(postureQueryService.findingsPortWhere('nope')).toEqual({ id: { in: [] } });
  });

  it('listFindings accepts every group dimension back as a filter', async () => {
    const findMany = jest.spyOn(prisma.exposureFinding, 'findMany').mockResolvedValue([]);
    jest.spyOn(prisma.exposureFinding, 'count').mockResolvedValue(0);
    try {
      await postureQueryService.listFindings(
        ORG,
        {
          section: 'open',
          severity: 'CRITICAL',
          serverId: 's1',
          customerId: 'cust-a',
          environment: 'prod',
          code: 'PORT_EXPOSED',
          port: 'tcp/443',
        },
        scoped
      );
      const and = findMany.mock.calls[0][0].where.AND;
      expect(and).toContainEqual({ severity: 'CRITICAL' });
      expect(and).toContainEqual({ serverId: 's1' });
      expect(and).toContainEqual({ code: 'PORT_EXPOSED' });
      expect(and).toContainEqual({ AND: [{ port: 443 }, { proto: 'tcp' }] });
      const clauses = serverClauses(and);
      expect(clauses).toContainEqual({ customerId: 'cust-a' });
      expect(clauses).toContainEqual({ environment: 'prod' });
      expect(clauses).toContainEqual({ customerId: { in: ['cust-a'] } });
    } finally {
      jest.restoreAllMocks();
    }
  });
});
