/**
 * SSH trust + collector status for server lists (serverAgentStatus).
 * Pure rules first, then listServers' status filters against a live DB.
 */
import prisma from '../../config/db.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';
import { sshTrustStatus, collectorStatus, HEARTBEAT_STALE_MS } from '../serverAgentStatus.js';
import { listServers } from '../serverService.js';
import { UNSCOPED } from '../../lib/scope.js';

const linux = { osType: 'linux', protocol: 'ssh' };
const now = Date.now();

describe('sshTrustStatus', () => {
  it.each([
    [{ osType: 'windows', protocol: 'rdp' }, 'not_applicable'],
    [{ ...linux, provisionStatus: 'provisioning' }, 'installing'],
    [{ ...linux, provisionStatus: 'failed', provisionError: 'ssh timeout' }, 'failed'],
    [{ ...linux, provisionStatus: 'pending', authMode: 'credential' }, 'identity_auth'],
    [{ ...linux, provisionStatus: 'pending', authMode: 'certificate' }, 'not_installed'],
    [{ ...linux, provisionStatus: 'provisioned' }, 'no_heartbeat'],
    [{ ...linux, provisionStatus: 'provisioned', agentLastSeen: new Date(now - HEARTBEAT_STALE_MS - 1000), agentTokenHash: 'h' }, 'stale'],
    [{ ...linux, provisionStatus: 'provisioned', agentLastSeen: new Date(now - 30000) }, 'legacy_token'],
    [{ ...linux, provisionStatus: 'provisioned', agentLastSeen: new Date(now - 30000), agentTokenHash: 'h' }, 'healthy'],
  ])('%o → %s', (server, state) => {
    expect(sshTrustStatus(server, now).state).toBe(state);
  });

  it('a failed re-bootstrap on a host that already trusts the CA is judged by its heartbeat, not the failure', () => {
    const s = { ...linux, provisionStatus: 'failed', agentId: 'a1', agentLastSeen: new Date(now - 1000), agentTokenHash: 'h' };
    expect(sshTrustStatus(s, now).state).toBe('healthy');
  });
});

describe('collectorStatus', () => {
  const settings = { collectIntervalSeconds: 300 };
  it('calls a reporting host on an older collector "outdated"', () => {
    expect(collectorStatus(linux, { receivedAt: new Date(now - 60000), collectorOk: true, agentVersion: '1.0.0' }, settings, now).state).toBe('outdated');
  });
  it('waits for the new collector after a reinstall instead of showing the old report', () => {
    const s = { ...linux, postureInstalledAt: new Date(now - 30000) };
    expect(collectorStatus(s, { receivedAt: new Date(now - 120000), collectorOk: false, agentVersion: '1.0.0' }, settings, now).state).toBe('awaiting_report');
  });
  it('gives up waiting after the stale threshold', () => {
    const s = { ...linux, postureInstalledAt: new Date(now - 20 * 60000) };
    expect(collectorStatus(s, { receivedAt: new Date(now - 30 * 60000), collectorOk: true }, settings, now).state).toBe('stale');
  });
});

describe('listServers status columns and filters (live DB)', () => {
  let org;
  let healthy;
  let bare;
  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    const customer = await prisma.customer.create({ data: { orgId: org.id, name: 'Status Co', slug: `status-${Date.now()}` } });
    healthy = await prisma.server.create({
      data: { orgId: org.id, customerId: customer.id, hostname: 'ok-1', ipAddress: '10.2.0.1', provisionStatus: 'provisioned', agentLastSeen: new Date(), agentTokenHash: `h-${Date.now()}` },
    });
    bare = await prisma.server.create({ data: { orgId: org.id, customerId: customer.id, hostname: 'bare-1', ipAddress: '10.2.0.2' } });
  });
  afterAll(async () => {
    if (!org) return;
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
    await prisma.$disconnect().catch(() => {});
  });

  test('every row carries both statuses; no secret column leaks', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const { items } = await listServers(org.id, {}, UNSCOPED);
    const ok = items.find((i) => i.id === healthy.id);
    expect(ok.sshTrust.state).toBe('healthy');
    expect(ok.collector.state).toBe('not_installed');
    expect(ok.agentTokenHash).toBeUndefined();
  });

  test('filters by SSH trust and collector state, with totals that match', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const trusted = await listServers(org.id, { sshTrust: 'healthy' }, UNSCOPED);
    expect(trusted.items.map((i) => i.id)).toEqual([healthy.id]);
    expect(trusted.total).toBe(1);
    const notInstalled = await listServers(org.id, { sshTrust: 'not_installed' }, UNSCOPED);
    expect(notInstalled.items.map((i) => i.id)).toEqual([bare.id]);
    const none = await listServers(org.id, { collector: 'reporting' }, UNSCOPED);
    expect(none.total).toBe(0);
    // An unknown value is ignored rather than matching nothing.
    const all = await listServers(org.id, { collector: 'bogus' }, UNSCOPED);
    expect(all.total).toBe(2);
  });

  test('a scoped caller filtering by status still only sees in-scope servers', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const scoped = await listServers(org.id, { sshTrust: 'healthy' }, { mode: 'customers', customerIds: ['nope'] });
    expect(scoped.total).toBe(0);
  });
});
