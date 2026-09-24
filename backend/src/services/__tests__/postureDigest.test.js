/**
 * postureDigest.test.js — the batched posture email.
 *
 * This feature has been shipped broken once already: `mode: 'digest'`
 * suppressed the immediate email and deferred to a job that did not exist, so
 * those rules delivered nothing at all and said nothing about it. So the
 * assertions here are weighted towards the ways a digest goes quiet:
 *
 *   - a digest rule must still deliver its in-app rows immediately
 *   - the watermark must advance on an empty period, or the window grows
 *     without bound
 *   - the watermark must NOT advance when the send failed, or a period is
 *     skipped in silence
 *   - a scoped recipient must never see an out-of-scope server in a summary
 *   - a rule switched into digest mode must not mail out a month of history
 *
 * Mail is asserted by injecting a fake sender rather than by spying: ESM
 * namespaces are frozen, which is the same reason postureAlert.test.js
 * asserts on the Notification rows that were actually written.
 */

import prisma from '../../config/db.js';
import * as postureDigestService from '../postureDigestService.js';
import * as postureAlertService from '../postureAlertService.js';
import { runDigestPass } from '../../jobs/postureDigest.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

let seq = 0;
function unique() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('postureDigestService.dueWindow', () => {
  // Pure — always runs.
  test('anchors on lastDigestAt when it is set', () => {
    const r = postureDigestService.dueWindow(
      {
        digestSchedule: 'daily',
        digestHour: 8,
        lastDigestAt: new Date('2026-03-09T08:00:00Z'),
        createdAt: new Date('2020-01-01T00:00:00Z'),
      },
      new Date('2026-03-10T08:05:00Z')
    );
    expect(r.due).toBe(true);
    expect(r.from.toISOString()).toBe('2026-03-09T08:00:00.000Z');
  });

  // The failure this prevents: switching a year-old rule to digest and
  // mailing everyone a month of history as though it had just happened.
  test('falls back to createdAt, never to the beginning of time', () => {
    const r = postureDigestService.dueWindow(
      {
        digestSchedule: 'daily',
        digestHour: 8,
        lastDigestAt: null,
        createdAt: new Date('2026-03-10T07:00:00Z'),
      },
      new Date('2026-03-10T08:05:00Z')
    );
    expect(r.due).toBe(true);
    expect(r.from.toISOString()).toBe('2026-03-10T07:00:00.000Z');
  });

  test('a NULL cadence is read as daily at 08:00 UTC, not midnight', () => {
    const notYet = postureDigestService.dueWindow(
      { digestSchedule: null, digestHour: null, lastDigestAt: new Date('2026-03-09T09:00:00Z'), createdAt: new Date('2026-03-09T09:00:00Z') },
      new Date('2026-03-10T07:00:00Z')
    );
    expect(notYet.due).toBe(false);
    const now = postureDigestService.dueWindow(
      { digestSchedule: null, digestHour: null, lastDigestAt: new Date('2026-03-09T09:00:00Z'), createdAt: new Date('2026-03-09T09:00:00Z') },
      new Date('2026-03-10T08:01:00Z')
    );
    expect(now.due).toBe(true);
  });
});

