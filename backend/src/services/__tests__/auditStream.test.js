/**
 * The keyset reader behind audit sinks and the archive job.
 *
 * The property that matters: every row is yielded exactly once, even when
 * many share a timestamp. Offset pagination can't promise that against a
 * table that is being written to; `(createdAt, id)` can, because `id` makes
 * the pair a total order and the cursor remembers both halves.
 *
 * The fixtures deliberately put dozens of rows on the *same millisecond*,
 * which is what a burst of activity looks like and what a naive
 * `createdAt > cursor` reader silently drops.
 */

import prisma from '../../config/db.js';
import { stream, lagFrom, READ_LAG_MS } from '../auditService.js';
import { toEnvelope, severityFor, ENVELOPE_VERSION } from '../audit/envelope.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

let org;

/** Rows old enough to be past the lag watermark. */
async function seed(count, { sameInstant = false, base = null } = {}) {
  const start = base ?? new Date(Date.now() - READ_LAG_MS - 60_000);
  await prisma.auditLog.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      orgId: org.id,
      action: i % 2 ? 'server.update' : 'user.updated',
      resourceType: 'Server',
      createdAt: sameInstant ? start : new Date(start.getTime() + i),
    })),
  });
}

const drain = async (opts) => {
  const seen = [];
  for await (const batch of stream({ orgId: org.id, ...opts })) seen.push(...batch);
  return seen;
};

describe('auditService.stream (live DB)', () => {
  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  afterEach(async () => {
    if (org) await prisma.auditLog.deleteMany({ where: { orgId: org.id } });
  });

  test('yields every row exactly once, in order, across batch boundaries', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(50);

    const seen = await drain({ batchSize: 7 }); // deliberately not a divisor of 50

    expect(seen).toHaveLength(50);
    expect(new Set(seen.map((r) => r.id)).size).toBe(50);
    for (let i = 1; i < seen.length; i += 1) {
      const prev = seen[i - 1];
      const cur = seen[i];
      const ordered =
        cur.createdAt > prev.createdAt || (cur.createdAt.getTime() === prev.createdAt.getTime() && cur.id > prev.id);
      expect(ordered).toBe(true);
    }
  });

  test('50 rows sharing one millisecond are still read exactly once', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(50, { sameInstant: true });

    const seen = await drain({ batchSize: 10 });

    // The whole point: a `createdAt > cursor` reader would return the first
    // batch and then skip the other 40.
    expect(seen).toHaveLength(50);
    expect(new Set(seen.map((r) => r.id)).size).toBe(50);
  });

  test('resuming from a cursor picks up exactly where it left off', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(30, { sameInstant: true });

    const first = await drain({ batchSize: 12 });
    const cut = first[11];
    const rest = await drain({ after: { createdAt: cut.createdAt, id: cut.id }, batchSize: 12 });

    expect(rest).toHaveLength(30 - 12);
    // No overlap between what we had and what we resumed with.
    const before = new Set(first.slice(0, 12).map((r) => r.id));
    expect(rest.some((r) => before.has(r.id))).toBe(false);
  });

  test('rows newer than the lag watermark are not read yet', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(5); // old enough
    await prisma.auditLog.create({
      data: { orgId: org.id, action: 'user.updated', resourceType: 'User', createdAt: new Date() },
    });

    const seen = await drain({ batchSize: 100 });

    // The fresh row is held back: its transaction may not be the last one to
    // land on that timestamp.
    expect(seen).toHaveLength(5);
  });

  test('filters narrow the stream, and lagFrom counts what is left', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    await seed(20);

    const onlyUpdates = await drain({ filters: { actions: ['server.update'] }, batchSize: 100 });
    expect(onlyUpdates).toHaveLength(10);
    expect(onlyUpdates.every((r) => r.action === 'server.update')).toBe(true);

    expect(await lagFrom({ orgId: org.id })).toBe(20);
    const half = onlyUpdates[4];
    const remaining = await lagFrom({
      orgId: org.id,
      after: { createdAt: half.createdAt, id: half.id },
      filters: { actions: ['server.update'] },
    });
    expect(remaining).toBe(5);
  });

  test('an empty log yields nothing rather than hanging', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    expect(await drain({ batchSize: 10 })).toHaveLength(0);
  });
});

describe('audit envelope', () => {
  test('describes an event the same way for every sink', () => {
    const env = toEnvelope({
      id: 'abc',
      orgId: 'org1',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      action: 'api_token.revoke',
      resourceType: 'ApiToken',
      resourceId: 'tok1',
      ipAddress: '10.0.0.1',
      metadata: { name: 'ci' },
    }, { actor: { id: 'u1', name: 'Ada', email: 'a@x.test', kind: 'human' }, resourceLabel: 'ci token' });

    expect(env).toMatchObject({
      v: ENVELOPE_VERSION,
      id: 'abc',
      occurredAt: '2026-01-02T03:04:05.000Z',
      action: 'api_token.revoke',
      category: 'api_token',
      severity: 'warning',
      resource: { type: 'ApiToken', id: 'tok1', label: 'ci token' },
      actor: { id: 'u1', name: 'Ada', kind: 'human' },
    });
  });

  test('secrets in metadata are scrubbed on the way out, not just on the way in', () => {
    // A row written before a redaction rule existed must not be shipped raw.
    const env = toEnvelope({
      id: 'x', orgId: 'o', createdAt: new Date(), action: 'a.b', resourceType: 'T',
      metadata: { password: 'hunter2', note: 'fine' },
    });
    expect(env.metadata.password).toBe('[REDACTED]');
    expect(env.metadata.note).toBe('fine');
  });

  test('severity is derived so existing rows get one too', () => {
    expect(severityFor('auth.login_failed')).toBe('warning');
    expect(severityFor('user.deleted')).toBe('notice');
    expect(severityFor('auth.login')).toBe('info');
  });

  test('an actor that could not be resolved still carries its id', () => {
    const env = toEnvelope({ id: 'x', orgId: 'o', createdAt: new Date(), action: 'a.b', resourceType: 'T', actorId: 'u9' });
    expect(env.actor).toMatchObject({ id: 'u9', name: null });
    const none = toEnvelope({ id: 'y', orgId: 'o', createdAt: new Date(), action: 'a.b', resourceType: 'T' });
    expect(none.actor).toBeNull();
  });
});
