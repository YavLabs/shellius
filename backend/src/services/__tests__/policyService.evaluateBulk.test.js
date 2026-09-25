/**
 * policyService.evaluateBulk — the batched sibling of evaluate().
 *
 * This function decides what a list of servers is LABELLED as: connect
 * directly, request approval, or no access. A wrong label is not merely
 * cosmetic — it tells someone whether to expect a review before they can work,
 * and a row painted "direct" that the API then refuses is a support ticket
 * every time.
 *
 * So the central test here is not "does it return sensible values" but
 * **"does it agree with evaluate(), server for server"**. evaluate() is the
 * enforced path; anything evaluateBulk says that differs from it is a bug by
 * definition, whichever one looks more reasonable in isolation.
 *
 * Live-DB integration test (dbReachable() skip pattern), because
 * jest.unstable_mockModule is broken in this Jest + Node ESM combination.
 */

import prisma from '../../config/db.js';
import { evaluate, evaluateBulk } from '../policyService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

describe('policyService.evaluateBulk', () => {
  let reachable;
  let org;
  let customer;
  let otherCustomer;
  let member;
  let servers = {};

  const mkServer = (hostname, environment, extra = {}) =>
    prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname,
        ipAddress: `10.9.9.${Math.floor(Math.random() * 200) + 1}`,
        environment,
        protocol: 'ssh',
        ...extra,
      },
    });

  const mkPolicy = (name, data) =>
    prisma.accessPolicy.create({
      data: {
        orgId: org.id,
        name,
        effect: 'ALLOW',
        targetEnvironments: [],
        allowedPrincipals: [],
        maxSessionDuration: 3600,
        autoApprove: false,
        requireApproval: false,
        priority: 50,
        ...data,
        subjects: { create: [{ subjectType: 'ROLE', subjectId: 'member' }] },
      },
    });

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] policyService.evaluateBulk: no live DB');
      return;
    }
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Bulk Co', slug: `bulk-${Date.now()}` },
    });
    otherCustomer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Other Co', slug: `bulk-other-${Date.now()}` },
    });
    member = await createTestUser(org.id, { role: 'member' });

    servers = {
      // Covered by the org-wide dev ALLOW below.
      dev: await mkServer('bulk-dev.internal', 'dev'),
      // Same, but the policy demands approval.
      staging: await mkServer('bulk-staging.internal', 'staging'),
      // Prod: the hard rule applies whatever the policy says.
      prod: await mkServer('bulk-prod.internal', 'prod'),
      // Explicitly denied.
      denied: await mkServer('bulk-denied.internal', 'dev'),
      // Belongs to a customer no policy scopes to → no matching policy.
      unmatched: await mkServer('bulk-unmatched.internal', 'dev', { customerId: otherCustomer.id }),
      // Label-targeted policy does not match this one.
      unlabelled: await mkServer('bulk-unlabelled.internal', 'demo'),
    };

    await mkPolicy('Dev allow', { targetEnvironments: ['dev'], customerId: customer.id });
    await mkPolicy('Staging allow with approval', {
      targetEnvironments: ['staging'],
      customerId: customer.id,
      requireApproval: true,
    });
    await mkPolicy('Prod allow auto', {
      targetEnvironments: ['prod'],
      customerId: customer.id,
      autoApprove: true,
    });
    await mkPolicy('Deny that one box', {
      effect: 'DENY',
      targetServerIds: [servers.denied.id],
      customerId: customer.id,
      priority: 1,
    });
  });

  afterAll(async () => {
    if (!reachable || !org) return;
    await prisma.policySubject.deleteMany({ where: { policy: { orgId: org.id } } });
    await prisma.accessPolicy.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const maybeTest = (name, fn) =>
    test(name, async () => {
      if (!reachable) return;
      await fn();
    });

  // ── the test that matters ────────────────────────────────────────────────

  maybeTest('agrees with evaluate() on every server, one by one', async () => {
    const ids = Object.values(servers).map((s) => s.id);
    const bulk = await evaluateBulk({ orgId: org.id, userId: member.id, serverIds: ids });

    for (const [label, server] of Object.entries(servers)) {
      const single = await evaluate({ orgId: org.id, userId: member.id, serverId: server.id });
      const b = bulk[server.id];
      expect(b).toBeDefined();
      expect({ server: label, allowed: b.allowed, requiresApproval: b.requiresApproval }).toEqual({
        server: label,
        allowed: single.allowed,
        requiresApproval: single.requiresApproval,
      });
      // When a policy decided it, both must name the SAME policy — agreeing on
      // the verdict for different reasons would diverge the moment one changes.
      if (single.policyId) expect(b.policyId).toBe(single.policyId);
    }
  });

  // ── the specific verdicts, stated outright ───────────────────────────────

  maybeTest('a matching ALLOW on a non-prod server is direct access', async () => {
    const r = await evaluateBulk({ orgId: org.id, userId: member.id, serverIds: [servers.dev.id] });
    expect(r[servers.dev.id]).toMatchObject({ allowed: true, requiresApproval: false, isProduction: false });
  });

  maybeTest("a policy's own requireApproval is honoured off prod", async () => {
    const r = await evaluateBulk({ orgId: org.id, userId: member.id, serverIds: [servers.staging.id] });
    expect(r[servers.staging.id]).toMatchObject({ allowed: true, requiresApproval: true });
  });

  // The whole reason T3 was a bug: these three all looked like "direct" to the
  // CLI, because it only ever asked whether the environment was prod.
  maybeTest('a DENY policy is not access, and outranks the ALLOW that also matches', async () => {
    const r = await evaluateBulk({ orgId: org.id, userId: member.id, serverIds: [servers.denied.id] });
    expect(r[servers.denied.id]).toMatchObject({ allowed: false, requiresApproval: false });
    expect(r[servers.denied.id].reason).toMatch(/Denied by policy/);
  });

  maybeTest('a server no policy matches is not access', async () => {
    const r = await evaluateBulk({ orgId: org.id, userId: member.id, serverIds: [servers.unmatched.id] });
    expect(r[servers.unmatched.id]).toMatchObject({ allowed: false, reason: 'No matching policy' });
  });

  maybeTest('prod requires approval even when the matched policy auto-approves', async () => {
    const r = await evaluateBulk({ orgId: org.id, userId: member.id, serverIds: [servers.prod.id] });
    expect(r[servers.prod.id]).toMatchObject({
      allowed: true,
      requiresApproval: true,
      isProduction: true,
    });
  });

  // ── inputs that must not blow up a list render ───────────────────────────

  maybeTest('an empty list is an empty map and costs nothing', async () => {
    await expect(evaluateBulk({ orgId: org.id, userId: member.id, serverIds: [] })).resolves.toEqual({});
    await expect(evaluateBulk({ orgId: org.id, userId: member.id, serverIds: null })).resolves.toEqual({});
  });

  maybeTest('unknown ids are absent rather than fabricated', async () => {
    const r = await evaluateBulk({
      orgId: org.id,
      userId: member.id,
      serverIds: [servers.dev.id, 'does-not-exist'],
    });
    expect(r[servers.dev.id]).toBeDefined();
    expect(r['does-not-exist']).toBeUndefined();
  });

  maybeTest('duplicate ids are answered once', async () => {
    const r = await evaluateBulk({
      orgId: org.id,
      userId: member.id,
      serverIds: [servers.dev.id, servers.dev.id, servers.dev.id],
    });
    expect(Object.keys(r)).toEqual([servers.dev.id]);
  });

  // A server in another org must never be evaluated, let alone leak its
  // existence back to the caller through a populated map entry.
  maybeTest("a server from another org is not evaluated", async () => {
    const otherOrg = await createTestOrg();
    try {
      const otherCust = await prisma.customer.create({
        data: { orgId: otherOrg.id, name: 'Foreign', slug: `foreign-${Date.now()}` },
      });
      const foreign = await prisma.server.create({
        data: {
          orgId: otherOrg.id,
          customerId: otherCust.id,
          hostname: 'foreign.internal',
          ipAddress: '10.8.8.8',
          environment: 'dev',
          protocol: 'ssh',
        },
      });
      const r = await evaluateBulk({
        orgId: org.id,
        userId: member.id,
        serverIds: [servers.dev.id, foreign.id],
      });
      expect(r[foreign.id]).toBeUndefined();
      expect(r[servers.dev.id]).toBeDefined();

      await prisma.server.deleteMany({ where: { orgId: otherOrg.id } });
      await prisma.customer.deleteMany({ where: { orgId: otherOrg.id } });
    } finally {
      await cleanupOrg(otherOrg.id);
    }
  });

  maybeTest('rejects a call with no org or no user rather than answering broadly', async () => {
    await expect(evaluateBulk({ userId: member.id, serverIds: [servers.dev.id] })).rejects.toThrow();
    await expect(evaluateBulk({ orgId: org.id, serverIds: [servers.dev.id] })).rejects.toThrow();
  });
});