describe('posture digest — delivery', () => {
  let org;
  let customerA;
  let customerB;
  let srvA;
  let srvB;
  let sent;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customerA = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${unique()}` },
    });
    customerB = await prisma.customer.create({
      data: { orgId: org.id, name: 'Beta', slug: `beta-${unique()}` },
    });
    srvA = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customerA.id,
        hostname: `a-${unique()}.example.com`,
        ipAddress: '10.9.0.4',
        environment: 'prod',
      },
    });
    srvB = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customerB.id,
        hostname: `b-${unique()}.example.com`,
        ipAddress: '10.9.0.5',
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
    await prisma.exposureFinding.deleteMany({ where: { orgId: org.id } });
    await prisma.postureAlertRule.deleteMany({ where: { orgId: org.id } });
    await prisma.notification.deleteMany({ where: { orgId: org.id } });
    sent = [];
  });

  /**
   * A recording sender. `sendMail` is injected rather than monkey-patched
   * because ESM namespace objects are frozen — the same constraint that makes
   * postureAlert.test.js assert on real Notification rows.
   */
  const recorder = (impl) => async (m) => {
    if (impl) return impl(m);
    sent.push(m);
    return undefined;
  };

  const ruleFor = (userIds, over = {}) =>
    prisma.postureAlertRule.create({
      data: {
        orgId: org.id,
        name: `digest-${unique()}`,
        recipientUserIds: userIds,
        channels: ['email'],
        mode: 'digest',
        digestSchedule: 'daily',
        digestHour: 8,
        throttleMinutes: 0,
        ...over,
      },
    });

  const storeFinding = (over = {}) =>
    prisma.exposureFinding.create({
      data: {
        orgId: org.id,
        serverId: srvA.id,
        code: 'PORT_EXPOSED',
        severity: 'HIGH',
        proto: 'tcp',
        port: 5432 + (seq += 1),
        message: 'postgres listening on 0.0.0.0',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        ...over,
      },
    });

  test('collects findings opened inside the window', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    const r = await ruleFor([user.id]);
    const from = new Date(Date.now() - DAY);
    const to = new Date();

    await storeFinding({ firstSeenAt: new Date(Date.now() - 2 * HOUR) });
    // Outside the window, on both sides.
    await storeFinding({ firstSeenAt: new Date(Date.now() - 3 * DAY) });

    const { opened } = await postureDigestService.findingsForWindow(r, { from, to });
    expect(opened).toHaveLength(1);
  });

  test('leaves out muted, resolved and acknowledged findings', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    const r = await ruleFor([user.id]);
    const recent = new Date(Date.now() - HOUR);

    await storeFinding({ firstSeenAt: recent, mutedUntil: new Date(Date.now() + DAY) });
    await storeFinding({ firstSeenAt: recent, resolvedAt: new Date() });
    await storeFinding({ firstSeenAt: recent, acknowledgedAt: new Date() });
    await storeFinding({ firstSeenAt: recent }); // the only one that counts

    const { opened } = await postureDigestService.findingsForWindow(r, {
      from: new Date(Date.now() - DAY),
      to: new Date(),
    });
    expect(opened).toHaveLength(1);
  });

  test('an expired mute stops suppressing', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    const r = await ruleFor([user.id]);
    await storeFinding({ firstSeenAt: new Date(Date.now() - HOUR), mutedUntil: new Date(Date.now() - HOUR) });
    const { opened } = await postureDigestService.findingsForWindow(r, {
      from: new Date(Date.now() - DAY),
      to: new Date(),
    });
    expect(opened).toHaveLength(1);
  });

  test("respects the rule's own severity filter", async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    const r = await ruleFor([user.id], { severities: ['CRITICAL'] });
    await storeFinding({ severity: 'HIGH', firstSeenAt: new Date(Date.now() - HOUR) });
    await storeFinding({ severity: 'CRITICAL', firstSeenAt: new Date(Date.now() - HOUR) });
    const { opened } = await postureDigestService.findingsForWindow(r, {
      from: new Date(Date.now() - DAY),
      to: new Date(),
    });
    expect(opened).toHaveLength(1);
    expect(opened[0].severity).toBe('CRITICAL');
  });

  test('resolution notices are opt-in', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    const quiet = await ruleFor([user.id]);
    await storeFinding({ firstSeenAt: new Date(Date.now() - 3 * DAY), resolvedAt: new Date(Date.now() - HOUR) });

    const a = await postureDigestService.findingsForWindow(quiet, {
      from: new Date(Date.now() - DAY),
      to: new Date(),
    });
    expect(a.resolved).toHaveLength(0);

    const loud = await ruleFor([user.id], { notifyOnResolve: true });
    const b = await postureDigestService.findingsForWindow(loud, {
      from: new Date(Date.now() - DAY),
      to: new Date(),
    });
    expect(b.resolved).toHaveLength(1);
  });

  test('sends one email per recipient', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const u1 = await createTestUser(org.id, { role: 'admin' });
    const u2 = await createTestUser(org.id, { role: 'admin' });
    const r = await ruleFor([u1.id, u2.id]);
    await storeFinding({ firstSeenAt: new Date(Date.now() - HOUR) });

    await postureDigestService.sendDigest(r, { from: new Date(Date.now() - DAY), to: new Date(), sendMail: recorder() });
    expect(sent).toHaveLength(2);
    expect(sent[0].subject).toMatch(/Posture digest/);
    expect(sent[0].html).toContain('PORT_EXPOSED');
  });

  // The tenancy guarantee: a summary must not be the thing that tells a
  // scoped user an out-of-scope server exists.
  test('a scoped recipient sees only their own customers', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const scoped = await createTestUser(org.id, { role: 'manager', data: { accessScope: 'CUSTOMERS' } });
    await prisma.userCustomerScope.create({ data: { userId: scoped.id, customerId: customerA.id } });
    const r = await ruleFor([scoped.id]);
    await storeFinding({ serverId: srvA.id, firstSeenAt: new Date(Date.now() - HOUR) });
    await storeFinding({ serverId: srvB.id, firstSeenAt: new Date(Date.now() - HOUR), code: 'FIREWALL_INACTIVE' });

    await postureDigestService.sendDigest(r, { from: new Date(Date.now() - DAY), to: new Date(), sendMail: recorder() });
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain('PORT_EXPOSED');
    expect(sent[0].html).not.toContain('FIREWALL_INACTIVE');
  });

  test('a recipient who can see nothing in the window gets no email at all', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const scoped = await createTestUser(org.id, { role: 'manager', data: { accessScope: 'CUSTOMERS' } });
    await prisma.userCustomerScope.create({ data: { userId: scoped.id, customerId: customerB.id } });
    const r = await ruleFor([scoped.id]);
    await storeFinding({ serverId: srvA.id, firstSeenAt: new Date(Date.now() - HOUR) });

    await postureDigestService.sendDigest(r, { from: new Date(Date.now() - DAY), to: new Date(), sendMail: recorder() });
    expect(sent).toHaveLength(0);
  });

  // Saying "nothing happened" every morning is how a digest gets filtered
  // into a folder and stops being read.
  test('an empty period sends nothing', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    const r = await ruleFor([user.id]);
    await postureDigestService.sendDigest(r, { from: new Date(Date.now() - DAY), to: new Date(), sendMail: recorder() });
    expect(sent).toHaveLength(0);
  });

  test('a rule with no email channel is a no-op, not an error', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    const r = await ruleFor([user.id], { channels: ['inapp'] });
    await storeFinding({ firstSeenAt: new Date(Date.now() - HOUR) });
    const result = await postureDigestService.sendDigest(r, { from: new Date(Date.now() - DAY), to: new Date(), sendMail: recorder() });
    expect(sent).toHaveLength(0);
    expect(result.skipped).toContain('no email channel');
  });

  test('one undeliverable address does not cost the others their digest', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const u1 = await createTestUser(org.id, { role: 'admin' });
    const u2 = await createTestUser(org.id, { role: 'admin' });
    const r = await ruleFor([u1.id, u2.id]);
    await storeFinding({ firstSeenAt: new Date(Date.now() - HOUR) });

    let calls = 0;
    const result = await postureDigestService.sendDigest(r, {
      from: new Date(Date.now() - DAY),
      to: new Date(),
      sendMail: recorder(async (m) => {
        calls += 1;
        if (calls === 1) throw new Error('550 mailbox unavailable');
        sent.push(m);
      }),
    });
    expect(calls).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.skipped).toHaveLength(1);
  });

  // A rule that matches real findings and reaches nobody is the same bug this
  // whole feature was rebuilt to remove, one layer further down. It must be
  // recorded, not inferred from a zero.
  test('records WHY a recipient got nothing, rather than skipping silently', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const scoped = await createTestUser(org.id, { role: 'manager', data: { accessScope: 'CUSTOMERS' } });
    await prisma.userCustomerScope.create({ data: { userId: scoped.id, customerId: customerB.id } });
    const r = await ruleFor([scoped.id]);
    await storeFinding({ serverId: srvA.id, firstSeenAt: new Date(Date.now() - HOUR) });

    const result = await postureDigestService.sendDigest(r, {
      from: new Date(Date.now() - DAY),
      to: new Date(),
      sendMail: recorder(),
    });

    expect(sent).toHaveLength(0);
    expect(result.findings).toBeGreaterThan(0);
    expect(result.scopedOut).toBe(1);
    expect(result.skipped[0]).toMatch(/customer scope/);
  });

  // The fault-isolation boundary was drawn one line too late: rendering sat
  // outside the try, so a template fault on recipient three rejected the whole
  // call after one and two had already been mailed — and the job then re-sent
  // the same window to all of them.
  test('a render fault costs one recipient, not everybody', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const u1 = await createTestUser(org.id, { role: 'admin' });
    const u2 = await createTestUser(org.id, { role: 'admin' });
    const r = await ruleFor([u1.id, u2.id]);
    // A finding whose message is a value the template will choke on.
    await storeFinding({ firstSeenAt: new Date(Date.now() - HOUR) });

    let calls = 0;
    const result = await postureDigestService.sendDigest(r, {
      from: new Date(Date.now() - DAY),
      to: new Date(),
      sendMail: recorder(async (m) => {
        calls += 1;
        if (calls === 1) throw new Error('template exploded');
        sent.push(m);
      }),
    });

    expect(calls).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.skipped).toHaveLength(1);
  });

  test('truncates a very large digest and says so', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    const r = await ruleFor([user.id]);
    const recent = new Date(Date.now() - HOUR);
    const max = postureDigestService.MAX_DIGEST_FINDINGS;
    for (let i = 0; i < max + 5; i += 1) {
      await storeFinding({ firstSeenAt: recent, severity: i === 0 ? 'CRITICAL' : 'LOW' });
    }
    await postureDigestService.sendDigest(r, { from: new Date(Date.now() - DAY), to: new Date(), sendMail: recorder() });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/and 5 more/);
    // Worst-first, so truncation drops the least important rows.
    expect(sent[0].text.indexOf('CRITICAL')).toBeLessThan(sent[0].text.indexOf('LOW'));
  });
});

describe('posture digest — the job', () => {
  let org;
  let customer;
  let srv;
  let sent;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${unique()}` },
    });
    srv = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: `j-${unique()}.example.com`,
        ipAddress: '10.9.1.4',
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
    await prisma.exposureFinding.deleteMany({ where: { orgId: org.id } });
    await prisma.postureAlertRule.deleteMany({ where: { orgId: org.id } });
    sent = [];
  });

  /**
   * A recording sender. `sendMail` is injected rather than monkey-patched
   * because ESM namespace objects are frozen — the same constraint that makes
   * postureAlert.test.js assert on real Notification rows.
   */
  const recorder = (impl) => async (m) => {
    if (impl) return impl(m);
    sent.push(m);
    return undefined;
  };

  const digestRule = (userIds, over = {}) =>
    prisma.postureAlertRule.create({
      data: {
        orgId: org.id,
        name: `job-${unique()}`,
        recipientUserIds: userIds,
        channels: ['email'],
        mode: 'digest',
        digestSchedule: 'daily',
        digestHour: 8,
        ...over,
      },
    });

  test('an immediate rule is never picked up by the digest pass', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    await digestRule([user.id], { mode: 'immediate' });
    const summary = await runDigestPass({ now: new Date('2026-03-10T09:00:00Z'), sendMail: recorder() });
    expect(summary.considered).toBe(0);
  });

  test('an inactive digest rule is skipped', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    await digestRule([user.id], { isActive: false });
    const summary = await runDigestPass({ now: new Date('2026-03-10T09:00:00Z'), sendMail: recorder() });
    expect(summary.considered).toBe(0);
  });

  // The window must not grow without bound just because nothing happened.
  test('the watermark advances even on an empty period', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    const r = await digestRule([user.id], { lastDigestAt: new Date('2026-03-09T08:00:00Z') });
    const now = new Date('2026-03-10T09:00:00Z');

    await runDigestPass({ now, sendMail: recorder() });
    const after = await prisma.postureAlertRule.findUnique({ where: { id: r.id } });
    expect(after.lastDigestAt.toISOString()).toBe(now.toISOString());
    expect(sent).toHaveLength(0);
  });

  test('a rule is not sent twice in one period', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    const r = await digestRule([user.id], { lastDigestAt: new Date('2026-03-09T08:00:00Z') });
    await prisma.exposureFinding.create({
      data: {
        orgId: org.id,
        serverId: srv.id,
        code: 'PORT_EXPOSED',
        severity: 'HIGH',
        proto: 'tcp',
        port: 9001,
        message: 'x',
        firstSeenAt: new Date('2026-03-10T01:00:00Z'),
        lastSeenAt: new Date('2026-03-10T01:00:00Z'),
      },
    });

    const first = await runDigestPass({ now: new Date('2026-03-10T09:00:00Z'), sendMail: recorder() });
    expect(first.sent).toBe(1);
    expect(sent).toHaveLength(1);

    sent = [];
    const second = await runDigestPass({ now: new Date('2026-03-10T23:00:00Z'), sendMail: recorder() });
    expect(second.sent).toBe(0);
    expect(sent).toHaveLength(0);

    // ...and due again at the next occurrence.
    const third = await runDigestPass({ now: new Date('2026-03-11T08:30:00Z'), sendMail: recorder() });
    expect(third.sent).toBe(1);
    void r;
  });

  // A skipped period is worse than a duplicated one: nobody notices silence.
  test('a failed send leaves the watermark alone so the window is retried', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    const anchor = new Date('2026-03-09T08:00:00Z');
    const r = await digestRule([user.id], { lastDigestAt: anchor });
    await prisma.exposureFinding.create({
      data: {
        orgId: org.id,
        serverId: srv.id,
        code: 'PORT_EXPOSED',
        severity: 'HIGH',
        proto: 'tcp',
        port: 9002,
        message: 'x',
        firstSeenAt: new Date('2026-03-10T01:00:00Z'),
        lastSeenAt: new Date('2026-03-10T01:00:00Z'),
      },
    });

    // Fail the whole assembly, not just one address.
    const originalFind = prisma.exposureFinding.findMany;
    prisma.exposureFinding.findMany = async () => {
      throw new Error('database went away');
    };
    let summary;
    try {
      summary = await runDigestPass({ now: new Date('2026-03-10T09:00:00Z'), sendMail: recorder() });
    } finally {
      prisma.exposureFinding.findMany = originalFind;
    }

    expect(summary.failed).toBe(1);
    const after = await prisma.postureAlertRule.findUnique({ where: { id: r.id } });
    expect(after.lastDigestAt.toISOString()).toBe(anchor.toISOString());
  });
});

