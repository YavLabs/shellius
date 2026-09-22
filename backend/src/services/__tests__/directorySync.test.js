/**
 * Directory sync — the safety valves.
 *
 * The happy path here is nearly uninteresting: someone left the company, we
 * suspend their account. Every test below is instead about the cases where
 * the run must NOT act, because those are the ones that would cost a company
 * its access to its own servers.
 *
 * The adapter is injected through `ctx.adapter`, which is how a fake directory
 * gets driven without a live IdP. (ESM namespace objects are frozen, so the
 * module cannot be monkey-patched — the seam is deliberate.)
 */

import prisma from '../../config/db.js';
import * as directorySyncService from '../directory/directorySyncService.js';
import { encrypt } from '../../utils/crypto.js';
import { syncSystemRoles } from '../roleService.js';
import { dbReachable, createTestOrg, createTestUser, cleanupOrg } from './testDbHelper.js';

const HOUR = 60 * 60 * 1000;

let org;
let ssoConfig;

/** A directory that returns exactly what a test tells it to. */
const fakeAdapter = (entries, { reportsDisabled = true, failTest = null } = {}) => ({
  label: 'Fake directory',
  secretFields: [],
  reportsDisabled,
  validateConfig: (c) => c,
  test: async () => {
    if (failTest) throw new Error(failTest);
    return { ok: true };
  },
  listUsers: async () => entries,
});

async function makeSync(overrides = {}) {
  return prisma.directorySync.create({
    data: {
      orgId: org.id,
      ssoConfigId: ssoConfig.id,
      adapter: 'okta',
      configEncrypted: encrypt(JSON.stringify({ domain: 'acme.okta.com', apiToken: 'x' })),
      isActive: true,
      action: 'suspend',
      dryRun: false,
      graceHours: 0,
      ...overrides,
    },
  });
}

/** A user who signs in through `ssoConfig`, with a known directory id. */
async function makeSsoUser({ externalId, email, role = 'member', configId = null } = {}) {
  const user = await createTestUser(org.id, { role, email });
  await prisma.userIdentity.create({
    data: {
      orgId: org.id,
      userId: user.id,
      ssoConfigId: configId || ssoConfig.id,
      provider: 'oidc',
      subject: `sub-${user.id}`,
      externalId: externalId ?? null,
      email: email || user.email,
    },
  });
  return user;
}

const statusOf = async (id) => (await prisma.user.findUnique({ where: { id }, select: { status: true } })).status;

