import { jest } from '@jest/globals';
import { NAME_SNAPSHOT, snapshotName } from '../auditNameSnapshot.js';

const dbWith = (row) => {
  const calls = [];
  const model = { findFirst: jest.fn(async (args) => (calls.push(args), row)) };
  const db = new Proxy({}, { get: () => model });
  return { db, calls };
};

describe('snapshotName', () => {
  it('reads the name, scoped to the org', async () => {
    const { db, calls } = dbWith({ name: 'Backup policy' });
    expect(await snapshotName('org1', 'AccessPolicy', 'p1', { db })).toEqual({ name: 'Backup policy' });
    expect(calls[0].where).toEqual({ id: 'p1', orgId: 'org1' });
  });

  it('only the shared Keystore — a personal key is never named', async () => {
    const { db, calls } = dbWith(null);
    expect(await snapshotName('org1', 'SshKey', 'k1', { db })).toBeNull();
    expect(calls[0].where).toEqual({ ownerId: null, id: 'k1', orgId: 'org1' });
    expect(NAME_SNAPSHOT.Credential.scope).toEqual({ ownerId: null });
  });

  it('a server keeps its hostname too', async () => {
    const { db } = dbWith({ hostname: 'db-01', displayName: 'Primary DB' });
    expect(await snapshotName('org1', 'Server', 's1', { db })).toEqual({ name: 'Primary DB', hostname: 'db-01' });
  });

  it('unknown types, missing ids and failures are just no snapshot', async () => {
    const { db } = dbWith({ name: 'x' });
    expect(await snapshotName('org1', 'SmtpConfig', 'c1', { db })).toBeNull();
    expect(await snapshotName('org1', 'Group', undefined, { db })).toBeNull();
    const failing = new Proxy({}, { get: () => ({ findFirst: async () => { throw new Error('db down'); } }) });
    expect(await snapshotName('org1', 'Group', 'g1', { db: failing })).toBeNull();
  });
});