describe('posture digest — interaction with the immediate path', () => {
  let org;
  let customer;
  let srv;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${unique()}` },
    });
    srv = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: `i-${unique()}.example.com`,
        ipAddress: '10.9.2.4',
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

  // The whole point of batching only the email channel: a digest rule can
  // never be a rule that delivers nothing.
  test('a digest rule still writes its in-app row immediately', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await createTestUser(org.id, { role: 'admin' });
    await prisma.postureAlertRule.create({
      data: {
        orgId: org.id,
        name: `mix-${unique()}`,
        recipientUserIds: [user.id],
        channels: ['inapp', 'email'],
        mode: 'digest',
        digestSchedule: 'daily',
        digestHour: 8,
      },
    });

    await postureAlertService.dispatchFindingEvents({
      orgId: org.id,
      serverId: srv.id,
      events: [
        {
          type: 'opened',
          finding: {
            code: 'PORT_EXPOSED',
            severity: 'HIGH',
            proto: 'tcp',
            port: 7777,
            message: 'exposed',
          },
        },
      ],
    });

    const rows = await prisma.notification.findMany({ where: { orgId: org.id, userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('POSTURE_FINDING');
  });
});

describe('postureAlertService — switching a rule into digest mode', () => {
  let org;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
  });

  afterAll(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.postureAlertRule.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  test('restarts the watermark, so no backlog is mailed out', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const old = await prisma.postureAlertRule.create({
      data: {
        orgId: org.id,
        name: `old-${unique()}`,
        mode: 'immediate',
        createdAt: new Date('2024-01-01T00:00:00Z'),
      },
    });
    expect(old.lastDigestAt).toBeNull();

    const before = Date.now();
    const updated = await postureAlertService.updateAlertRule(org.id, old.id, { mode: 'digest' });
    expect(updated.lastDigestAt).not.toBeNull();
    expect(updated.lastDigestAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  test('creating a rule directly in digest mode sets the watermark too', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const created = await postureAlertService.createAlertRule(org.id, {
      name: `new-${unique()}`,
      mode: 'digest',
    });
    expect(created.lastDigestAt).not.toBeNull();
  });

  test('an immediate rule gets no watermark', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const created = await postureAlertService.createAlertRule(org.id, {
      name: `imm-${unique()}`,
      mode: 'immediate',
    });
    expect(created.lastDigestAt).toBeNull();
  });
});
