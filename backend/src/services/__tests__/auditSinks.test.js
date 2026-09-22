/**
 * Audit sinks: adapter rules, and the delivery loop's guarantees.
 *
 * The invariant under test throughout: the cursor advances only after an
 * adapter returns. A failure must replay the batch, never skip it — losing
 * an audit entry silently is the one outcome this feature cannot have.
 */

import crypto from 'crypto';
import prisma from '../../config/db.js';
import * as sinkService from '../audit/sinkService.js';
import * as webhook from '../audit/sinks/webhook.js';
import * as syslog from '../audit/sinks/syslog.js';
import * as s3 from '../audit/sinks/s3.js';
import * as emailDigest from '../audit/sinks/emailDigest.js';
import { getAdapter, STREAMING_TYPES, SINK_TYPES } from '../audit/sinks/index.js';
import { RetryableSinkError, PermanentSinkError } from '../audit/sinks/errors.js';
import { READ_LAG_MS } from '../auditService.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

describe('sink adapters — configuration', () => {
  test('a webhook needs a valid https URL', () => {
    expect(() => webhook.validateConfig({})).toThrow(/URL is required/);
    expect(() => webhook.validateConfig({ url: 'not a url' })).toThrow(/valid URL/);
    expect(() => webhook.validateConfig({ url: 'ftp://x.test/a' })).toThrow(/http or https/);
    // Audit entries must not travel in the clear.
    expect(() => webhook.validateConfig({ url: 'http://x.test/a' })).toThrow(/Use https/);
    expect(webhook.validateConfig({ url: 'https://x.test/a' })).toMatchObject({ url: 'https://x.test/a' });
  });

  test('a webhook header cannot smuggle another header', () => {
    expect(() =>
      webhook.validateConfig({ url: 'https://x.test/a', headers: { 'X-A': 'b\r\nX-Evil: 1' } })
    ).toThrow(/line breaks/);
  });

  test('the webhook signature covers the timestamp, so a body cannot be replayed', () => {
    const sig = webhook.signBody('sekrit', '{"a":1}', 1700000000);
    const expected = crypto.createHmac('sha256', 'sekrit').update('1700000000.{"a":1}').digest('hex');
    expect(sig).toBe(`t=1700000000,v1=${expected}`);
    // A different timestamp over the same body gives a different signature.
    expect(webhook.signBody('sekrit', '{"a":1}', 1700000001)).not.toBe(sig);
  });

  test('syslog frames declare a BYTE count, not a character count', () => {
    // Non-ASCII is where octet counting earns its keep: a collector that
    // trusted a character count would cut the message short mid-payload.
    // (JSON escapes newlines itself, so multi-byte text is the real case.)
    const envelope = {
      v: 1, id: 'e1', orgId: 'o1', occurredAt: '2026-01-01T00:00:00.000Z',
      action: 'user.updated', category: 'user', severity: 'notice',
      resource: { type: 'User', id: 'u1', label: null },
      actor: { id: 'u2', name: 'Ada Lovelace — 日本語', email: 'a@x.test', kind: 'human' },
      metadata: { note: 'naïve café 🔐' },
    };
    const frame = syslog.frameFor(envelope, { appName: 'shellius', facility: 13 });

    const [count] = frame.toString('utf8').split(' ', 1);
    const payload = frame.subarray(Buffer.byteLength(`${count} `, 'ascii'));

    expect(Number(count)).toBe(payload.length);
    // Bytes exceed characters, so the two counts genuinely differ here.
    expect(payload.length).toBeGreaterThan(payload.toString('utf8').length);

    const text = payload.toString('utf8');
    // facility 13 * 8 + severity 5 (notice) = 109
    expect(text).toContain('<109>1 2026-01-01T00:00:00.000Z');
    expect(text).toContain('日本語');
  });

  test('syslog escapes structured-data values', () => {
    const frame = syslog.frameFor(
      { v: 1, id: 'a"b]c', orgId: 'o', occurredAt: '2026-01-01T00:00:00.000Z', action: 'a.b', severity: 'info', resource: {}, actor: null, metadata: null },
      { appName: 'shellius', facility: 13 }
    );
    expect(frame.toString('utf8')).toContain('eventId="a\\"b\\]c"');
  });

  test('an s3 object key is derived from the batch, so a retry overwrites', () => {
    const args = { prefix: 'audit', orgId: 'org1', from: new Date('2026-03-04T05:06:07.000Z'), batchId: 'abc123' };
    expect(s3.objectKeyFor(args)).toBe('audit/org=org1/dt=2026-03-04/2026-03-04T05-06-07-000Z_abc123.ndjson.gz');
    expect(s3.objectKeyFor(args)).toBe(s3.objectKeyFor(args));
  });

  test('a digest needs real recipients', () => {
    expect(() => emailDigest.validateConfig({ recipients: [] })).toThrow(/at least one recipient/);
    expect(() => emailDigest.validateConfig({ recipients: ['nope'] })).toThrow(/not an email address/);
    expect(emailDigest.validateConfig({ recipients: ['A@X.test'] })).toMatchObject({ recipients: ['a@x.test'] });
  });

  test('the registry separates streaming sinks from the scheduled digest', () => {
    expect(SINK_TYPES).toEqual(expect.arrayContaining(['webhook', 's3', 'syslog', 'email_digest']));
    expect(STREAMING_TYPES).toEqual(expect.arrayContaining(['webhook', 's3', 'syslog']));
    expect(STREAMING_TYPES).not.toContain('email_digest');
    expect(() => getAdapter('nope')).toThrow(/Unknown sink type/);
  });
});

