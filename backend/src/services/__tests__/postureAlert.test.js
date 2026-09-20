/**
 * postureAlert.test.js — routing of posture finding transitions
 * (docs/posture/posture-spec.md §6).
 *
 * The dispatcher is the part of posture that can fail silently: a rule that
 * matches nothing, or a throttle that swallows everything, looks exactly like
 * "nothing is wrong". These tests pin the four decisions that make or break
 * it:
 *
 *   - which rules match a finding (empty field = any, inactive = never)
 *   - resolution notices are opt-in, escalations are not
 *   - a muted finding notifies nobody
 *   - a recipient who cannot see the server is dropped BEFORE delivery —
 *     an alert must not be the thing that tells a scoped user an
 *     out-of-scope server exists
 *   - the throttle claims per (rule, server, finding), so a second event
 *     inside the window is skipped rather than delivered twice
 *
 * The pure-function tests always run. The delivery tests use the
 * dbReachable() skip pattern (see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import redis from '../../config/redis.js';
import * as postureAlertService from '../postureAlertService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

const rule = (over = {}) => ({
  id: 'rule-1',
  isActive: true,
  severities: [],
  codes: [],
  customerIds: [],
  environments: [],
  notifyOnResolve: false,
  ...over,
});

const finding = (over = {}) => ({
  code: 'PORT_EXPOSED',
  severity: 'HIGH',
  proto: 'tcp',
  port: 5432,
  message: 'postgres listening on 0.0.0.0:5432',
  ...over,
});

const server = (over = {}) => ({
  id: 'srv-1',
  hostname: 'db-1.example.com',
  displayName: null,
  environment: 'prod',
  customerId: 'cust-1',
  ...over,
});

describe('ruleMatches', () => {
  it('matches on every empty field (an unconfigured rule is a catch-all)', () => {
    expect(postureAlertService.ruleMatches(rule(), { finding: finding(), server: server() })).toBe(true);
  });

  it('never matches when the rule is inactive', () => {
    expect(
      postureAlertService.ruleMatches(rule({ isActive: false }), { finding: finding(), server: server() })
    ).toBe(false);
  });

  it('filters on severity, code, customer and environment', () => {
    const f = finding();
    const s = server();
    expect(postureAlertService.ruleMatches(rule({ severities: ['CRITICAL'] }), { finding: f, server: s })).toBe(false);
    expect(postureAlertService.ruleMatches(rule({ severities: ['HIGH'] }), { finding: f, server: s })).toBe(true);

    expect(postureAlertService.ruleMatches(rule({ codes: ['FIREWALL_OFF'] }), { finding: f, server: s })).toBe(false);
    expect(postureAlertService.ruleMatches(rule({ codes: ['PORT_EXPOSED'] }), { finding: f, server: s })).toBe(true);

    expect(postureAlertService.ruleMatches(rule({ customerIds: ['other'] }), { finding: f, server: s })).toBe(false);
    expect(postureAlertService.ruleMatches(rule({ customerIds: ['cust-1'] }), { finding: f, server: s })).toBe(true);

    expect(postureAlertService.ruleMatches(rule({ environments: ['dev'] }), { finding: f, server: s })).toBe(false);
    expect(postureAlertService.ruleMatches(rule({ environments: ['prod'] }), { finding: f, server: s })).toBe(true);
  });

  it('ANDs the filters — every configured field has to agree', () => {
    const r = rule({ severities: ['HIGH'], environments: ['dev'] });
    expect(postureAlertService.ruleMatches(r, { finding: finding(), server: server() })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delivery (needs Postgres + Redis)
// ---------------------------------------------------------------------------

describe('dispatchFindingEvents', () => {
  let org;
  let customerA;
  let customerB;
  let srv;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customerA = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${unique()}` },
    });
    customerB = await prisma.customer.create({
      data: { orgId: org.id, name: 'Beta', slug: `beta-${unique()}` },
    });
    srv = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customerA.id,
        hostname: `db-${unique()}.example.com`,
        ipAddress: '10.9.0.4',
        environment: 'prod',
      },
    });
  });

  afterAll(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.exposureFinding.deleteMany({ where: { orgId: org.id } });
    await prisma.postureAlertRule.deleteMany({ where: { orgId: org.id } });
    await prisma.notification.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  beforeEach(async () => {
    if (!(await dbReachable())) return;
    await prisma.postureAlertRule.deleteMany({ where: { orgId: org.id } });
    await prisma.exposureFinding.deleteMany({ where: { orgId: org.id } });
    await prisma.notification.deleteMany({ where: { orgId: org.id } });
  });

  /**
   * Delivery is asserted on the rows notificationService actually wrote —
   * ESM namespaces are frozen, so spying on the module is not an option, and
   * checking the real side effect is the stronger assertion anyway. Every
   * rule below uses the 'inapp' channel only, so no mail is ever attempted.
   */
  const notificationsFor = (userId) =>
    prisma.notification.findMany({ where: { orgId: org.id, userId, type: 'POSTURE_FINDING' } });

  /** A rule that reaches one named user, in-app only, with no throttle. */
  async function ruleFor(userIds, over = {}) {
    return prisma.postureAlertRule.create({
      data: {
        orgId: org.id,
        name: `Rule ${unique()}`,
        recipientUserIds: userIds,
        channels: ['inapp'],
        mode: 'immediate',
        throttleMinutes: 0,
        ...over,
      },
    });
  }

  async function storeFinding(over = {}) {
    return prisma.exposureFinding.create({
      data: {
        orgId: org.id,
        serverId: srv.id,
        code: 'PORT_EXPOSED',
        proto: 'tcp',
        port: 5432,
        severity: 'HIGH',
        message: 'postgres listening on 0.0.0.0:5432',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        ...over,
      },
    });
  }

  const openEvent = (over = {}) => ({ type: 'opened', finding: finding(over) });

  it('notifies a recipient who can see the server', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const user = await createTestUser(org.id, { role: 'admin' });
    await ruleFor([user.id]);
    await storeFinding();

    const res = await postureAlertService.dispatchFindingEvents({
      orgId: org.id,
      serverId: srv.id,
      events: [openEvent()],
    });

    expect(res.sent).toBe(1);
    const rows = await notificationsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain('PORT_EXPOSED');
  });

  it('notifies nobody about a muted finding', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const user = await createTestUser(org.id, { role: 'admin' });
    await ruleFor([user.id]);
    await storeFinding({ mutedUntil: new Date(Date.now() + 60 * 60 * 1000), mutedReason: 'planned' });

    const res = await postureAlertService.dispatchFindingEvents({
      orgId: org.id,
      serverId: srv.id,
      events: [openEvent()],
    });

    expect(res.sent).toBe(0);
    expect(res.skipped).toBe(1);
    expect(await notificationsFor(user.id)).toHaveLength(0);
  });

  it('drops a recipient scoped to a different customer', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const scoped = await createTestUser(org.id, { role: 'manager', data: { accessScope: 'CUSTOMERS' } });
    await prisma.userCustomerScope.create({ data: { userId: scoped.id, customerId: customerB.id } });
    await ruleFor([scoped.id]);
    await storeFinding();

    const res = await postureAlertService.dispatchFindingEvents({
      orgId: org.id,
      serverId: srv.id,
      events: [openEvent()],
    });

    expect(res.sent).toBe(0);
    expect(await notificationsFor(scoped.id)).toHaveLength(0);
  });

  it('keeps a recipient scoped to the server’s own customer', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const scoped = await createTestUser(org.id, { role: 'manager', data: { accessScope: 'CUSTOMERS' } });
    await prisma.userCustomerScope.create({ data: { userId: scoped.id, customerId: customerA.id } });
    await ruleFor([scoped.id]);
    await storeFinding();

    const res = await postureAlertService.dispatchFindingEvents({
      orgId: org.id,
      serverId: srv.id,
      events: [openEvent()],
    });

    expect(res.sent).toBe(1);
  });

  it('stays quiet about a resolution unless the rule opted in', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const user = await createTestUser(org.id, { role: 'admin' });
    const quiet = await ruleFor([user.id]);
    await storeFinding();

    const resolved = { type: 'resolved', finding: finding() };
    expect(
      (await postureAlertService.dispatchFindingEvents({ orgId: org.id, serverId: srv.id, events: [resolved] })).sent
    ).toBe(0);

    await prisma.postureAlertRule.update({ where: { id: quiet.id }, data: { notifyOnResolve: true } });
    expect(
      (await postureAlertService.dispatchFindingEvents({ orgId: org.id, serverId: srv.id, events: [resolved] })).sent
    ).toBe(1);
  });

  it('throttles a repeat of the same finding for the same rule', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const user = await createTestUser(org.id, { role: 'admin' });
    const r = await ruleFor([user.id], { throttleMinutes: 60 });
    await storeFinding();
    // Leave nothing behind from an earlier run of this file.
    await redis.del(`posture:alert:${r.id}:${srv.id}:PORT_EXPOSED::tcp::5432`);

    const first = await postureAlertService.dispatchFindingEvents({
      orgId: org.id,
      serverId: srv.id,
      events: [openEvent()],
    });
    const second = await postureAlertService.dispatchFindingEvents({
      orgId: org.id,
      serverId: srv.id,
      events: [openEvent()],
    });

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);

    await redis.del(`posture:alert:${r.id}:${srv.id}:PORT_EXPOSED::tcp::5432`);
  });

  it('is a no-op for an org with no rules', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    await storeFinding();
    const res = await postureAlertService.dispatchFindingEvents({
      orgId: org.id,
      serverId: srv.id,
      events: [openEvent()],
    });
    expect(res).toEqual({ sent: 0, skipped: 0 });
  });

  it('seeds the quiet default rule exactly once', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const created = await postureAlertService.ensureDefaultAlertRule(org.id);
    expect(created).toMatchObject({ severities: ['CRITICAL'], mode: 'immediate' });
    expect(await postureAlertService.ensureDefaultAlertRule(org.id)).toBeNull();
  });
});
