/**
 * searchService tests.
 *
 * Role-gating and ranking are pure functions (getAllowedTypes, bestScore,
 * rankAndLimit) — tested directly, no DB. search() itself is exercised as a
 * live-DB integration test (dbReachable() skip pattern, matching the rest of
 * this suite — see testDbHelper.js) since jest.unstable_mockModule with
 * file:// URLs is broken in this Jest + Node ESM combination (see
 * caService.test.js).
 */

import {
  getAllowedTypes,
  bestScore,
  rankAndLimit,
  search,
  SEARCH_TYPES,
} from '../searchService.js';
import prisma from '../../config/db.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

// ---------------------------------------------------------------------------
// getAllowedTypes — role gating
// ---------------------------------------------------------------------------

describe('getAllowedTypes', () => {
  test('member sees only servers/customers', () => {
    expect(getAllowedTypes('member')).toEqual(['servers', 'customers']);
  });

  test('manager sees servers/customers + identities/keys', () => {
    expect(getAllowedTypes('manager')).toEqual(
      expect.arrayContaining(['servers', 'customers', 'identities', 'keys']),
    );
    expect(getAllowedTypes('manager')).not.toEqual(expect.arrayContaining(['users', 'policies']));
  });

  test('admin sees everything', () => {
    expect(getAllowedTypes('admin')).toEqual(expect.arrayContaining(SEARCH_TYPES));
  });

  test('super_admin sees everything', () => {
    expect(getAllowedTypes('super_admin')).toEqual(expect.arrayContaining(SEARCH_TYPES));
  });

  test('unknown/missing role sees nothing (fail closed)', () => {
    expect(getAllowedTypes(undefined)).toEqual([]);
    expect(getAllowedTypes('bogus')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bestScore — exact < prefix < contains
// ---------------------------------------------------------------------------

describe('bestScore', () => {
  test('exact match scores 0', () => {
    expect(bestScore(['web-01'], 'web-01')).toBe(0);
  });

  test('prefix match scores 1', () => {
    expect(bestScore(['web-01.prod'], 'web-01')).toBe(1);
  });

  test('contains match scores 2', () => {
    expect(bestScore(['my-web-01-server'], 'web-01')).toBe(2);
  });

  test('is case-insensitive', () => {
    expect(bestScore(['WEB-01'], 'web-01')).toBe(0);
  });

  test('takes the best score across multiple fields', () => {
    expect(bestScore(['nomatch-field', 'web-01'], 'web-01')).toBe(0);
  });

  test('ignores null/undefined fields', () => {
    expect(bestScore([null, undefined, 'web-01'], 'web-01')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rankAndLimit — sorts by score then title, truncates, strips _score
// ---------------------------------------------------------------------------

describe('rankAndLimit', () => {
  test('orders exact > prefix > contains', () => {
    const items = [
      { title: 'contains', _score: 2 },
      { title: 'exact', _score: 0 },
      { title: 'prefix', _score: 1 },
    ];
    expect(rankAndLimit(items, 10).map((i) => i.title)).toEqual(['exact', 'prefix', 'contains']);
  });

  test('breaks ties alphabetically', () => {
    const items = [
      { title: 'zebra', _score: 1 },
      { title: 'apple', _score: 1 },
    ];
    expect(rankAndLimit(items, 10).map((i) => i.title)).toEqual(['apple', 'zebra']);
  });

  test('truncates to limit', () => {
    const items = [
      { title: 'a', _score: 0 },
      { title: 'b', _score: 0 },
      { title: 'c', _score: 0 },
    ];
    expect(rankAndLimit(items, 2)).toHaveLength(2);
  });

  test('strips the internal _score field', () => {
    const [item] = rankAndLimit([{ title: 'a', _score: 0 }], 1);
    expect(item).not.toHaveProperty('_score');
  });
});

// ---------------------------------------------------------------------------
// search() — live-DB integration
// ---------------------------------------------------------------------------

describe('search — integration', () => {
  let org;
  let customer;
  let server;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme Search Corp', slug: `acme-search-${Date.now()}` },
    });
    server = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: 'search-web-01.acme.internal',
        ipAddress: '10.20.30.40',
        environment: 'dev',
        protocol: 'ssh',
      },
    });
    await prisma.accessPolicy.create({
      data: {
        orgId: org.id,
        name: 'Search Test Policy',
        effect: 'ALLOW',
        targetEnvironments: ['dev'],
        allowedPrincipals: ['ubuntu'],
        maxSessionDuration: 3600,
      },
    });
  });

  afterAll(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.accessPolicy.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  test('member finds servers/customers but not policies (gated)', async () => {
    if (!(await dbReachable())) {
      console.warn('DB unreachable — skipping search integration test');
      return;
    }
    const { results, counts } = await search({ orgId: org.id, role: 'member', q: 'search-web' });
    expect(results.servers.length).toBeGreaterThan(0);
    expect(results.servers[0].id).toBe(server.id);
    expect(results.servers[0].href).toBe(`/servers/${server.id}`);
    expect(results.policies).toEqual([]);
    expect(counts.policies).toBe(0);
  });

  test('admin finds policies too', async () => {
    if (!(await dbReachable())) return;
    const { results } = await search({ orgId: org.id, role: 'admin', q: 'Search Test Policy' });
    expect(results.policies.length).toBeGreaterThan(0);
    expect(results.policies[0].meta.effect).toBe('ALLOW');
  });

  test('never leaks another org\'s data', async () => {
    if (!(await dbReachable())) return;
    const otherOrg = await createTestOrg();
    try {
      const { results } = await search({ orgId: otherOrg.id, role: 'admin', q: 'search-web' });
      expect(results.servers).toEqual([]);
    } finally {
      await cleanupOrg(otherOrg.id);
    }
  });

  test('server meta includes onboarded flag computed from provision state', async () => {
    if (!(await dbReachable())) return;
    const { results } = await search({ orgId: org.id, role: 'member', q: 'search-web' });
    expect(results.servers[0].meta).toHaveProperty('onboarded');
    expect(typeof results.servers[0].meta.onboarded).toBe('boolean');
  });
});
