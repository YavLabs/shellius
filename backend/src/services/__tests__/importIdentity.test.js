/**
 * importIdentity.test.js — `storeAsIdentity` on the server import.
 *
 * Import credentials are destroyed the moment onboarding reaches a terminal
 * state, and `server.credentialId` was never set. So a fleet that had just
 * been imported AND bootstrapped had nothing stored for any of its hosts —
 * which is exactly the "no credentials" population the bulk installer then
 * has to skip. This column is the opt-out.
 *
 * What is worth pinning:
 *   - opt-in only. An import must never quietly turn one-shot bootstrap
 *     material into standing stored access.
 *   - rows sharing an identityName produce ONE Keystore entry, not N. Fifty
 *     servers behind one bastion key is the case that makes or breaks this.
 *   - a name collision with a DIFFERENT user fails loudly. Silently
 *     re-pointing a server at someone else's identity is the worst outcome.
 *   - authMode is not touched: the stored identity is for installs and
 *     recovery, not a downgrade of how people connect.
 */

import prisma from '../../config/db.js';
import { commitImportJob } from '../importService.js';
import { encrypt } from '../../utils/crypto.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

let seq = 0;
const unique = () => `${Date.now().toString(36)}${(seq += 1)}${Math.random().toString(36).slice(2, 6)}`;

describe('import storeAsIdentity (DB)', () => {
  let org;
  let customer;

  const mkJob = async () =>
    prisma.importJob.create({
      data: { orgId: org.id, status: 'preview_ready', source: 'csv' },
    });

  const mkRow = (jobId, raw, rowIndex = 0) =>
    prisma.importRow.create({
      data: { jobId, entity: 'server', rowIndex, raw, action: 'create' },
    });

  const mkStaged = (jobId, hostname, extra = {}) =>
    prisma.onboardingCredential.create({
      data: {
        jobId,
        serverRef: hostname,
        sshUser: 'ubuntu',
        authMethod: 'password',
        passwordEncrypted: encrypt('hunter2'),
        status: 'staged',
        expiresAt: new Date(Date.now() + 3600_000),
        ...extra,
      },
    });

  const serverRaw = (hostname) => ({
    hostname,
    ipAddress: '10.0.0.50',
    customer: customer.slug,
    environment: 'dev',
    sshUser: 'ubuntu',
  });

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customer = await prisma.customer.create({
      data: { orgId: org.id, name: `cust-${unique()}`, slug: `c-${unique()}` },
    });
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.credential.deleteMany({ where: { orgId: org.id } });
    await prisma.sshKey.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.importJob.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  it('does nothing unless the row asks for it', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const job = await mkJob();
    const hostname = `${unique()}.example.com`;
    await mkRow(job.id, serverRaw(hostname));
    await mkStaged(job.id, hostname);

    await commitImportJob({ orgId: org.id, jobId: job.id });

    const server = await prisma.server.findFirst({ where: { orgId: org.id, hostname } });
    expect(server).toBeTruthy();
    expect(server.credentialId).toBeNull();
    expect(await prisma.credential.count({ where: { orgId: org.id } })).toBe(0);
  });

  it('saves a password row as a Keystore identity and binds it to the server', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const job = await mkJob();
    const hostname = `${unique()}.example.com`;
    const name = `id-${unique()}`;
    await mkRow(job.id, { ...serverRaw(hostname), storeAsIdentity: 'true', identityName: name });
    await mkStaged(job.id, hostname, { storeAsIdentity: true, identityName: name });

    await commitImportJob({ orgId: org.id, jobId: job.id });

    const server = await prisma.server.findFirst({ where: { orgId: org.id, hostname } });
    const cred = await prisma.credential.findFirst({ where: { orgId: org.id, name } });
    expect(cred).toBeTruthy();
    expect(cred.username).toBe('ubuntu');
    expect(cred.authType).toBe('password');
    // Org Keystore, never a personal vault item.
    expect(cred.ownerId).toBeNull();
    expect(server.credentialId).toBe(cred.id);
    // The identity is for installs and recovery — not a downgrade of how
    // people connect.
    expect(server.authMode).toBe('certificate');
  });

  it('collapses rows that name the same identity into ONE Keystore entry', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const job = await mkJob();
    const name = `shared-${unique()}`;
    const hosts = [`${unique()}.example.com`, `${unique()}.example.com`, `${unique()}.example.com`];
    let i = 0;
    for (const h of hosts) {
      await mkRow(job.id, { ...serverRaw(h), storeAsIdentity: 'true', identityName: name }, i++);
      await mkStaged(job.id, h, { storeAsIdentity: true, identityName: name });
    }

    await commitImportJob({ orgId: org.id, jobId: job.id });

    const creds = await prisma.credential.findMany({ where: { orgId: org.id, name } });
    expect(creds).toHaveLength(1);
    const servers = await prisma.server.findMany({ where: { orgId: org.id, hostname: { in: hosts } } });
    expect(servers).toHaveLength(3);
    expect(servers.every((s) => s.credentialId === creds[0].id)).toBe(true);
  });

  it('refuses to reuse an identity that belongs to a different user', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const name = `conflict-${unique()}`;
    await prisma.credential.create({
      data: { orgId: org.id, name, username: 'someone-else', authType: 'password' },
    });

    const job = await mkJob();
    const hostname = `${unique()}.example.com`;
    await mkRow(job.id, { ...serverRaw(hostname), storeAsIdentity: 'true', identityName: name });
    await mkStaged(job.id, hostname, { storeAsIdentity: true, identityName: name });

    await commitImportJob({ orgId: org.id, jobId: job.id });

    const row = await prisma.importRow.findFirst({ where: { jobId: job.id } });
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/already exists for user/i);
    // The pre-existing identity is untouched, and nothing was bound to it.
    const cred = await prisma.credential.findFirst({ where: { orgId: org.id, name } });
    expect(cred.username).toBe('someone-else');
  });

  it('names the identity after the host when the file does not', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const job = await mkJob();
    const hostname = `${unique()}.example.com`;
    await mkRow(job.id, { ...serverRaw(hostname), storeAsIdentity: 'true' });
    await mkStaged(job.id, hostname, { storeAsIdentity: true });

    await commitImportJob({ orgId: org.id, jobId: job.id });

    const cred = await prisma.credential.findFirst({
      where: { orgId: org.id, name: `Imported — ${hostname}` },
    });
    expect(cred).toBeTruthy();
  });
});
