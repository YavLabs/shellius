/**
 * postureExport.test.js — exporting findings/listeners, and per-server
 * expected-public ports.
 *
 * The properties worth pinning:
 *   - customer scope is enforced on the rows that LEAVE the system. An export
 *     is the highest-leverage place for a scope bug to matter, because the
 *     file outlives the access check.
 *   - field selection narrows and never widens: an unknown field name is
 *     dropped, not turned into a column, so a stale client cannot smuggle
 *     data into the output.
 *   - CSV injection is neutralised. Finding text carries process names read
 *     off a host, so a cell beginning `=` is reachable by an attacker.
 *   - declaring a port expected resolves its findings immediately, and does
 *     so for that server only.
 *
 * DB tests use the dbReachable() skip pattern (see testDbHelper.js).
 */

import prisma from '../../config/db.js';
import * as postureExportService from '../postureExportService.js';
import * as postureExpectedPortService from '../postureExpectedPortService.js';
import { computeFindings } from '../postureService.js';
import { UNSCOPED } from '../../lib/scope.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

let seq = 0;
const unique = () => `${Date.now().toString(36)}${(seq += 1)}${Math.random().toString(36).slice(2, 6)}`;

const scopedTo = (customerIds) => ({ mode: 'customers', customerIds });

describe('field catalogue', () => {
  it('exposes both datasets and rejects anything else', () => {
    expect(postureExportService.fieldCatalogue('findings').map((f) => f.key)).toContain('severity');
    expect(postureExportService.fieldCatalogue('listeners').map((f) => f.key)).toContain('reachability');
    expect(() => postureExportService.fieldCatalogue('secrets')).toThrow(/Unknown dataset/);
  });
});

describe('per-server expected ports feed the analyzer', () => {
  const snapshot = {
    firewall: { engine: 'ufw', active: false, defaultIncoming: 'deny', rules: [] },
    listeners: [
      {
        proto: 'tcp',
        bind: '0.0.0.0',
        port: 8501,
        ownerKind: 'pm2',
        ownerName: 'demo-app',
        ownerRef: '#7',
        source: 'ss',
      },
    ],
  };

  it('reports an undeclared wildcard port as exposed', () => {
    const { findings } = computeFindings(snapshot, { expectedPublicPorts: [] });
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('PORT_EXPOSED');
    expect(codes).not.toContain('EXPECTED_PUBLIC');
  });

  it('downgrades it once the server declares the port expected', () => {
    const { findings } = computeFindings(snapshot, {
      expectedPublicPorts: [],
      serverExpectedPorts: [{ port: 8501, proto: 'tcp', note: 'public demo' }],
    });
    const expected = findings.find((f) => f.code === 'EXPECTED_PUBLIC');
    expect(expected).toBeDefined();
    expect(expected.severity).toBe('INFO');
    expect(findings.map((f) => f.code)).not.toContain('PORT_EXPOSED');
    // The finding says WHICH list matched, so "why is this quiet" is answerable.
    expect(expected.detail.matchedBy).toBe('server');
  });

  it("a proto of 'any' covers either protocol", () => {
    const { findings } = computeFindings(snapshot, {
      serverExpectedPorts: [{ port: 8501, proto: 'any', note: 'both' }],
    });
    expect(findings.map((f) => f.code)).toContain('EXPECTED_PUBLIC');
  });

  it('a declaration for the other protocol does not match', () => {
    const { findings } = computeFindings(snapshot, {
      serverExpectedPorts: [{ port: 8501, proto: 'udp', note: 'wrong proto' }],
    });
    expect(findings.map((f) => f.code)).toContain('PORT_EXPOSED');
  });
});

// ---------------------------------------------------------------------------
// Needs Postgres
// ---------------------------------------------------------------------------

