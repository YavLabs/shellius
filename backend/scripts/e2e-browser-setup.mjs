/**
 * e2e-browser-setup.mjs — provision what the Playwright suite needs, without
 * ever putting a credential somewhere a person or a log can see it.
 *
 *   node backend/scripts/e2e-browser-setup.mjs
 *
 * Creates (idempotently) a dedicated end-to-end user in the local org, gives
 * it a freshly generated random password, and grants it an APPROVED RDP
 * access request to the RDP host. The password is written to
 * `frontend/e2e/.auth.json`, 0600 and gitignored — it is NEVER printed, never
 * passed on a command line, and never reused from a real account.
 *
 * That matters more than it might look: a browser test needs to type a
 * password, so the password has to exist somewhere the test can read. Reusing
 * the real administrator's would put it in a config file and in any CI log
 * that echoes its environment. A throwaway account that is recreated on every
 * run has neither problem, and it can be deleted with `--teardown` without
 * touching anything real.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import prisma from '../src/config/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.resolve(__dirname, '..', '..', 'frontend', 'e2e', '.auth.json');

const EMAIL = 'e2e-rdp@shellius.test';
const TEARDOWN = process.argv.includes('--teardown');

async function teardown() {
  const user = await prisma.user.findFirst({ where: { email: EMAIL } });
  if (user) {
    await prisma.accessRequest.deleteMany({ where: { requesterId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    console.log('removed the end-to-end user and its access requests');
  } else {
    console.log('nothing to remove');
  }
  await fs.promises.rm(AUTH_FILE, { force: true });
  process.exit(0);
}

if (TEARDOWN) await teardown();

const org = await prisma.organization.findFirst({
  where: { name: 'Shellius Local' },
  select: { id: true },
});
if (!org) {
  console.error('no "Shellius Local" organization — is this the dev database?');
  process.exit(1);
}

const server = await prisma.server.findFirst({
  where: { orgId: org.id, hostname: { contains: 'win-rdp-5' } },
  select: { id: true, hostname: true, rdpUsername: true },
});
if (!server) {
  console.error('no win-rdp-5 server in this org — the RDP tests need a real RDP target');
  process.exit(1);
}

// A role that can request and connect. Reusing an existing role rather than
// inventing one keeps the test honest about what a normal user can do.
const role = await prisma.role.findFirst({
  where: { orgId: org.id, baseRole: 'admin' },
  select: { id: true },
});

// 32 bytes of randomness, regenerated every run. Nothing derives it, nothing
// else uses it, and it is gone on --teardown.
const password = crypto.randomBytes(24).toString('base64url');
const passwordHash = await bcrypt.hash(password, 10);

// Email is unique per ORG, not globally (`orgId_email`) — Shellius is
// multi-tenant, so the same person can exist in two organizations.
const user = await prisma.user.upsert({
  where: { orgId_email: { orgId: org.id, email: EMAIL } },
  update: { passwordHash, status: 'active', roleId: role?.id ?? undefined },
  create: {
    orgId: org.id,
    email: EMAIL,
    name: 'End-to-end RDP',
    passwordHash,
    role: 'admin',
    roleId: role?.id ?? undefined,
    status: 'active',
  },
  select: { id: true, email: true },
});

// One APPROVED, unexpired RDP request. Created directly rather than through
// the approval flow because the flow is not what these tests are about.
await prisma.accessRequest.deleteMany({ where: { requesterId: user.id, serverId: server.id } });
const request = await prisma.accessRequest.create({
  data: {
    orgId: org.id,
    requesterId: user.id,
    serverId: server.id,
    status: 'APPROVED',
    protocol: 'RDP',
    reason: 'Automated browser verification of the RDP client',
    requestedPrincipal: server.rdpUsername || 'yavadmin',
    requestedDuration: 3600,
    approvedDuration: 3600,
    approvedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  },
  select: { id: true },
});

await fs.promises.mkdir(path.dirname(AUTH_FILE), { recursive: true });
await fs.promises.writeFile(
  AUTH_FILE,
  JSON.stringify({ email: EMAIL, password, requestId: request.id, serverId: server.id }, null, 2),
  { mode: 0o600 }
);

console.log('e2e user      :', user.email);
console.log('rdp host      :', server.hostname);
console.log('access request:', request.id, '(APPROVED, 1h)');
console.log('credentials   : frontend/e2e/.auth.json (0600, gitignored, password not shown)');
process.exit(0);
