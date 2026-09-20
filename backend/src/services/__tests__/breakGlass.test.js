/**
 * Break-glass emergency access — step-up-verified two-step flow
 * (startBreakGlass / verifyBreakGlass, accessRequestService.js).
 *
 * Covers: AccessPolicy.isBreakGlass actually gating who may reach which
 * server (policyService.findBreakGlassPolicy), step-up verification reusing
 * mfaService end to end (TOTP + email OTP, including fail-closed delivery),
 * the Redis challenge (single-use, 5-attempt limit, expiry), the org
 * prod-bypass switch still winning over break-glass, one-active-session-per-
 * server, duration clamped to the matched policy's ceiling, and the retired
 * single-step endpoint refusing outright.
 *
 * Live-DB/Redis integration tests — auto-skip (console.warn) when either is
 * unreachable, matching the dbReachable() pattern used across this repo
 * (ESM module mocking is unreliable under this Jest/Node combination).
 */

import { jest } from '@jest/globals';
import { authenticator } from 'otplib';
import prisma from '../../config/db.js';
import redis from '../../config/redis.js';
import * as accessRequestService from '../accessRequestService.js';
import * as mfaService from '../mfaService.js';
import * as emailProviderService from '../emailProviderService.js';
import { updateAccessSettings } from '../orgService.js';
import { permissionsForUser, getSystemRole } from '../roleService.js';
import { UNSCOPED } from '../../lib/scope.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

async function redisReachable() {
  try {
    await Promise.race([redis.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
    return true;
  } catch {
    return false;
  }
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body ?? {}) };
}

