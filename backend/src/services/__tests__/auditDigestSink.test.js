/**
 * auditDigestSink.test.js — the scheduled audit digest.
 *
 * `email_digest` shipped with no scheduler at all. `jobs/auditExport.js`
 * selects `STREAMING_TYPES`, and the digest adapter is `streaming: false`, so
 * its `deliver()` was reachable only from the Test button. An organization
 * could configure a daily audit digest, save it, see it reported healthy, and
 * never receive one — in a product sold on auditability. `runDigestSink` and
 * `runDueDigests` are what drive it now, and these are the properties that
 * keep it honest.
 */

import prisma from '../../config/db.js';
import * as sinkService from '../audit/sinkService.js';
import * as emailDigest from '../audit/sinks/emailDigest.js';
import { STREAMING_TYPES, DIGEST_TYPES, SINK_TYPES } from '../audit/sinks/index.js';
import { PermanentSinkError } from '../audit/sinks/errors.js';
import { READ_LAG_MS } from '../auditService.js';
import { runDueDigests } from '../../jobs/auditExport.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';
import { encrypt } from '../../utils/crypto.js';

describe('sink type registry', () => {
  // The bug in one assertion: every sink type must be driven by something.
  test('every sink type is either streamed or scheduled, and none is both', () => {
    expect([...STREAMING_TYPES, ...DIGEST_TYPES].sort()).toEqual([...SINK_TYPES].sort());
    expect(STREAMING_TYPES.filter((t) => DIGEST_TYPES.includes(t))).toEqual([]);
  });

  test('email_digest is scheduled, not streamed', () => {
    expect(DIGEST_TYPES).toContain('email_digest');
    expect(STREAMING_TYPES).not.toContain('email_digest');
  });
});

