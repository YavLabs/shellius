/**
 * Filter-picker lookups: searchable, org- and customer-scoped, not capped
 * at the list APIs' 100 rows.
 */
import prisma from '../../config/db.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';
import { lookupServers, lookupCustomers, lookupUsers } from '../lookupService.js';
import { UNSCOPED } from '../../lib/scope.js';

describe('lookupService (live DB)', () => {
  let org;
  let acme;
  let beta;
  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    const stamp = Date.now();
    acme = await prisma.customer.create({ data: { orgId: org.id, name: 'Acme', slug: `acme-${stamp}` } });
    beta = await prisma.customer.create({ data: { orgId: org.id, name: 'Beta', slug: `beta-${stamp}` } });
    const rows = Array.from({ length: 120 }, (_, i) => ({
      orgId: org.id,
      customerId: i < 110 ? acme.id : beta.id,
      hostname: `web-${String(i).padStart(3, '0')}`,
      ipAddress: `10.9.0.${i % 250}`,
    }));
    await prisma.server.createMany({ data: rows });
    await prisma.server.create({ data: { orgId: org.id, customerId: acme.id, hostname: 'db-main', displayName: 'Main DB', ipAddress: '10.9.1.1' } });
    await prisma.user.create({ data: { orgId: org.id, email: `ada-${stamp}@example.test`, name: 'Ada Lovelace', role: 'member' } });
  });
  afterAll(async () => {
    if (!org) return;
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
    await prisma.$disconnect().catch(() => {});
  });

  test('finds a server past the 100th by what the user typed — name, display name or IP', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    expect((await lookupServers(org.id, UNSCOPED, { q: 'web-115', limit: 25 })).map((o) => o.label)).toEqual(['web-115']);
    const db = await lookupServers(org.id, UNSCOPED, { q: 'main db', limit: 25 });
    expect(db[0]).toMatchObject({ label: 'Main DB' });
    expect(db[0].sublabel).toContain('db-main');
  });

  test('labels specific ids (a value already in the URL)', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const one = await prisma.server.findFirst({ where: { orgId: org.id, hostname: 'web-005' } });
    expect(await lookupServers(org.id, UNSCOPED, { ids: [one.id], limit: 25 })).toHaveLength(1);
  });

  test('a scoped caller only ever sees their customers’ servers and customers', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const scope = { mode: 'customers', customerIds: [beta.id] };
    const servers = await lookupServers(org.id, scope, { q: 'web', limit: 50 });
    expect(servers).toHaveLength(10);
    expect(servers.every((s) => s.sublabel.includes('Beta'))).toBe(true);
    // Asking for an out-of-scope id by name returns nothing, not the row.
    const acmeOnly = await prisma.server.findFirst({ where: { orgId: org.id, customerId: acme.id } });
    expect(await lookupServers(org.id, scope, { ids: [acmeOnly.id], limit: 25 })).toEqual([]);
    expect((await lookupCustomers(org.id, scope, { q: '', limit: 25 })).map((c) => c.label)).toEqual(['Beta']);
  });

  test('users by name or email', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    expect((await lookupUsers(org.id, { q: 'lovelace', limit: 25 }))[0].label).toBe('Ada Lovelace');
  });
});