let seq = 0;
function uniqueSuffix() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}`;
}

describe('break-glass (live DB/Redis)', () => {
  let reachable;
  let org;
  let customer;
  const realFetch = global.fetch;

  beforeAll(async () => {
    reachable = (await dbReachable()) && (await redisReachable());
    if (!reachable) {
      console.warn('[skip] break-glass tests — DATABASE_URL/REDIS unreachable');
      return;
    }
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: 'Break-glass Co', slug: `break-glass-${uniqueSuffix()}` },
    });
    await updateAccessSettings(org.id, { prodBypassEnabled: true });
  });

  afterAll(async () => {
    global.fetch = realFetch;
    if (!reachable || !org) return;
    await prisma.notification.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
    await prisma.accessRequest.deleteMany({ where: { orgId: org.id } });
    await prisma.policySubject.deleteMany({ where: { policy: { orgId: org.id } } });
    await prisma.accessPolicy.deleteMany({ where: { orgId: org.id } });
    await prisma.emailProvider.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
    redis.disconnect();
  });

  // -- helpers ----------------------------------------------------------

  async function makeAdmin(overrides = {}) {
    const user = await createTestUser(org.id, { role: 'admin', ...overrides });
    // usersWithPermission() (the notify-on-grant fan-out) looks up admins by
    // Role.roleId, not the legacy `role` tier string — link it so the
    // notification assertions below reflect real routing.
    const adminRole = await getSystemRole(org.id, 'admin');
    return prisma.user.update({ where: { id: user.id }, data: { roleId: adminRole.id } });
  }

  function permsFor(user) {
    return new Set(permissionsForUser(user));
  }

  async function makeProdServer(name) {
    return prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customer.id,
        hostname: `${name}-${uniqueSuffix()}.internal`,
        ipAddress: '10.9.9.9',
        environment: 'prod',
        protocol: 'ssh',
        provisionStatus: 'provisioned',
      },
    });
  }

  // Scoped to a single server (targetServerIds: [server.id]) rather than
  // "all prod servers" — tests share one org, so an env-wide policy would
  // leak across test cases and make findBreakGlassPolicy's pick (lowest
  // priority, ties broken by DB order) nondeterministic.
  async function makeBreakGlassPolicy(server, { maxSessionDuration = 1800 } = {}) {
    return prisma.accessPolicy.create({
      data: {
        orgId: org.id,
        name: `Break-glass test policy ${uniqueSuffix()}`,
        effect: 'ALLOW',
        targetEnvironments: ['prod'],
        targetServerIds: [server.id],
        allowedPrincipals: [],
        maxSessionDuration,
        requireApproval: false,
        autoApprove: true,
        isBreakGlass: true,
        priority: 10,
        subjects: { create: [{ subjectType: 'ROLE', subjectId: 'admin' }] },
      },
    });
  }

  async function enrollTotp(user) {
    const enroll = await mfaService.beginTotpEnroll(user);
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    await mfaService.confirmTotpEnroll(fresh, authenticator.generate(enroll.secret));
    return { secret: enroll.secret, user: await prisma.user.findUnique({ where: { id: user.id } }) };
  }

  async function makeResendProvider() {
    return emailProviderService.create(
      org.id,
      { name: 'BG Resend', type: 'resend', fromAddress: 'noreply@example.com', config: { apiKey: 'k' }, isActive: true },
      {}
    );
  }

  /** Reads the OTP code out of the mocked outbound email (never guessed). */
  function extractCodeFromFetchMock(fetchMock) {
    const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(call[1].body);
    const match = /verification code: (\d{6})/.exec(body.subject) || /verification code is (\d{6})/.exec(body.text);
    if (!match) throw new Error('no OTP code found in mocked email');
    return match[1];
  }

  const maybeTest = (name, fn, timeout) =>
    test(
      name,
      async () => {
        if (!reachable) return;
        await fn();
      },
      timeout
    );

  // -- no matching break-glass policy ------------------------------------

  maybeTest('start refuses when no isBreakGlass ALLOW policy names this user for the server', async () => {
    const admin = await makeAdmin();
    const server = await makeProdServer('no-policy');
    await expect(
      accessRequestService.startBreakGlass({
        orgId: org.id,
        invokerId: admin.id,
        invokerPermissions: permsFor(admin),
        serverId: server.id,
        reason: 'Investigating a critical outage on this box right now.',
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'BREAK_GLASS_NOT_AUTHORIZED' });
  });

  // -- server out of scope -----------------------------------------------

  maybeTest('start refuses (404) when the server is out of the caller\'s customer scope', async () => {
    const admin = await makeAdmin();
    const server = await makeProdServer('scoped-out');
    await makeBreakGlassPolicy(server);
    await expect(
      accessRequestService.startBreakGlass({
        orgId: org.id,
        invokerId: admin.id,
        invokerPermissions: permsFor(admin),
        serverId: server.id,
        reason: 'Investigating a critical outage on this box right now.',
        scope: { mode: 'customers', customerIds: [] }, // scoped, but no customers granted
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // -- reason too short ----------------------------------------------------

  maybeTest('start refuses a reason under 20 characters', async () => {
    const admin = await makeAdmin();
    const server = await makeProdServer('short-reason');
    await makeBreakGlassPolicy(server);
    await expect(
      accessRequestService.startBreakGlass({
        orgId: org.id,
        invokerId: admin.id,
        invokerPermissions: permsFor(admin),
        serverId: server.id,
        reason: 'too short',
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // -- org prod-bypass switch OFF wins, even for break-glass --------------

  maybeTest('org prod-bypass switch OFF blocks break-glass at start, even with a matching policy', async () => {
    const admin = await makeAdmin();
    const server = await makeProdServer('bypass-off-start');
    await makeBreakGlassPolicy(server);
    await updateAccessSettings(org.id, { prodBypassEnabled: false });
    try {
      await expect(
        accessRequestService.startBreakGlass({
          orgId: org.id,
          invokerId: admin.id,
          invokerPermissions: permsFor(admin),
          serverId: server.id,
          reason: 'Investigating a critical outage on this box right now.',
        })
      ).rejects.toMatchObject({ statusCode: 403, code: 'BREAK_GLASS_PROD_BYPASS_DISABLED' });
    } finally {
      await updateAccessSettings(org.id, { prodBypassEnabled: true });
    }
  });

  maybeTest('org prod-bypass switch flipped OFF between start and verify still blocks the grant', async () => {
    const admin = await enrollTotp(await makeAdmin()).then((r) => r.user);
    const server = await makeProdServer('bypass-off-verify');
    await makeBreakGlassPolicy(server);

    const challenge = await accessRequestService.startBreakGlass({
      orgId: org.id,
      invokerId: admin.id,
      invokerPermissions: permsFor(admin),
      serverId: server.id,
      reason: 'Investigating a critical outage on this box right now.',
      method: 'totp',
    });

    await updateAccessSettings(org.id, { prodBypassEnabled: false });
    try {
      await expect(
        accessRequestService.verifyBreakGlass({
          orgId: org.id,
          invokerId: admin.id,
          invokerPermissions: permsFor(admin),
          challengeId: challenge.challengeId,
          code: '000000',
        })
      ).rejects.toMatchObject({ statusCode: 403, code: 'BREAK_GLASS_PROD_BYPASS_DISABLED' });

      // Challenge is burned — even flipping the switch back on can't resurrect it.
      await updateAccessSettings(org.id, { prodBypassEnabled: true });
      await expect(
        accessRequestService.verifyBreakGlass({
          orgId: org.id,
          invokerId: admin.id,
          invokerPermissions: permsFor(admin),
          challengeId: challenge.challengeId,
          code: '000000',
        })
      ).rejects.toMatchObject({ statusCode: 401, code: 'BREAK_GLASS_CHALLENGE_EXPIRED' });

      const failedAudit = await prisma.auditLog.findFirst({
        where: { orgId: org.id, action: 'access_request.break_glass.verify_failed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(failedAudit).not.toBeNull();
      expect(failedAudit.metadata).toMatchObject({ failureReason: 'org_prod_bypass_disabled' });
    } finally {
      await updateAccessSettings(org.id, { prodBypassEnabled: true });
    }
  });

  // -- happy path: TOTP ------------------------------------------------------

  maybeTest('full TOTP flow: start -> verify grants an APPROVED breakGlass AccessRequest, audited + notified', async () => {
    const raw = await makeAdmin();
    const { secret, user } = await enrollTotp(raw);
    const server = await makeProdServer('totp-happy');
    const policy = await makeBreakGlassPolicy(server, { maxSessionDuration: 1800 });

    const challenge = await accessRequestService.startBreakGlass({
      orgId: org.id,
      invokerId: user.id,
      invokerPermissions: permsFor(user),
      serverId: server.id,
      reason: 'Prod app is down for all customers, need immediate access.',
      ip: '203.0.113.5',
      userAgent: 'jest-test-agent',
    });
    expect(challenge).toMatchObject({ method: 'totp', expiresIn: 300 });
    expect(challenge.challengeId).toEqual(expect.any(String));
    expect(challenge.emailHint).toBeUndefined();

    const redisKey = `breakglass:challenge:${challenge.challengeId}`;
    expect(await redis.get(redisKey)).not.toBeNull();
    const ttl = await redis.ttl(redisKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);

    const startedAudit = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'access_request.break_glass.started' },
      orderBy: { createdAt: 'desc' },
    });
    expect(startedAudit).not.toBeNull();
    expect(startedAudit.metadata).toMatchObject({ serverId: server.id, policyId: policy.id, method: 'totp' });

    const ar = await accessRequestService.verifyBreakGlass({
      orgId: org.id,
      invokerId: user.id,
      invokerPermissions: permsFor(user),
      challengeId: challenge.challengeId,
      code: authenticator.generate(secret),
      ip: '203.0.113.5',
      userAgent: 'jest-test-agent',
    });

    expect(ar.status).toBe('APPROVED');
    expect(ar.breakGlass).toBe(true);
    expect(ar.serverId).toBe(server.id);
    expect(ar.requestedDuration).toBe(1800);
    expect(ar.approvedDuration).toBe(1800);

    // Challenge burned on success — single-use.
    expect(await redis.get(redisKey)).toBeNull();

    const grantedAudit = await prisma.auditLog.findFirst({
      where: { orgId: org.id, resourceId: ar.id, action: 'access_request.break_glass.granted' },
    });
    expect(grantedAudit).not.toBeNull();
    expect(grantedAudit.metadata).toMatchObject({ policyId: policy.id, method: 'totp', severity: 'HIGH' });

    const notif = await prisma.notification.findFirst({
      where: { orgId: org.id, type: 'BREAK_GLASS_INVOKED', 'metadata': { path: ['accessRequestId'], equals: ar.id } },
    });
    expect(notif).not.toBeNull();
    expect(notif.metadata).toMatchObject({ method: 'totp' });
  }, 15000);

  // -- challenge reused -----------------------------------------------------

  maybeTest('a burned/used challenge cannot be replayed', async () => {
    const { secret, user } = await enrollTotp(await makeAdmin());
    const server = await makeProdServer('replay');
    await makeBreakGlassPolicy(server);

    const challenge = await accessRequestService.startBreakGlass({
      orgId: org.id,
      invokerId: user.id,
      invokerPermissions: permsFor(user),
      serverId: server.id,
      reason: 'Need to roll back a bad deploy on this host immediately.',
    });
    const code = authenticator.generate(secret);
    await accessRequestService.verifyBreakGlass({
      orgId: org.id,
      invokerId: user.id,
      invokerPermissions: permsFor(user),
      challengeId: challenge.challengeId,
      code,
    });

    await expect(
      accessRequestService.verifyBreakGlass({
        orgId: org.id,
        invokerId: user.id,
        invokerPermissions: permsFor(user),
        challengeId: challenge.challengeId,
        code,
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'BREAK_GLASS_CHALLENGE_EXPIRED' });
  }, 15000);

  // -- challenge expired ------------------------------------------------------

  maybeTest('an expired challenge is refused', async () => {
    const { user } = await enrollTotp(await makeAdmin());
    const server = await makeProdServer('expired');
    await makeBreakGlassPolicy(server);

    const challenge = await accessRequestService.startBreakGlass({
      orgId: org.id,
      invokerId: user.id,
      invokerPermissions: permsFor(user),
      serverId: server.id,
      reason: 'Simulating an expired break-glass verification challenge.',
    });
    // Simulate TTL expiry instead of waiting 5 real minutes.
    await redis.del(`breakglass:challenge:${challenge.challengeId}`);

    await expect(
      accessRequestService.verifyBreakGlass({
        orgId: org.id,
        invokerId: user.id,
        invokerPermissions: permsFor(user),
        challengeId: challenge.challengeId,
        code: '123456',
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'BREAK_GLASS_CHALLENGE_EXPIRED' });
  });

  // -- wrong code 5x ------------------------------------------------------

  maybeTest('wrong code 5x burns the challenge; a 6th attempt (even correct) is refused', async () => {
    const { secret, user } = await enrollTotp(await makeAdmin());
    const server = await makeProdServer('wrong-code');
    await makeBreakGlassPolicy(server);

    const challenge = await accessRequestService.startBreakGlass({
      orgId: org.id,
      invokerId: user.id,
      invokerPermissions: permsFor(user),
      serverId: server.id,
      reason: 'Testing the wrong-code attempt limiter end to end.',
    });

    for (let i = 0; i < 4; i++) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        accessRequestService.verifyBreakGlass({
          orgId: org.id,
          invokerId: user.id,
          invokerPermissions: permsFor(user),
          challengeId: challenge.challengeId,
          code: '000000',
        })
      ).rejects.toMatchObject({ statusCode: 401, code: 'BREAK_GLASS_INVALID_CODE' });
    }

    // 5th wrong attempt burns it.
    await expect(
      accessRequestService.verifyBreakGlass({
        orgId: org.id,
        invokerId: user.id,
        invokerPermissions: permsFor(user),
        challengeId: challenge.challengeId,
        code: '000000',
      })
    ).rejects.toMatchObject({ statusCode: 429, code: 'BREAK_GLASS_TOO_MANY_ATTEMPTS' });

    // Even the correct code no longer works — the challenge is gone.
    await expect(
      accessRequestService.verifyBreakGlass({
        orgId: org.id,
        invokerId: user.id,
        invokerPermissions: permsFor(user),
        challengeId: challenge.challengeId,
        code: authenticator.generate(secret),
      })
    ).rejects.toMatchObject({ statusCode: 401, code: 'BREAK_GLASS_CHALLENGE_EXPIRED' });
  }, 20000);

  // -- email fallback chosen among multiple enrolled methods -----------------

  maybeTest('user with TOTP + email enrolled can choose the email fallback', async () => {
    const { user: totpUser } = await enrollTotp(await makeAdmin());
    const user = await prisma.user.update({ where: { id: totpUser.id }, data: { mfaEmailEnabled: true } });
    const server = await makeProdServer('email-fallback');
    await makeBreakGlassPolicy(server);
    await makeResendProvider();

    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { id: 'email-1' }));
    global.fetch = fetchMock;
    try {
      const challenge = await accessRequestService.startBreakGlass({
        orgId: org.id,
        invokerId: user.id,
        invokerPermissions: permsFor(user),
        serverId: server.id,
        reason: 'Choosing the email fallback even though TOTP is enrolled.',
        method: 'email',
      });
      expect(challenge.method).toBe('email');
      expect(challenge.emailHint).toMatch(/\*\*\*@/);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const code = extractCodeFromFetchMock(fetchMock);
      const ar = await accessRequestService.verifyBreakGlass({
        orgId: org.id,
        invokerId: user.id,
        invokerPermissions: permsFor(user),
        challengeId: challenge.challengeId,
        code,
      });
      expect(ar.status).toBe('APPROVED');
      expect(ar.breakGlass).toBe(true);
    } finally {
      global.fetch = realFetch;
    }
  }, 15000);

  // -- email delivery not configured: fail closed -----------------------------

  maybeTest('email method fails closed when delivery is not configured — no challenge, no grant', async () => {
    const admin = await makeAdmin();
    const user = await prisma.user.update({ where: { id: admin.id }, data: { mfaEmailEnabled: true } });
    const server = await makeProdServer('email-not-configured');
    await makeBreakGlassPolicy(server);
    // No EmailProvider row, no SMTP_HOST env — mailer falls back to log-only mode.

    await expect(
      accessRequestService.startBreakGlass({
        orgId: org.id,
        invokerId: user.id,
        invokerPermissions: permsFor(user),
        serverId: server.id,
        reason: 'This must fail closed — no working mail transport is configured.',
        method: 'email',
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'EMAIL_NOT_DELIVERED' });

    // Nothing was granted or left pending.
    const ar = await prisma.accessRequest.findFirst({ where: { orgId: org.id, serverId: server.id } });
    expect(ar).toBeNull();
    const startedAudit = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'access_request.break_glass.started', metadata: { path: ['serverId'], equals: server.id } },
    });
    expect(startedAudit).toBeNull();
  });

  // -- second break-glass while one already active for the same server -------

  maybeTest('a second break-glass cannot start while one is already active on the same server', async () => {
    const { secret, user } = await enrollTotp(await makeAdmin());
    const server = await makeProdServer('already-active');
    await makeBreakGlassPolicy(server, { maxSessionDuration: 1800 });

    const first = await accessRequestService.startBreakGlass({
      orgId: org.id,
      invokerId: user.id,
      invokerPermissions: permsFor(user),
      serverId: server.id,
      reason: 'First emergency access grant on this server.',
    });
    await accessRequestService.verifyBreakGlass({
      orgId: org.id,
      invokerId: user.id,
      invokerPermissions: permsFor(user),
      challengeId: first.challengeId,
      code: authenticator.generate(secret),
    });

    await expect(
      accessRequestService.startBreakGlass({
        orgId: org.id,
        invokerId: user.id,
        invokerPermissions: permsFor(user),
        serverId: server.id,
        reason: 'Second attempt while the first grant is still active.',
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'BREAK_GLASS_ALREADY_ACTIVE' });
  }, 15000);

  // -- duration exceeding the policy ceiling ----------------------------------

  maybeTest('a requested duration above the policy ceiling is clamped down to it', async () => {
    const { secret, user } = await enrollTotp(await makeAdmin());
    const server = await makeProdServer('duration-ceiling');
    const policy = await makeBreakGlassPolicy(server, { maxSessionDuration: 900 }); // 15 min ceiling

    const challenge = await accessRequestService.startBreakGlass({
      orgId: org.id,
      invokerId: user.id,
      invokerPermissions: permsFor(user),
      serverId: server.id,
      reason: 'Requesting far more time than the policy ceiling allows.',
      durationSeconds: 24 * 3600, // way above the 900s ceiling
    });

    const ar = await accessRequestService.verifyBreakGlass({
      orgId: org.id,
      invokerId: user.id,
      invokerPermissions: permsFor(user),
      challengeId: challenge.challengeId,
      code: authenticator.generate(secret),
    });

    expect(ar.requestedDuration).toBe(policy.maxSessionDuration);
    expect(ar.approvedDuration).toBe(policy.maxSessionDuration);
  }, 15000);

  // -- retired single-step endpoint -------------------------------------------

  maybeTest('the retired single-step endpoint always refuses with 410, regardless of input', async () => {
    await expect(accessRequestService.createBreakGlass()).rejects.toMatchObject({
      statusCode: 410,
      code: 'BREAK_GLASS_ENDPOINT_RETIRED',
    });
    await expect(
      accessRequestService.createBreakGlass({
        orgId: org.id,
        invokerId: 'whatever',
        invokerPermissions: new Set(['access.break_glass']),
        serverId: 'whatever',
        reason: 'x'.repeat(30),
      })
    ).rejects.toMatchObject({ statusCode: 410, code: 'BREAK_GLASS_ENDPOINT_RETIRED' });
  });
});
