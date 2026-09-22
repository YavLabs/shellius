/**
 * Audit log free-text search by resource name for every audited type (not
 * just Server/Customer/User), plus the table-driven label resolution.
 *
 * Pure parts (the RESOURCE_NAME_SEARCH / RESOURCE_LABELS maps, the lookup's
 * where-clauses, the SQL fragment) are tested with an injected fake db — no
 * module mocking (jest.unstable_mockModule is broken in this Jest + ESM
 * setup, see caService.test.js). list()/exportAll() are exercised against a
 * live DB (dbReachable() skip pattern, see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import {
  RESOURCE_NAME_SEARCH,
  RESOURCE_LABELS,
  NAME_LOOKUP_CAP,
  findResourceIdsByName,
  lookupLabels,
  auditSearchFragment,
  list,
  exportAll,
} from '../auditService.js';
import { encrypt } from '../../utils/crypto.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

/** Fake Prisma client: records every findMany call per model and returns canned rows. */
function fakeDb(rowsByModel = {}, { failing = [] } = {}) {
  const calls = [];
  const db = new Proxy(
    {},
    {
      get(_t, model) {
        return {
          findMany: async (args) => {
            calls.push({ model, args });
            if (failing.includes(model)) throw new Error('boom');
            return rowsByModel[model] ?? [];
          },
        };
      },
    }
  );
  return { db, calls };
}

// ---------------------------------------------------------------------------
// Map coverage
// ---------------------------------------------------------------------------

describe('RESOURCE_NAME_SEARCH map', () => {
  const EXPECTED = [
    'AccessPolicy', 'Group', 'Role', 'Credential', 'SshKey', 'KeyDeployment', 'AccessRequest',
    'Certificate', 'Session', 'CaKeyPair', 'SsoConfig', 'EmailProvider', 'PostureAlertRule',
    'ExposureFinding', 'Organization', 'server',
  ];

  test('covers every name-bearing audited resource type', () => {
    expect(Object.keys(RESOURCE_NAME_SEARCH).sort()).toEqual([...EXPECTED].sort());
  });

  test('never includes personal-only types or the SQL-joined types', () => {
    for (const t of ['PersonalHost', 'QuickConnectHistory', 'Server', 'Customer', 'User']) {
      expect(RESOURCE_NAME_SEARCH).not.toHaveProperty(t);
    }
  });

  test('every spec points at a real Prisma model', () => {
    for (const [type, spec] of Object.entries(RESOURCE_NAME_SEARCH)) {
      expect({ type, ok: typeof prisma[spec.model]?.findMany === 'function' }).toEqual({ type, ok: true });
    }
    for (const [type, spec] of Object.entries(RESOURCE_LABELS)) {
      expect({ type, ok: typeof prisma[spec.model]?.findMany === 'function' }).toEqual({ type, ok: true });
    }
  });

  test('no spec scope/where can carry its own org predicate', () => {
    for (const spec of Object.values(RESOURCE_NAME_SEARCH)) {
      expect(spec.scope ?? {}).not.toHaveProperty('orgId');
    }
  });

  test('labels cover the search types the hand-written switch does not', () => {
    const switchTypes = ['User', 'Server', 'Customer', 'AccessRequest', 'Certificate', 'Session', 'Group', 'AccessPolicy'];
    for (const t of Object.keys(RESOURCE_NAME_SEARCH)) {
      if (t === 'server') continue; // normalised to 'Server'
      expect({ t, covered: switchTypes.includes(t) || t in RESOURCE_LABELS }).toEqual({ t, covered: true });
    }
    expect(RESOURCE_LABELS).not.toHaveProperty('PersonalHost');
  });
});

// ---------------------------------------------------------------------------
// findResourceIdsByName — org scoping, personal exclusion, cap
// ---------------------------------------------------------------------------