describe('export + expected ports (DB)', () => {
  let org;
  let customerA;
  let customerB;
  let serverA;
  let serverB;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customerA = await prisma.customer.create({
      data: { orgId: org.id, name: 'Acme', slug: `acme-${unique()}` },
    });
    customerB = await prisma.customer.create({
      data: { orgId: org.id, name: 'Beta', slug: `beta-${unique()}` },
    });
    serverA = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customerA.id,
        hostname: `a-${unique()}.example.com`,
        ipAddress: '10.1.0.1',
        environment: 'prod',
      },
    });
    serverB = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customerB.id,
        hostname: `b-${unique()}.example.com`,
        ipAddress: '10.2.0.1',
        environment: 'dev',
      },
    });

    const mk = (serverId, port, code, severity, message) =>
      prisma.exposureFinding.create({
        data: {
          orgId: org.id,
          serverId,
          code,
          proto: 'tcp',
          port,
          severity,
          message,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
    await mk(serverA.id, 5432, 'SENSITIVE_PORT_EXPOSED', 'CRITICAL', 'PostgreSQL is reachable from any source address.');
    await mk(serverA.id, 8080, 'PORT_EXPOSED', 'HIGH', '=cmd|calc!A1');
    await mk(serverB.id, 9000, 'PORT_EXPOSED', 'HIGH', 'Beta only.');
  });

  afterAll(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.serverExpectedPort.deleteMany({ where: { orgId: org.id } });
    await prisma.exposureFinding.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.postureSettings.deleteMany({ where: { orgId: org.id } });
    await prisma.postureAlertRule.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const build = (overrides) =>
    postureExportService.buildExport({
      orgId: org.id,
      scope: UNSCOPED,
      dataset: 'findings',
      format: 'csv',
      ...overrides,
    });

  it('exports every finding in the org when unscoped', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await build({});
    expect(out.rowCount).toBe(3);
    expect(out.contentType).toBe('text/csv');
    expect(out.filename).toMatch(/^shellius-findings-.*\.csv$/);
  });

  it('never exports a server outside the caller’s customer scope', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await build({ scope: scopedTo([customerA.id]) });
    const text = out.buffer.toString('utf8');
    expect(out.rowCount).toBe(2);
    expect(text).toContain(serverA.hostname);
    expect(text).not.toContain(serverB.hostname);
    expect(text).not.toContain('Beta only.');
  });

  it('honours an explicit serverId filter', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await build({ filters: { serverId: serverB.id } });
    expect(out.rowCount).toBe(1);
  });

  it('narrows to the selected fields and drops unknown ones', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await build({ format: 'json', fields: ['severity', 'port', 'notAField'] });
    const parsed = JSON.parse(out.buffer.toString('utf8'));
    expect(Object.keys(parsed.items[0]).sort()).toEqual(['port', 'severity']);
    expect(Object.keys(parsed.items[0])).not.toContain('notAField');
  });

  it('rejects a selection that names no real field', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    await expect(build({ fields: ['nope'] })).rejects.toThrow(/No valid fields/);
  });

  it('neutralises a spreadsheet formula in a value read off a host', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await build({ fields: ['message'] });
    const text = out.buffer.toString('utf8');
    expect(text).toContain("'=cmd|calc!A1");
    expect(text).not.toMatch(/(^|,|")=cmd/);
  });

  it('produces a real PDF', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await build({ format: 'pdf' });
    expect(out.contentType).toBe('application/pdf');
    expect(out.buffer.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  it('bundles one file per server in a zip', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await build({ bundle: 'zip' });
    expect(out.contentType).toBe('application/zip');
    // Local file headers: "PK\x03\x04" once per entry.
    const entries = out.buffer.toString('latin1').split('PK\u0003\u0004').length - 1;
    expect(entries).toBe(2);
  });

  it('marks a port expected, resolving only that server’s findings', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const result = await postureExpectedPortService.addForServer(
      org.id,
      serverA.id,
      [{ port: 5432, proto: 'tcp', note: 'tunnelled, reviewed' }],
      { actorId: null, scope: UNSCOPED }
    );
    expect(result.added).toBe(1);
    expect(result.resolvedFindings).toBe(1);

    const a = await prisma.exposureFinding.findFirst({ where: { serverId: serverA.id, port: 5432 } });
    const other = await prisma.exposureFinding.findFirst({ where: { serverId: serverB.id, port: 9000 } });
    expect(a.resolvedAt).not.toBeNull();
    expect(other.resolvedAt).toBeNull();
  });

  it('requires a reason', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    await expect(
      postureExpectedPortService.addForServer(org.id, serverA.id, [{ port: 1234, note: '  ' }], { scope: UNSCOPED })
    ).rejects.toThrow(/reason is required/);
  });

  it('is a 404, not a 403, for a server outside the caller’s scope', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    await expect(
      postureExpectedPortService.listForServer(org.id, serverB.id, scopedTo([customerA.id]))
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// Listeners export — delegates to postureInventoryService.listListeners, the
// exact function the Services & ports page calls (docs/plans notes for
// Task 1.7.5). Worth pinning here specifically:
//   - Reachability=CONTAINER exports the container-internal DECLARED ports,
//     the same synthetic rows the page shows — these never exist as their
//     own HostListener row, so a hand-rolled export query never saw them.
//   - `q` matches the same fields the page's search box does, including
//     customer name and IP address.
//   - customer scope holds for the listeners dataset too.
// ---------------------------------------------------------------------------

describe('listeners export (DB)', () => {
  let org;
  let customerA;
  let customerB;
  let serverA;
  let serverB;
  let snapA;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    customerA = await prisma.customer.create({
      data: { orgId: org.id, name: `Acme Corp ${unique()}`, slug: `acme-${unique()}` },
    });
    customerB = await prisma.customer.create({
      data: { orgId: org.id, name: `Beta Inc ${unique()}`, slug: `beta-${unique()}` },
    });
    serverA = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customerA.id,
        hostname: `lst-a-${unique()}.example.com`,
        ipAddress: '10.9.9.1',
        environment: 'prod',
      },
    });
    serverB = await prisma.server.create({
      data: {
        orgId: org.id,
        customerId: customerB.id,
        hostname: `lst-b-${unique()}.example.com`,
        ipAddress: '10.9.9.2',
        environment: 'dev',
      },
    });
    snapA = await prisma.hostSnapshot.create({
      data: { orgId: org.id, serverId: serverA.id, collectedAt: new Date(), receivedAt: new Date() },
    });
    await prisma.hostSnapshot.create({
      data: { orgId: org.id, serverId: serverB.id, collectedAt: new Date(), receivedAt: new Date() },
    });

    // A host-published listener on A.
    await prisma.hostListener.create({
      data: {
        orgId: org.id,
        serverId: serverA.id,
        snapshotId: snapA.id,
        proto: 'tcp',
        bind: '0.0.0.0',
        port: 80,
        bindClass: 'wildcard',
        reachability: 'INTERNET',
        ownerKind: 'docker',
        ownerName: 'nginx',
      },
    });
    // A container-internal declared port — only ever exists via HostService,
    // never as its own HostListener row.
    await prisma.hostService.create({
      data: {
        orgId: org.id,
        serverId: serverA.id,
        snapshotId: snapA.id,
        kind: 'docker',
        name: 'billing-api',
        ref: 'abcdef123456',
        state: 'running',
        running: true,
        ports: [{ port: 9000, proto: 'tcp', bind: 'container' }],
      },
    });
  });

  afterAll(async () => {
    if (!(await dbReachable()) || !org) return;
    await prisma.hostService.deleteMany({ where: { orgId: org.id } });
    await prisma.hostListener.deleteMany({ where: { orgId: org.id } });
    await prisma.hostSnapshot.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  const buildListeners = (overrides) =>
    postureExportService.buildExport({
      orgId: org.id,
      scope: UNSCOPED,
      dataset: 'listeners',
      format: 'json',
      ...overrides,
    });

  it('Reachability=CONTAINER exports the declared container-internal port, not an empty file', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await buildListeners({ filters: { reachability: 'CONTAINER' } });
    const parsed = JSON.parse(out.buffer.toString('utf8'));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].port).toBe(9000);
    expect(parsed.items[0].reachability).toBe('CONTAINER');
  });

  it('`q` matches customer name and IP address, same as the page', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const byCustomer = await buildListeners({ filters: { q: customerA.name } });
    expect(JSON.parse(byCustomer.buffer.toString('utf8')).items.map((r) => r.port)).toContain(80);

    const byIp = await buildListeners({ filters: { q: '10.9.9.1' } });
    expect(JSON.parse(byIp.buffer.toString('utf8')).items.map((r) => r.port)).toContain(80);

    const noMatch = await buildListeners({ filters: { q: '10.9.9.2' } });
    expect(JSON.parse(noMatch.buffer.toString('utf8')).items).toHaveLength(0);
  });

  it('never exports a listener outside the caller’s customer scope', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await buildListeners({ scope: scopedTo([customerB.id]) });
    const parsed = JSON.parse(out.buffer.toString('utf8'));
    expect(parsed.items).toHaveLength(0);
  });

  it('never exports a listener for an out-of-scope serverId filter', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await buildListeners({
      scope: scopedTo([customerB.id]),
      filters: { serverId: serverA.id },
    });
    const parsed = JSON.parse(out.buffer.toString('utf8'));
    expect(parsed.items).toHaveLength(0);
  });

  it('honours the `state` filter (running only)', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const out = await buildListeners({ filters: { state: 'exposed' } });
    const parsed = JSON.parse(out.buffer.toString('utf8'));
    expect(parsed.items.every((r) => r.reachability !== 'CONTAINER')).toBe(true);
    expect(parsed.items.map((r) => r.port)).toContain(80);
  });
});
