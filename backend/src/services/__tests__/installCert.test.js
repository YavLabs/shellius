/**
 * installCertService — the certificate that lets a bootstrapped host be
 * installed on with no stored secret.
 *
 * The invariant these tests exist for is easy to lose and expensive to lose
 * silently: signing the certificate is NOT enough. A bootstrapped host runs
 * check-principals as sshd's AuthorizedPrincipalsCommand, which calls
 * certificateService.verify(), which looks the serial up in the database and
 * requires `issuedForId` to be that host. A cert signed without a persisted,
 * bound row is rejected at the door — and the only symptom is a permission
 * denied that looks like a broken password.
 *
 * So: the row exists, it is bound to the right server, it is short, it is
 * narrow, and it is revoked when the install is over.
 */

import prisma from '../../config/db.js';
import { mintInstallCertificate, revokeInstallCertificate } from '../installCertService.js';
import { generateCaKeyPair } from '../caService.js';
import { verify } from '../certificateService.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq += 1)}${Math.random().toString(36).slice(2, 6)}`;

describe('installCertService (DB)', () => {
  let org;
  let server;
  let otherServer;

  beforeAll(async () => {
    if (!(await dbReachable())) return;
    org = await createTestOrg();
    await generateCaKeyPair(org.id, 'test-ca');
    const customer = await prisma.customer.create({
      data: { orgId: org.id, name: `cust-${uniq()}`, slug: `c-${uniq()}` },
    });
    const mk = () =>
      prisma.server.create({
        data: {
          orgId: org.id,
          customerId: customer.id,
          hostname: `${uniq()}.example.com`,
          ipAddress: '10.0.0.7',
          sshUser: 'ubuntu',
          provisionStatus: 'provisioned',
        },
      });
    server = await mk();
    otherServer = await mk();
  });

  afterAll(async () => {
    if (!org) return;
    await prisma.certificate.deleteMany({ where: { orgId: org.id } });
    await prisma.server.deleteMany({ where: { orgId: org.id } });
    await prisma.customer.deleteMany({ where: { orgId: org.id } });
    await prisma.caKeyPair.deleteMany({ where: { orgId: org.id } });
    await cleanupOrg(org.id);
  });

  it('persists the certificate and binds it to the server it was minted for', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const cert = await mintInstallCertificate({ orgId: org.id, server, principal: 'ubuntu' });
    try {
      const row = await prisma.certificate.findFirst({ where: { id: cert.certId } });
      expect(row).toBeTruthy();
      expect(row.issuedForId).toBe(server.id);
      expect(row.principals).toEqual(['ubuntu']);
      expect(row.issuedVia).toBe('install');
      expect(row.status).toBe('ACTIVE');
      // Returned material is a usable pair, and the key never went to disk
      // anywhere we left it.
      expect(cert.privateKey).toContain('PRIVATE KEY');
      expect(cert.certificate).toContain('-cert-v01@openssh.com');
    } finally {
      await cert.dispose();
    }
  });

  it('is accepted by the same check the host performs on login', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const cert = await mintInstallCertificate({ orgId: org.id, server, principal: 'ubuntu' });
    try {
      const row = await prisma.certificate.findUnique({ where: { id: cert.certId } });
      const result = await verify({
        serial: row.serial.toString(),
        principal: 'ubuntu',
        agentServer: { id: server.id, orgId: org.id },
      });
      expect(result.valid).toBe(true);
    } finally {
      await cert.dispose();
    }
  });

  it('is refused on any other host, exactly like every other certificate', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const cert = await mintInstallCertificate({ orgId: org.id, server, principal: 'ubuntu' });
    try {
      const row = await prisma.certificate.findUnique({ where: { id: cert.certId } });
      const result = await verify({
        serial: row.serial.toString(),
        principal: 'ubuntu',
        agentServer: { id: otherServer.id, orgId: org.id },
      });
      expect(result.valid).toBe(false);
    } finally {
      await cert.dispose();
    }
  });

  it('lasts five minutes, not a session', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const cert = await mintInstallCertificate({ orgId: org.id, server, principal: 'ubuntu' });
    try {
      const row = await prisma.certificate.findUnique({ where: { id: cert.certId } });
      const seconds = (row.validBefore.getTime() - row.validAfter.getTime()) / 1000;
      expect(seconds).toBeLessThanOrEqual(300);
      // permit-pty only: the installer runs over an exec channel with a pty.
      // No port forwarding, no agent forwarding, no X11.
      expect(Object.keys(row.extensions || {})).toEqual(['permit-pty']);
    } finally {
      await cert.dispose();
    }
  });

  it('closes the window as soon as the install is over', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    const cert = await mintInstallCertificate({ orgId: org.id, server, principal: 'ubuntu' });
    await cert.dispose();
    const row = await prisma.certificate.findUnique({ where: { id: cert.certId } });
    expect(row.status).toBe('REVOKED');
    expect(row.revokedAt).toBeTruthy();
    // And the host would now refuse it.
    const result = await verify({
      serial: row.serial.toString(),
      principal: 'ubuntu',
      agentServer: { id: server.id, orgId: org.id },
    });
    expect(result.valid).toBe(false);
  });

  it('never throws when revoking something that is already gone', async () => {
    if (!(await dbReachable())) return console.warn('DB unreachable — skipping');
    await expect(revokeInstallCertificate('does-not-exist')).resolves.toBeUndefined();
    await expect(revokeInstallCertificate(null)).resolves.toBeUndefined();
  });
});