describe('directory sync (live DB)', () => {
  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    // Notification recipients are chosen by permission, not by role name, so
    // the org needs its built-in roles for anyone to be findable.
    await syncSystemRoles(org.id);
    ssoConfig = await prisma.ssoConfig.create({
      data: {
        orgId: org.id,
        provider: 'oidc',
        presetId: 'okta',
        name: 'Acme Okta',
        clientId: 'cid',
        issuerUrl: 'https://acme.okta.com',
        redirectUri: 'https://shellius.test/cb',
      },
    });
  });

  afterEach(async () => {
    if (!org) return;
    await prisma.directorySyncFinding.deleteMany({ where: { orgId: org.id } });
    await prisma.directorySyncRun.deleteMany({ where: { orgId: org.id } });
    await prisma.directorySync.deleteMany({ where: { orgId: org.id } });
    await prisma.userIdentity.deleteMany({ where: { orgId: org.id } });
    await prisma.notification.deleteMany({ where: { orgId: org.id } });
    await prisma.certificate.deleteMany({ where: { orgId: org.id } });
    await prisma.apiToken.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.ssoConfig.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.role.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  // -------------------------------------------------------------------------
  // The reason this feature exists
  // -------------------------------------------------------------------------

  test('someone removed from the directory is suspended and their access revoked', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const staying = await makeSsoUser({ externalId: 'dir-1' });
    const leaver = await makeSsoUser({ externalId: 'dir-2' });
    const sync = await makeSync();

    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-1', email: staying.email, enabled: true }]),
    });

    expect(run.status).toBe('ok');
    expect(run.suspended).toBe(1);
    expect(await statusOf(leaver.id)).toBe('suspended');
    expect(await statusOf(staying.id)).toBe('active');
  });

  test('someone disabled in the directory is caught too, not only someone deleted', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync();

    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-1', email: user.email, enabled: false }]),
    });

    expect(run.suspended).toBe(1);
    const finding = await prisma.directorySyncFinding.findFirst({ where: { userId: user.id } });
    expect(finding.reason).toBe('disabled');
  });

  // -------------------------------------------------------------------------
  // Valves 1–3: do not believe the directory
  // -------------------------------------------------------------------------

  test('a credential that fails its test aborts before the directory is even read', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync();
    let listed = false;
    const adapter = {
      ...fakeAdapter([], { failTest: 'the client secret has expired' }),
      listUsers: async () => {
        listed = true;
        return [];
      },
    };

    const run = await directorySyncService.runSync(sync, { adapter });

    expect(run.status).toBe('failed');
    expect(listed).toBe(false);
    expect(await statusOf(user.id)).toBe('active');
  });

  test('an empty directory suspends nobody', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync();

    const run = await directorySyncService.runSync(sync, { adapter: fakeAdapter([]) });

    expect(run.status).toBe('aborted');
    expect(run.abortReason).toMatch(/no users at all/);
    expect(await statusOf(user.id)).toBe('active');
  });

  test('a directory that has halved since the last good run is not believed', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync();
    await prisma.directorySyncRun.create({
      data: { orgId: org.id, syncId: sync.id, status: 'ok', directoryCount: 500 },
    });

    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-1', email: user.email, enabled: true }]),
    });

    expect(run.status).toBe('aborted');
    expect(run.abortReason).toMatch(/down from 500/);
    expect(await statusOf(user.id)).toBe('active');
  });

  // -------------------------------------------------------------------------
  // Valves 4–6: do not judge people this run cannot judge
  // -------------------------------------------------------------------------

  test('a local account with no identity for this provider is invisible to the run', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const local = await createTestUser(org.id);
    const present = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync();

    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-1', email: present.email, enabled: true }]),
    });

    expect(run.candidates).toBe(0);
    expect(await statusOf(local.id)).toBe('active');
  });

  test('an identity with no known directory id is counted as unknown, never as absent', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    // This is the Entra case: `sub` is pairwise, so `externalId` is null until
    // the user signs in again and we learn their `oid`.
    const unknown = await makeSsoUser({ externalId: null, email: 'nobody@elsewhere.test' });
    const present = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync();

    // A directory that carries no emails at all, so there is nothing to fall
    // back to for the unknown identity.
    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-1', email: null, enabled: true }]),
    });

    expect(run.unknownIdentities).toBe(1);
    expect(run.candidates).toBe(0);
    expect(await statusOf(unknown.id)).toBe('active');
  });

  test('an identity with no directory id still matches on email when the directory has them', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await makeSsoUser({ externalId: null });
    const sync = await makeSync();

    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-9', email: user.email, enabled: true }]),
    });

    expect(run.matchedByEmail).toBe(1);
    expect(run.candidates).toBe(0);
    expect(await statusOf(user.id)).toBe('active');
  });

  test('someone who still has an identity with another active provider is left alone', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const other = await prisma.ssoConfig.create({
      data: {
        orgId: org.id,
        provider: 'oidc',
        presetId: 'google',
        name: 'Google',
        clientId: 'c',
        issuerUrl: 'https://accounts.google.com',
        redirectUri: 'https://shellius.test/cb',
        isActive: true,
      },
    });
    const user = await makeSsoUser({ externalId: 'dir-2' });
    await prisma.userIdentity.create({
      data: { orgId: org.id, userId: user.id, ssoConfigId: other.id, provider: 'oidc', subject: `g-${user.id}`, externalId: 'g-1' },
    });
    const keeper = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync();

    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-1', email: keeper.email, enabled: true }]),
    });

    expect(run.skipped).toBe(1);
    expect(run.suspended).toBe(0);
    expect(await statusOf(user.id)).toBe('active');
    await prisma.userIdentity.deleteMany({ where: { ssoConfigId: other.id } });
    await prisma.ssoConfig.delete({ where: { id: other.id } });
  });

  // -------------------------------------------------------------------------
  // Valves 7–10: do not act too fast, too widely, or without being told to
  // -------------------------------------------------------------------------

  test('a dry run reports exactly what it would do and changes nothing', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const leaver = await makeSsoUser({ externalId: 'dir-2' });
    const keeper = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync({ dryRun: true });

    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-1', email: keeper.email, enabled: true }]),
    });

    expect(run.status).toBe('ok');
    expect(run.candidates).toBe(1);
    expect(run.flagged).toBe(1);
    expect(run.suspended).toBe(0);
    expect(await statusOf(leaver.id)).toBe('active');
  });

  test("action 'flag' never suspends, even when it is not a dry run", async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const leaver = await makeSsoUser({ externalId: 'dir-2' });
    const keeper = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync({ action: 'flag', dryRun: false });

    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-1', email: keeper.email, enabled: true }]),
    });

    expect(run.flagged).toBe(1);
    expect(run.suspended).toBe(0);
    expect(await statusOf(leaver.id)).toBe('active');
  });

  test('absence must outlast the grace period before anyone is suspended', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const leaver = await makeSsoUser({ externalId: 'dir-2' });
    const keeper = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync({ graceHours: 24 });
    const adapter = fakeAdapter([{ externalId: 'dir-1', email: keeper.email, enabled: true }]);

    // First sighting: a finding is opened, nothing is done.
    const first = await directorySyncService.runSync(sync, { adapter });
    expect(first.suspended).toBe(0);
    expect(await statusOf(leaver.id)).toBe('active');

    // Age the finding past the grace period, as a day of runs would.
    await prisma.directorySyncFinding.updateMany({
      where: { syncId: sync.id, userId: leaver.id },
      data: { firstSeenAt: new Date(Date.now() - 25 * HOUR) },
    });

    const second = await directorySyncService.runSync(sync, { adapter });
    expect(second.suspended).toBe(1);
    expect(await statusOf(leaver.id)).toBe('suspended');
  });

  test('someone who reappears before the grace period ends is never touched', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const user = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync({ graceHours: 24 });

    await directorySyncService.runSync(sync, { adapter: fakeAdapter([{ externalId: 'dir-2', email: 'x@y.test', enabled: true }]) });
    expect(await prisma.directorySyncFinding.count({ where: { userId: user.id, status: 'open' } })).toBe(1);

    // The next run sees them again — a blip, not a departure.
    await directorySyncService.runSync(sync, { adapter: fakeAdapter([{ externalId: 'dir-1', email: user.email, enabled: true }]) });

    const finding = await prisma.directorySyncFinding.findFirst({ where: { userId: user.id } });
    expect(finding.status).toBe('resolved');
    expect(await statusOf(user.id)).toBe('active');
  });

  test('a mass disappearance aborts the run instead of suspending everyone', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const users = [];
    for (let i = 0; i < 6; i += 1) users.push(await makeSsoUser({ externalId: `dir-${i}` }));
    const sync = await makeSync({ maxSuspendCount: 3, maxSuspendPercent: 100 });

    // The directory answers with one user. Under a broken credential or a
    // paging bug this is exactly what the fleet's whole staff disappearing
    // looks like.
    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-0', email: users[0].email, enabled: true }]),
    });

    expect(run.status).toBe('aborted');
    expect(run.abortReason).toMatch(/limit of 3/);
    for (const u of users) expect(await statusOf(u.id)).toBe('active');
  });

  test('the percentage limit aborts too, for an org too small for the count to bite', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const users = [];
    for (let i = 0; i < 4; i += 1) users.push(await makeSsoUser({ externalId: `dir-${i}` }));
    const sync = await makeSync({ maxSuspendCount: 1000, maxSuspendPercent: 10 });

    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-0', email: users[0].email, enabled: true }]),
    });

    expect(run.status).toBe('aborted');
    expect(run.abortReason).toMatch(/10% limit/);
    for (const u of users) expect(await statusOf(u.id)).toBe('active');
  });

  test('the last active super admin is never suspended, however absent they look', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const admin = await makeSsoUser({ externalId: 'dir-2', role: 'super_admin' });
    const keeper = await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync();

    const run = await directorySyncService.runSync(sync, {
      adapter: fakeAdapter([{ externalId: 'dir-1', email: keeper.email, enabled: true }]),
    });

    expect(run.suspended).toBe(0);
    expect(run.skipped).toBe(1);
    expect(await statusOf(admin.id)).toBe('active');
    const finding = await prisma.directorySyncFinding.findFirst({ where: { userId: admin.id } });
    expect(finding.outcome).toMatch(/last active super admin/);
  });

  test('an aborted run notifies the admins rather than failing silently', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    // `settings.sso` is super-admin by default, and it is the permission that
    // gates this feature — so it is super admins who get told, not every admin.
    const saRole = await prisma.role.findFirst({ where: { orgId: org.id, key: 'super_admin' } });
    await createTestUser(org.id, { role: 'super_admin', data: { roleId: saRole.id } });
    await makeSsoUser({ externalId: 'dir-1' });
    const sync = await makeSync();

    await directorySyncService.runSync(sync, { adapter: fakeAdapter([]) });

    const notes = await prisma.notification.findMany({ where: { orgId: org.id, type: 'DIRECTORY_SYNC' } });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].body).toMatch(/no users at all/);
  });

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  test('a provider with no directory API is refused, not silently accepted', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const generic = await prisma.ssoConfig.create({
      data: {
        orgId: org.id,
        provider: 'oidc',
        presetId: 'generic',
        name: 'Generic',
        clientId: 'c',
        issuerUrl: 'https://idp.test',
        redirectUri: 'https://shellius.test/cb',
      },
    });
    await expect(
      directorySyncService.create(org.id, { ssoConfigId: generic.id, config: {} })
    ).rejects.toThrow(/not available/);
    await prisma.ssoConfig.delete({ where: { id: generic.id } });
  });

  test('a secret survives an update that does not resend it, and never comes back out', async () => {
    if (!(await dbReachable())) return console.warn('[skip] DB unreachable');
    const sync = await directorySyncService.create(org.id, {
      ssoConfigId: ssoConfig.id,
      config: { domain: 'acme.okta.com', apiToken: 'super-secret' },
    });

    const updated = await directorySyncService.update(org.id, sync.id, { config: { domain: 'acme2.okta.com' } });
    const publicView = directorySyncService.toPublic(updated);

    expect(publicView.config.domain).toBe('acme2.okta.com');
    expect(publicView.config.apiToken).toEqual({ set: true });
    expect(JSON.stringify(publicView)).not.toContain('super-secret');
  });
});