describe('findResourceIdsByName', () => {
  test('every lookup is scoped to the caller org and capped', async () => {
    const { db, calls } = fakeDb();
    await findResourceIdsByName('org-1', 'prod', { db });
    expect(calls).toHaveLength(Object.keys(RESOURCE_NAME_SEARCH).length);
    for (const { model, args } of calls) {
      const orgField = model === 'organization' ? 'id' : 'orgId';
      expect({ model, org: args.where[orgField] }).toEqual({ model, org: 'org-1' });
      expect(args.take).toBe(NAME_LOOKUP_CAP);
      expect(Array.isArray(args.where.OR)).toBe(true);
      expect(args.where.OR.length).toBeGreaterThan(0);
    }
  });

  test('Keystore lookups exclude personal items (ownerId null)', async () => {
    const { db, calls } = fakeDb();
    await findResourceIdsByName('org-1', 'deploy', { db });
    const byModel = Object.fromEntries(calls.map((c) => [c.model, c.args.where]));
    expect(byModel.credential.ownerId).toBeNull();
    expect(byModel.sshKey.ownerId).toBeNull();
    expect(byModel.keyDeployment.sshKey).toEqual({ ownerId: null });
    expect(byModel).not.toHaveProperty('personalHost');
    expect(byModel).not.toHaveProperty('quickConnectHistory');
  });

  test('match is case-insensitive contains on the query', async () => {
    const { db, calls } = fakeDb();
    await findResourceIdsByName('org-1', 'Web-Admins', { db });
    const group = calls.find((c) => c.model === 'group');
    expect(group.args.where.OR).toEqual([{ name: { contains: 'Web-Admins', mode: 'insensitive' } }]);
  });

  test('returns [type, ids] only for types with hits; KeyDeployment yields id and batchId', async () => {
    const { db } = fakeDb({
      accessPolicy: [{ id: 'pol-1' }, { id: 'pol-2' }],
      keyDeployment: [{ id: 'dep-1', batchId: 'batch-1' }, { id: 'dep-2', batchId: 'batch-1' }],
    });
    const out = Object.fromEntries(await findResourceIdsByName('org-1', 'x', { db }));
    expect(out).toEqual({ AccessPolicy: ['pol-1', 'pol-2'], KeyDeployment: ['dep-1', 'batch-1', 'dep-2'] });
  });

  test('a failing lookup is skipped, not thrown', async () => {
    const { db } = fakeDb({ group: [{ id: 'g-1' }] }, { failing: ['accessPolicy'] });
    const out = Object.fromEntries(await findResourceIdsByName('org-1', 'x', { db }));
    expect(out).toEqual({ Group: ['g-1'] });
  });

  test('no org or no query → no lookups', async () => {
    const { db, calls } = fakeDb();
    expect(await findResourceIdsByName(null, 'x', { db })).toEqual([]);
    expect(await findResourceIdsByName('org-1', '', { db })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// auditSearchFragment — the id branches are OR'd into the search only
// ---------------------------------------------------------------------------

describe('auditSearchFragment', () => {
  test('without name matches it is the plain ILIKE clause', () => {
    const sql = auditSearchFragment('%x%');
    expect(sql.text).not.toMatch(/resource_id IN/);
  });

  test('adds one bound (resource_type = T AND resource_id IN ids) branch per type', () => {
    const sql = auditSearchFragment('%x%', [['AccessPolicy', ['p1', 'p2']], ['Role', ['r1']]]);
    expect(sql.text.match(/al\.resource_type = \$\d+ AND al\.resource_id IN \(/g)).toHaveLength(2);
    expect(sql.values).toEqual(expect.arrayContaining(['AccessPolicy', 'p1', 'p2', 'Role', 'r1']));
    // Values are bound, never interpolated into the SQL text.
    expect(sql.text).not.toMatch(/AccessPolicy|p1/);
  });
});

// ---------------------------------------------------------------------------
// lookupLabels — org scoping + personal exclusion on label resolution
// ---------------------------------------------------------------------------

describe('lookupLabels', () => {
  test('org predicate always applied; personal Keystore items excluded', async () => {
    const { db, calls } = fakeDb();
    for (const type of Object.keys(RESOURCE_LABELS)) await lookupLabels(type, ['id-1'], 'org-9', db);
    for (const { model, args } of calls) {
      const orgField = model === 'organization' ? 'id' : 'orgId';
      expect({ model, org: args.where[orgField] }).toEqual({ model, org: 'org-9' });
    }
    const byModel = Object.fromEntries(calls.map((c) => [c.model, c.args.where]));
    expect(byModel.credential.ownerId).toBeNull();
    expect(byModel.sshKey.ownerId).toBeNull();
  });

  test('KeyDeployment labels resolve both deployment ids and batch ids', async () => {
    const { db } = fakeDb({
      keyDeployment: [
        { id: 'd1', batchId: 'b1', sshKey: { name: 'deploy-key' }, server: { hostname: 'web-1' } },
        { id: 'd2', batchId: 'b1', sshKey: { name: 'deploy-key' }, server: { hostname: 'web-2', displayName: 'Web 2' } },
      ],
    });
    const map = await lookupLabels('KeyDeployment', ['d1', 'b1'], 'org-1', db);
    expect(map.get('d1')).toBe('deploy-key → web-1');
    expect(map.get('d2')).toBe('deploy-key → Web 2');
    expect(map.get('b1')).toBe('deploy-key → 2 servers');
  });
});

// ---------------------------------------------------------------------------
// Live DB: list()/exportAll() search by name, scope preserved
// ---------------------------------------------------------------------------

describe('auditService search by resource name (live DB)', () => {
  let reachable = false;
  let org;
  let otherOrg;
  let admin;
  let owner;
  const s = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const POLICY_NAME = `zz-policy-${s}`;
  const ORG_KEY_NAME = `zz-orgkey-${s}`;
  const PERSONAL_KEY_NAME = `zz-mykey-${s}`;
  const ROLE_NAME = `zz-role-${s}`;
  let policy;
  let otherPolicy;
  let orgKey;
  let personalKey;
  let role;
  let rowPolicy;
  let rowOtherOrgPolicy;
  let rowOrgKey;
  let rowPersonalKey;
  let rowRole;

  const keyData = (orgId, name, ownerId = null) => ({
    orgId,
    name,
    ownerId,
    keyType: 'ed25519',
    publicKey: 'ssh-ed25519 AAAAfake test@host',
    privateKeyEncrypted: encrypt('fake-test-key-material'),
    fingerprint: `SHA256:fake-${name}`,
    source: 'generated',
  });
  const policyData = (orgId, name) => ({
    orgId,
    name,
    effect: 'ALLOW',
    targetEnvironments: ['dev'],
    targetServerIds: [],
    allowedPrincipals: ['ubuntu'],
    maxSessionDuration: 3600,
  });

  beforeAll(async () => {
    reachable = await dbReachable();
    if (!reachable) {
      console.warn('[skip] auditResourceNameSearch: no live DB');
      return;
    }
    org = await createTestOrg();
    otherOrg = await createTestOrg();
    admin = await createTestUser(org.id, { role: 'admin' });
    owner = await createTestUser(org.id, { role: 'member' });

    policy = await prisma.accessPolicy.create({ data: policyData(org.id, POLICY_NAME) });
    otherPolicy = await prisma.accessPolicy.create({ data: policyData(otherOrg.id, POLICY_NAME) });
    orgKey = await prisma.sshKey.create({ data: keyData(org.id, ORG_KEY_NAME) });
    personalKey = await prisma.sshKey.create({ data: keyData(org.id, PERSONAL_KEY_NAME, owner.id) });
    role = await prisma.role.create({
      data: { orgId: org.id, key: `custom_${s}`, name: ROLE_NAME, baseRole: 'member', permissions: [] },
    });

    // Metadata deliberately carries no name, so only the name lookup can match.
    const mk = (orgId, actorId, action, resourceType, resourceId) =>
      prisma.auditLog.create({ data: { orgId, actorId, action, resourceType, resourceId, metadata: { method: 'PUT' } } });
    rowPolicy = await mk(org.id, admin.id, 'policy.update', 'AccessPolicy', policy.id);
    rowOtherOrgPolicy = await mk(otherOrg.id, null, 'policy.update', 'AccessPolicy', otherPolicy.id);
    rowOrgKey = await mk(org.id, admin.id, 'keystore.key.update', 'SshKey', orgKey.id);
    rowPersonalKey = await mk(org.id, owner.id, 'keystore.key.update', 'SshKey', personalKey.id);
    rowRole = await mk(org.id, admin.id, 'role.update', 'Role', role.id);
  });

  afterAll(async () => {
    if (!reachable) return;
    await cleanupOrg(org.id);
    await cleanupOrg(otherOrg.id);
  });

  const ids = (res) => res.items.map((i) => i.id);

  test('finds an AccessPolicy row by the policy name, only in the caller org', async () => {
    if (!reachable) return;
    const res = await list({ orgId: org.id, filters: { search: POLICY_NAME.toUpperCase() } });
    expect(ids(res)).toEqual([rowPolicy.id]);
    expect(res.items[0].resourceLabel).toBe(POLICY_NAME);
    expect(ids(res)).not.toContain(rowOtherOrgPolicy.id);
  });

  test('finds an org SshKey and a Role by name, with resolved labels + links', async () => {
    if (!reachable) return;
    const key = await list({ orgId: org.id, filters: { search: ORG_KEY_NAME } });
    expect(ids(key)).toEqual([rowOrgKey.id]);
    expect(key.items[0].resourceLabel).toBe(ORG_KEY_NAME);
    expect(key.items[0].resourceLink).toBe(`/keystore?tab=keys&highlight=${orgKey.id}`);

    const r = await list({ orgId: org.id, filters: { search: ROLE_NAME } });
    expect(ids(r)).toEqual([rowRole.id]);
    expect(r.items[0].resourceLabel).toBe(ROLE_NAME);
  });

  test('a personal Keystore item is never matched or labelled by its name', async () => {
    if (!reachable) return;
    const res = await list({ orgId: org.id, filters: { search: PERSONAL_KEY_NAME } });
    expect(ids(res)).not.toContain(rowPersonalKey.id);

    const all = await list({ orgId: org.id, filters: { resourceType: 'SshKey' }, limit: 100 });
    const row = all.items.find((i) => i.id === rowPersonalKey.id);
    expect(row.resourceLabel).toBe('SshKey');
  });

  test('the other filters still apply on top of a name match (scope predicate preserved)', async () => {
    if (!reachable) return;
    const wrongType = await list({ orgId: org.id, filters: { search: POLICY_NAME, resourceType: 'Group' } });
    expect(wrongType.items).toEqual([]);
    const wrongActor = await list({ orgId: org.id, filters: { search: POLICY_NAME, actorId: owner.id } });
    expect(wrongActor.items).toEqual([]);
    const future = await list({
      orgId: org.id,
      filters: { search: POLICY_NAME, startDate: new Date(Date.now() + 86400000).toISOString() },
    });
    expect(future.items).toEqual([]);
    // Another org searching the same name only sees its own row.
    const other = await list({ orgId: otherOrg.id, filters: { search: POLICY_NAME } });
    expect(ids(other)).toEqual([rowOtherOrgPolicy.id]);
  });

  test('export honours the same name search', async () => {
    if (!reachable) return;
    const { buffer } = await exportAll({ orgId: org.id, filters: { search: POLICY_NAME }, format: 'json' });
    expect(JSON.parse(buffer.toString('utf8')).map((r) => r.id)).toEqual([rowPolicy.id]);
  });
});