describe('sink config handling', () => {
  test('a secret is kept when an update omits it, and replaced when given', () => {
    const stored = { url: 'https://a.test/x', signingSecret: 'original' };
    expect(sinkService.mergeConfig('webhook', stored, { url: 'https://b.test/y' })).toMatchObject({
      url: 'https://b.test/y',
      signingSecret: 'original',
    });
    expect(sinkService.mergeConfig('webhook', stored, { signingSecret: '' })).toMatchObject({ signingSecret: 'original' });
    expect(sinkService.mergeConfig('webhook', stored, { signingSecret: 'new' })).toMatchObject({ signingSecret: 'new' });
  });

  test('filters keep only the keys that mean something', () => {
    expect(sinkService.normalizeFilters({ actions: ['a', 'a', 'b'], nonsense: 1 })).toEqual({ actions: ['a', 'b'] });
    expect(sinkService.normalizeFilters(null)).toEqual({});
  });

  test('a batch id is stable for the same rows and different for others', () => {
    expect(sinkService.batchIdFor('s1', 'a', 'z')).toBe(sinkService.batchIdFor('s1', 'a', 'z'));
    expect(sinkService.batchIdFor('s1', 'a', 'z')).not.toBe(sinkService.batchIdFor('s1', 'a', 'y'));
  });
});