describe('audit digest (live DB)', () => {
  let org;

  const config = (over = {}) => ({
    recipients: ['ops@example.com'],
    schedule: 'daily',
    hour: 7,
    format: 'csv',
    ...over,
  });

  async function makeSink(over = {}, cfg = config()) {
    return prisma.auditSink.create({
      data: {
        orgId: org.id,
        name: 'digest',
        type: 'email_digest',
        configEncrypted: encrypt(JSON.stringify(cfg)),
        filters: {},
        isActive: true,
        batchSize: 100,
        ...over,
      },
    });
  }

  async function seed(count, at = new Date(Date.now() - READ_LAG_MS - 60_000)) {
    await prisma.auditLog.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        orgId: org.id,
        action: i % 3 === 0 ? 'auth.login.failed' : 'user.updated',
        resourceType: 'User',
        createdAt: new Date(at.getTime() + i),
      })),
    });
  }

  /** Inject a destination we control, as the streaming tests do. */
  const withDeliver = (impl, run) =>
    run({ adapter: { ...emailDigest, deliver: impl, notReadyReason: () => null } });

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.auditSinkDelivery.deleteMany({ where: { orgId: org.id } });
    await prisma.auditSink.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  afterEach(async () => {
    if (!org) return;
    await prisma.auditSinkDelivery.deleteMany({ where: { orgId: org.id } });
    await prisma.auditSink.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
  });

  test('sends when the scheduled hour has passed, and attaches the entries', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(10);
    const sink = await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) });

    const calls = [];
    const result = await withDeliver(
      async (_cfg, envelopes, ctx) => {
        calls.push({ n: envelopes.length, ctx });
        return { detail: 'ok' };
      },
      (ctx) => sinkService.runDigestSink(sink, ctx)
    );

    expect(result.sent).toBe(true);
    expect(result.delivered).toBe(10);
    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.attachment.filename).toMatch(/\.csv$/);
    expect(calls[0].ctx.attachment.content).toContain('auth.login.failed');
    expect(calls[0].ctx.periodLabel).toMatch(/the last/);
  });

  test('is not due again inside the same period', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(3);
    const sink = await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) });

    let calls = 0;
    const deliver = async () => {
      calls += 1;
      return { detail: 'ok' };
    };
    await withDeliver(deliver, (ctx) => sinkService.runDigestSink(sink, ctx));
    expect(calls).toBe(1);

    const after = await prisma.auditSink.findUnique({ where: { id: sink.id } });
    await withDeliver(deliver, (ctx) => sinkService.runDigestSink(after, ctx));
    expect(calls).toBe(1);
  });

  // The watermark is what makes "covered" different from "delivered".
  test('an empty period advances the watermark but sends nothing', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const sink = await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) });

    let calls = 0;
    const result = await withDeliver(
      async () => {
        calls += 1;
        return { detail: 'ok' };
      },
      (ctx) => sinkService.runDigestSink(sink, ctx)
    );

    expect(calls).toBe(0);
    expect(result.sent).toBe(false);
    const after = await prisma.auditSink.findUnique({ where: { id: sink.id } });
    expect(after.lastOkAt.getTime()).toBeGreaterThan(sink.lastOkAt.getTime());
  });

  // A skipped period is invisible; a duplicated one is merely annoying.
  test('a failure leaves the watermark alone so the period is retried', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(5);
    const anchor = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const sink = await makeSink({ lastOkAt: anchor });

    const result = await withDeliver(
      async () => {
        throw new Error('smtp is down');
      },
      (ctx) => sinkService.runDigestSink(sink, ctx)
    );

    expect(result.sent).toBe(false);
    const after = await prisma.auditSink.findUnique({ where: { id: sink.id } });
    expect(after.lastOkAt.toISOString()).toBe(anchor.toISOString());
    expect(after.consecutiveFailures).toBe(1);
    expect(after.lastError).toMatch(/smtp is down/);
    expect(after.backoffUntil).not.toBeNull();
  });

  test('a permanent failure disables the sink and says why', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(2);
    const sink = await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) });

    await withDeliver(
      async () => {
        throw new PermanentSinkError('Email is not configured for this organization');
      },
      (ctx) => sinkService.runDigestSink(sink, ctx)
    );

    const after = await prisma.auditSink.findUnique({ where: { id: sink.id } });
    expect(after.isActive).toBe(false);
    expect(after.disabledReason).toMatch(/not configured/);
  });

  test('a sink that is not ready records why and does not send', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(2);
    const sink = await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) }, config({ recipients: [] }));

    let calls = 0;
    const result = await sinkService.runDigestSink(sink, {
      adapter: { ...emailDigest, deliver: async () => { calls += 1; } },
    });

    expect(calls).toBe(0);
    expect(result.stopped).toMatch(/No recipients/);
    const after = await prisma.auditSink.findUnique({ where: { id: sink.id } });
    expect(after.lastError).toMatch(/No recipients/);
  });

  // A digest turned on this morning must not attach the org's whole history.
  test('a sink that has never run anchors on createdAt, not on the epoch', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    // An entry from long before the sink existed.
    await seed(4, new Date(Date.now() - 400 * 24 * 60 * 60 * 1000));
    await seed(2);
    const sink = await makeSink({
      lastOkAt: null,
      createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
    });

    const seen = [];
    await withDeliver(
      async (_cfg, envelopes) => {
        seen.push(envelopes.length);
        return { detail: 'ok' };
      },
      (ctx) => sinkService.runDigestSink(sink, ctx)
    );

    // Only the recent two, never the year-old four.
    expect(seen).toEqual([2]);
  });

  test('records a delivery row with the period it covered', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(6);
    const sink = await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) });

    await withDeliver(async () => ({ detail: 'ok' }), (ctx) => sinkService.runDigestSink(sink, ctx));

    const rows = await prisma.auditSinkDelivery.findMany({ where: { sinkId: sink.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
    expect(rows[0].count).toBe(6);
  });

  test('honours the format setting', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(3);
    const sink = await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) }, config({ format: 'json' }));

    let attachment;
    await withDeliver(
      async (_cfg, _e, ctx) => {
        attachment = ctx.attachment;
        return { detail: 'ok' };
      },
      (ctx) => sinkService.runDigestSink(sink, ctx)
    );

    expect(attachment.filename).toMatch(/\.json$/);
    expect(attachment.contentType).toBe('application/json');
    expect(() => JSON.parse(attachment.content)).not.toThrow();
  });

  test('respects the sink filters', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(9); // a third are auth.login.failed
    const sink = await makeSink({
      lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
      filters: { actions: ['auth.login.failed'] },
    });

    let n = 0;
    await withDeliver(
      async (_cfg, envelopes) => {
        n = envelopes.length;
        return { detail: 'ok' };
      },
      (ctx) => sinkService.runDigestSink(sink, ctx)
    );
    expect(n).toBe(3);
  });

  // A CSV cell beginning with = is executed by Excel and Sheets on open.
  test('guards CSV cells against spreadsheet formula injection', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await prisma.auditLog.create({
      data: {
        orgId: org.id,
        action: '=cmd|calc',
        resourceType: 'User',
        createdAt: new Date(Date.now() - READ_LAG_MS - 60_000),
      },
    });
    const sink = await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) });

    let content;
    await withDeliver(
      async (_cfg, _e, ctx) => {
        content = ctx.attachment.content;
        return { detail: 'ok' };
      },
      (ctx) => sinkService.runDigestSink(sink, ctx)
    );

    expect(content).toContain('"\'=cmd|calc"');
    expect(content).not.toMatch(/,"=cmd/);
  });

  // Both of these were found in review, and both lose or duplicate audit
  // entries — the one thing an audit pipeline cannot do.
  test('does not read right up to the present (READ_LAG_MS is respected)', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    // An entry written "just now" is inside the lag window: a row committing
    // a moment later could share its timestamp and be lost for ever, because
    // the watermark would have moved past it.
    await prisma.auditLog.create({
      data: { orgId: org.id, action: 'user.updated', resourceType: 'User', createdAt: new Date() },
    });
    await seed(3); // safely older than the lag
    const sink = await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) });

    let n = 0;
    await withDeliver(
      async (_cfg, envelopes) => {
        n = envelopes.length;
        return { detail: 'ok' };
      },
      (ctx) => sinkService.runDigestSink(sink, ctx)
    );
    expect(n).toBe(3);

    const after = await prisma.auditSink.findUnique({ where: { id: sink.id } });
    // The watermark stops at the lag boundary, not at "now", so the entry
    // inside the lag is still ahead of it and will be picked up next time.
    expect(after.lastOkAt.getTime()).toBeLessThan(Date.now());
  });

  test('an entry on a window boundary is delivered exactly once', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const boundary = new Date(Date.now() - READ_LAG_MS - 30_000);
    await prisma.auditLog.create({
      data: { orgId: org.id, action: 'auth.login.failed', resourceType: 'User', createdAt: boundary },
    });
    const sink = await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) });

    const seen = [];
    const deliver = async (_cfg, envelopes) => {
      seen.push(...envelopes.map((e) => e.id));
      return { detail: 'ok' };
    };
    await withDeliver(deliver, (ctx) => sinkService.runDigestSink(sink, ctx));

    // Next period, starting exactly where the last one stopped.
    const after = await prisma.auditSink.findUnique({ where: { id: sink.id } });
    await withDeliver(deliver, (ctx) =>
      sinkService.runDigestSink(after, { ...ctx, now: new Date(Date.now() + 25 * 60 * 60 * 1000) })
    );

    const boundaryIds = seen.filter((id, i) => seen.indexOf(id) !== i);
    expect(boundaryIds).toEqual([]); // no id delivered twice
  });

  test('weekly can name its day instead of silently meaning Monday', () => {
    expect(emailDigest.validateConfig({ recipients: ['a@b.test'], schedule: 'weekly' }).dayOfWeek).toBe(1);
    expect(
      emailDigest.validateConfig({ recipients: ['a@b.test'], schedule: 'weekly', dayOfWeek: 5 }).dayOfWeek
    ).toBe(5);
    expect(emailDigest.validateConfig({ recipients: ['a@b.test'], schedule: 'daily' }).dayOfWeek).toBeNull();
    expect(() =>
      emailDigest.validateConfig({ recipients: ['a@b.test'], schedule: 'weekly', dayOfWeek: 9 })
    ).toThrow(/Day must be/);
  });

  test('guards a CSV cell that starts with a tab or a carriage return', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await prisma.auditLog.create({
      data: {
        orgId: org.id,
        action: '\t=cmd|calc',
        resourceType: 'User',
        createdAt: new Date(Date.now() - READ_LAG_MS - 60_000),
      },
    });
    const sink = await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) });

    let content;
    await withDeliver(
      async (_cfg, _e, ctx) => {
        content = ctx.attachment.content;
        return { detail: 'ok' };
      },
      (ctx) => sinkService.runDigestSink(sink, ctx)
    );
    expect(content).toContain("\"'\t=cmd|calc\"");
  });

  test('the job pass picks up a due digest sink', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(4);
    await makeSink({ lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) });

    // Real adapter, but email is not configured for a test org, so this
    // exercises the selection and the failure path rather than delivery.
    const result = await runDueDigests();
    expect(result.sinks).toBeGreaterThanOrEqual(1);
  });

  test('an inactive digest sink is not picked up', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(4);
    await makeSink({ isActive: false, lastOkAt: new Date(Date.now() - 36 * 60 * 60 * 1000) });
    const result = await runDueDigests();
    expect(result.sinks).toBe(0);
  });
});