describe('delivery loop (live DB)', () => {
  let org;
  let sinkRow;

  /** A sink whose adapter we control, registered under a real type. */
  async function makeSink(overrides = {}) {
    return prisma.auditSink.create({
      data: {
        orgId: org.id,
        name: 'test sink',
        type: 'webhook',
        configEncrypted: null,
        filters: {},
        isActive: true,
        batchSize: 10,
        cursorCreatedAt: new Date(Date.now() - READ_LAG_MS - 3_600_000),
        cursorId: '',
        ...overrides,
      },
    });
  }

  async function seed(count) {
    const start = new Date(Date.now() - READ_LAG_MS - 60_000);
    await prisma.auditLog.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        orgId: org.id,
        action: 'user.updated',
        resourceType: 'User',
        createdAt: new Date(start.getTime() + i),
      })),
    });
  }

  /**
   * Run a sink against a destination we control. ESM namespaces are frozen,
   * so the adapter is injected through ctx rather than patched — the same
   * seam the adapters expose for fetch/connect.
   */
  const withDeliver = (impl, run) =>
    run({ adapter: { ...webhook, deliver: impl, notReadyReason: () => null } });

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

  test('a successful batch advances the cursor and records the delivery', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(25);
    sinkRow = await makeSink();

    const sent = [];
    const result = await withDeliver(async (_cfg, envelopes) => {
      sent.push(envelopes.length);
      return { detail: 'ok' };
    }, (ctx) => sinkService.runSink(sinkRow, ctx));

    expect(result.delivered).toBe(25);
    expect(sent).toEqual([10, 10, 5]);

    const after = await prisma.auditSink.findUnique({ where: { id: sinkRow.id } });
    expect(after.cursorId).not.toBe('');
    expect(after.consecutiveFailures).toBe(0);
    expect(await prisma.auditSinkDelivery.count({ where: { sinkId: sinkRow.id, status: 'ok' } })).toBe(3);
  });

  test('a failure leaves the cursor alone, so the batch is redelivered', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(5);
    sinkRow = await makeSink();

    await withDeliver(async () => {
      throw new RetryableSinkError('collector is down');
    }, (ctx) => sinkService.runSink(sinkRow, ctx));

    const afterFail = await prisma.auditSink.findUnique({ where: { id: sinkRow.id } });
    expect(afterFail.cursorId).toBe(''); // untouched
    expect(afterFail.consecutiveFailures).toBe(1);
    expect(afterFail.backoffUntil).not.toBeNull();
    expect(afterFail.isActive).toBe(true); // will try again

    // The very same rows come back on the next run — nothing was skipped.
    const seen = [];
    await withDeliver(async (_cfg, envelopes) => {
      seen.push(...envelopes.map((e) => e.id));
      return {};
    }, (ctx) => sinkService.runSink(afterFail, ctx));

    expect(seen).toHaveLength(5);
  });

  test('a permanent failure switches the sink off instead of retrying forever', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(3);
    sinkRow = await makeSink();

    await withDeliver(async () => {
      throw new PermanentSinkError('404 Not Found');
    }, (ctx) => sinkService.runSink(sinkRow, ctx));

    const after = await prisma.auditSink.findUnique({ where: { id: sinkRow.id } });
    expect(after.isActive).toBe(false);
    expect(after.disabledReason).toMatch(/404/);
    // And it said so out loud, rather than dying quietly.
    const said = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: 'audit_sink.disabled' } });
    expect(said).not.toBeNull();
  });

  test('enough failures in a row also switches it off', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(3);
    sinkRow = await makeSink({ consecutiveFailures: sinkService.MAX_CONSECUTIVE_FAILURES - 1 });

    await withDeliver(async () => {
      throw new RetryableSinkError('still down');
    }, (ctx) => sinkService.runSink(sinkRow, ctx));

    const after = await prisma.auditSink.findUnique({ where: { id: sinkRow.id } });
    expect(after.isActive).toBe(false);
    expect(after.disabledReason).toMatch(/failures in a row/);
  });

  test('filters narrow what a sink receives', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(4);
    await prisma.auditLog.create({
      data: {
        orgId: org.id,
        action: 'server.deleted',
        resourceType: 'Server',
        createdAt: new Date(Date.now() - READ_LAG_MS - 30_000),
      },
    });
    sinkRow = await makeSink({ filters: { actions: ['server.deleted'] } });

    const seen = [];
    await withDeliver(async (_cfg, envelopes) => {
      seen.push(...envelopes);
      return {};
    }, (ctx) => sinkService.runSink(sinkRow, ctx));

    expect(seen).toHaveLength(1);
    expect(seen[0].action).toBe('server.deleted');
  });

  test('records carry a resolved actor and a scrubbed payload', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await prisma.user.create({
      data: { orgId: org.id, email: `sink-${Date.now()}@x.test`, name: 'Ada', role: 'member' },
    });
    await prisma.auditLog.create({
      data: {
        orgId: org.id,
        actorId: user.id,
        action: 'user.updated',
        resourceType: 'User',
        metadata: { password: 'hunter2', ok: 'yes' },
        createdAt: new Date(Date.now() - READ_LAG_MS - 30_000),
      },
    });
    sinkRow = await makeSink();

    let received;
    await withDeliver(async (_cfg, envelopes) => {
      [received] = envelopes;
      return {};
    }, (ctx) => sinkService.runSink(sinkRow, ctx));

    expect(received.actor).toMatchObject({ id: user.id, name: 'Ada', kind: 'human' });
    expect(received.metadata.password).toBe('[REDACTED]');
    expect(received.metadata.ok).toBe('yes');
  });
});
