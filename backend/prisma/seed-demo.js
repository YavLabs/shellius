/**
 * seed-demo.js — idempotent demo dataset for exercising the UI (lists,
 * filters, command-palette search, approvals, keystore, sessions...).
 *
 * Usage:
 *   npm run db:seed:demo             # create/refresh demo data
 *   npm run db:seed:demo -- --reset  # remove exactly the demo rows
 *
 * Never runs automatically (not wired into prisma's `seed` hook or app boot).
 *
 * Scope: targets the org identified by SEED_ORG_SLUG (fallback: the
 * oldest organization in the DB). Never touches the seeded super admin
 * (prisma/seed.js), CA key pairs, or any non-demo row.
 *
 * Tagging / natural keys (so --reset removes exactly what this script
 * created, and re-running without --reset never duplicates rows):
 *   - Customers   : fixed name/slug list (DEMO_CUSTOMERS)
 *   - Users       : email @demo.shellius.local
 *   - Servers     : belong to a demo customer (customerId in demo set)
 *   - Identities  : name prefixed "Demo: " (Credential.name is unique per org)
 *   - Keys        : name prefixed "Demo: " (SshKey.name is unique per org)
 *   - Policies    : name prefixed "Demo: " (only the ones this script adds —
 *                   the baseline policies from defaultSeedService are never
 *                   touched)
 *   - Notifications: title prefixed "Demo: "
 *   - AuditLog    : NEVER deleted on --reset (immutable, per CLAUDE.md) —
 *                   the handful of demo audit entries are left in place.
 *
 * Sessions/AccessRequests/KeyDeployments have no natural key of their own;
 * they're scoped to demo users/servers/keys, so removing those removes them
 * (FK cascade) — and this script skips re-creating that historical/one-shot
 * data on a non-reset re-run (detected via an existing demo access request).
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

import * as keystoreService from '../src/services/keystoreService.js';
import * as notificationService from '../src/services/notificationService.js';
import * as auditService from '../src/services/auditService.js';

const prisma = new PrismaClient();

const RESET = process.argv.includes('--reset');
const DEMO_EMAIL_DOMAIN = '@demo.shellius.local';
const DEMO_PREFIX = 'Demo: ';
const DEMO_PASSWORD = (process.env.DEMO_USER_PASSWORD || 'DemoPass-2026!').trim();

function log(msg) {
  console.log(`[seed-demo] ${msg}`);
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000);
}
function hoursFromNow(n) {
  return new Date(Date.now() + n * 3600 * 1000);
}
function hoursAgo(n) {
  return new Date(Date.now() - n * 3600 * 1000);
}

// ---------------------------------------------------------------------------
// Fixed natural-key datasets
// ---------------------------------------------------------------------------

const DEMO_CUSTOMERS = [
  { name: 'Acme Corp', slug: 'acme-corp', description: 'Global logistics and shipping.' },
  { name: 'Globex Corporation', slug: 'globex-corporation', description: 'Enterprise fintech platform.' },
  { name: 'Initech', slug: 'initech', description: 'Internal tooling and consulting.' },
  { name: 'Umbrella Corp', slug: 'umbrella-corp', description: 'Biotech research division.' },
  { name: 'Stark Industries', slug: 'stark-industries', description: 'Advanced hardware R&D.' },
  { name: 'Wayne Enterprises', slug: 'wayne-enterprises', description: 'Applied sciences and infrastructure.' },
];

const DEMO_USERS = [
  { email: `sarah.chen${DEMO_EMAIL_DOMAIN}`, name: 'Sarah Chen', role: 'admin', status: 'active', manager: null },
  { email: `marcus.rivera${DEMO_EMAIL_DOMAIN}`, name: 'Marcus Rivera', role: 'manager', status: 'active', manager: 'sarah.chen' },
  { email: `priya.patel${DEMO_EMAIL_DOMAIN}`, name: 'Priya Patel', role: 'manager', status: 'active', manager: 'sarah.chen' },
  { email: `noah.fischer${DEMO_EMAIL_DOMAIN}`, name: 'Noah Fischer', role: 'manager', status: 'active', manager: 'sarah.chen' },
  { email: `james.oconnor${DEMO_EMAIL_DOMAIN}`, name: "James O'Connor", role: 'member', status: 'active', manager: 'marcus.rivera' },
  { email: `lena.novak${DEMO_EMAIL_DOMAIN}`, name: 'Lena Novak', role: 'member', status: 'active', manager: 'marcus.rivera' },
  { email: `daniel.kim${DEMO_EMAIL_DOMAIN}`, name: 'Daniel Kim', role: 'member', status: 'active', manager: 'priya.patel' },
  { email: `fatima.alsayed${DEMO_EMAIL_DOMAIN}`, name: 'Fatima Al-Sayed', role: 'member', status: 'active', manager: 'priya.patel' },
  { email: `tom.becker${DEMO_EMAIL_DOMAIN}`, name: 'Tom Becker', role: 'member', status: 'suspended', manager: 'marcus.rivera' },
  { email: `olivia.wright${DEMO_EMAIL_DOMAIN}`, name: 'Olivia Wright', role: 'member', status: 'invited', manager: 'priya.patel' },
];

const DEMO_IDENTITIES = [
  { name: `${DEMO_PREFIX}SSH Test User`, username: 'testuser', authType: 'password', password: 'testpass123' },
  { name: `${DEMO_PREFIX}Acme Web Deploy`, username: 'deploy', authType: 'password', password: 'DeployPass-2026!' },
  { name: `${DEMO_PREFIX}Globex DB Admin`, username: 'dbadmin', authType: 'key_password', password: 'DbAdminPass-2026!', newKey: { generate: true, keyType: 'rsa', bits: 3072 } },
  { name: `${DEMO_PREFIX}Initech Ops`, username: 'opsuser', authType: 'password', password: 'OpsPass-2026!' },
  { name: `${DEMO_PREFIX}Stark Root Access`, username: 'root', authType: 'key', newKey: { generate: true, keyType: 'ed25519' } },
  { name: `${DEMO_PREFIX}Wayne Automation`, username: 'automation', authType: 'key', newKey: { generate: true, keyType: 'ecdsa', bits: 256 } },
];

const DEMO_STANDALONE_KEYS = [
  { name: `${DEMO_PREFIX}Backup Signing Key`, keyType: 'ed25519' },
  { name: `${DEMO_PREFIX}Legacy Ops Key`, keyType: 'rsa', bits: 2048 },
];

const DEMO_POLICIES = [
  {
    name: `${DEMO_PREFIX}Staging Requires Approval`,
    description: 'Staging is self-serve requestable but every request needs manager sign-off.',
    effect: 'ALLOW',
    targetEnvironments: ['staging'],
    allowedPrincipals: ['ubuntu', 'admin'],
    maxSessionDuration: 4 * 3600,
    requireApproval: true,
    autoApprove: false,
    priority: 60,
    subjectGroup: 'Developers',
  },
  {
    name: `${DEMO_PREFIX}Deny Legacy Database Hosts`,
    description: 'Blocks self-serve developers from directly accessing legacy production database hosts.',
    effect: 'DENY',
    targetEnvironments: ['prod'],
    allowedPrincipals: [],
    maxSessionDuration: 3600,
    priority: 5,
    subjectGroup: 'Developers',
  },
];

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

async function resetDemoData(orgId) {
  const customers = await prisma.customer.findMany({
    where: { orgId, slug: { in: DEMO_CUSTOMERS.map((c) => c.slug) } },
    select: { id: true },
  });
  const customerIds = customers.map((c) => c.id);

  const users = await prisma.user.findMany({
    where: { orgId, email: { endsWith: DEMO_EMAIL_DOMAIN } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);

  const keys = await prisma.sshKey.findMany({
    where: { orgId, name: { startsWith: DEMO_PREFIX } },
    select: { id: true },
  });
  const keyIds = keys.map((k) => k.id);

  const credentials = await prisma.credential.findMany({
    where: { orgId, name: { startsWith: DEMO_PREFIX } },
    select: { id: true },
  });
  const credentialIds = credentials.map((c) => c.id);

  const servers = await prisma.server.findMany({
    where: { orgId, customerId: { in: customerIds } },
    select: { id: true },
  });
  const serverIds = servers.map((s) => s.id);

  const policies = await prisma.accessPolicy.findMany({
    where: { orgId, name: { startsWith: DEMO_PREFIX } },
    select: { id: true },
  });
  const policyIds = policies.map((p) => p.id);

  const del = async (label, fn) => {
    const { count } = await fn();
    if (count) log(`reset: removed ${count} ${label}`);
  };

  // Never touches AuditLog — immutable, and demo entries are left in place.
  await del('notifications', () =>
    prisma.notification.deleteMany({ where: { orgId, title: { startsWith: DEMO_PREFIX } } }));
  await del('sessions', () =>
    prisma.session.deleteMany({ where: { orgId, userId: { in: userIds } } }));
  await del('access requests', () =>
    prisma.accessRequest.deleteMany({ where: { orgId, requesterId: { in: userIds } } }));
  await del('key deployments', () =>
    prisma.keyDeployment.deleteMany({ where: { orgId, sshKeyId: { in: keyIds } } }));
  await del('servers', () =>
    prisma.server.deleteMany({ where: { id: { in: serverIds } } }));
  await del('identities', () =>
    prisma.credential.deleteMany({ where: { id: { in: credentialIds } } }));
  await del('keys', () =>
    prisma.sshKey.deleteMany({ where: { id: { in: keyIds } } }));
  await del('users', () =>
    prisma.user.deleteMany({ where: { id: { in: userIds } } }));
  await del('customers', () =>
    prisma.customer.deleteMany({ where: { id: { in: customerIds } } }));
  await del('policies', () =>
    prisma.accessPolicy.deleteMany({ where: { id: { in: policyIds } } }));

  log('reset complete');
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function resolveOrg() {
  const slug = (process.env.SEED_ORG_SLUG || '').trim();
  let org = slug ? await prisma.organization.findUnique({ where: { slug } }) : null;
  if (!org) org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('No organization found — run `npm run db:seed` first.');
  return org;
}

async function upsertCustomers(orgId) {
  const bySlug = {};
  for (const c of DEMO_CUSTOMERS) {
    const customer = await prisma.customer.upsert({
      where: { orgId_slug: { orgId, slug: c.slug } },
      update: {},
      create: { orgId, name: c.name, slug: c.slug, description: c.description },
    });
    bySlug[c.slug] = customer;
  }
  return bySlug;
}

async function upsertUsers(orgId) {
  const byLocalPart = {};
  for (const u of DEMO_USERS) {
    const localPart = u.email.split('@')[0];
    const existing = await prisma.user.findUnique({ where: { orgId_email: { orgId, email: u.email } } });
    if (existing) {
      byLocalPart[localPart] = existing;
      continue;
    }
    const passwordHash = u.status === 'invited' ? null : await bcrypt.hash(DEMO_PASSWORD, 10);
    const created = await prisma.user.create({
      data: { orgId, email: u.email, name: u.name, role: u.role, status: u.status, passwordHash },
    });
    byLocalPart[localPart] = created;
  }
  // Second pass: wire up managerId now that all users exist.
  for (const u of DEMO_USERS) {
    if (!u.manager) continue;
    const localPart = u.email.split('@')[0];
    const user = byLocalPart[localPart];
    const manager = byLocalPart[u.manager];
    if (user && manager && user.managerId !== manager.id) {
      await prisma.user.update({ where: { id: user.id }, data: { managerId: manager.id } });
    }
  }
  return byLocalPart;
}

async function addGroupMemberships(orgId, usersByLocalPart) {
  const groups = await prisma.group.findMany({ where: { orgId, name: { in: ['Admin', 'Managers', 'Approvers', 'Developers'] } } });
  const groupByName = Object.fromEntries(groups.map((g) => [g.name, g]));
  if (Object.keys(groupByName).length === 0) {
    log('WARNING: baseline groups not found — run `npm run db:seed` (or let the boot job run) first for memberships to take effect');
    return;
  }

  const memberships = [
    ['sarah.chen', 'Admin'],
    ['marcus.rivera', 'Managers'],
    ['priya.patel', 'Managers'],
    ['priya.patel', 'Approvers'],
    ['noah.fischer', 'Managers'],
    ['james.oconnor', 'Developers'],
    ['lena.novak', 'Developers'],
    ['daniel.kim', 'Developers'],
    ['fatima.alsayed', 'Developers'],
    ['tom.becker', 'Developers'],
  ];
  for (const [localPart, groupName] of memberships) {
    const user = usersByLocalPart[localPart];
    const group = groupByName[groupName];
    if (!user || !group) continue;
    await prisma.groupMembership.upsert({
      where: { groupId_userId: { groupId: group.id, userId: user.id } },
      update: {},
      create: { groupId: group.id, userId: user.id },
    });
  }
}

async function upsertIdentities(orgId, adminId) {
  const byName = {};
  for (const spec of DEMO_IDENTITIES) {
    const existing = await prisma.credential.findUnique({ where: { orgId_name: { orgId, name: spec.name } } });
    if (existing) {
      byName[spec.name] = existing;
      continue;
    }
    const { credential } = await keystoreService.createCredential(
      orgId,
      {
        name: spec.name,
        username: spec.username,
        authType: spec.authType,
        password: spec.password,
        newKey: spec.newKey,
      },
      adminId,
    );
    byName[spec.name] = credential;
  }
  return byName;
}

async function upsertStandaloneKeys(orgId, adminId) {
  const byName = {};
  for (const spec of DEMO_STANDALONE_KEYS) {
    const existing = await prisma.sshKey.findUnique({ where: { orgId_name: { orgId, name: spec.name } } });
    if (existing) {
      byName[spec.name] = existing;
      continue;
    }
    const { key } = await keystoreService.generateKey(
      orgId,
      { name: spec.name, keyType: spec.keyType, bits: spec.bits },
      adminId,
    );
    byName[spec.name] = key;
  }
  return byName;
}

async function upsertPolicies(orgId) {
  const groups = await prisma.group.findMany({ where: { orgId, name: { in: ['Developers'] } } });
  const developersGroup = groups.find((g) => g.name === 'Developers');
  const createdIds = [];
  for (const spec of DEMO_POLICIES) {
    const existing = await prisma.accessPolicy.findFirst({ where: { orgId, name: spec.name } });
    if (existing) {
      createdIds.push(existing.id);
      continue;
    }
    const policy = await prisma.accessPolicy.create({
      data: {
        orgId,
        name: spec.name,
        description: spec.description,
        effect: spec.effect,
        targetEnvironments: spec.targetEnvironments,
        targetLabels: {},
        targetServerIds: [],
        allowedPrincipals: spec.allowedPrincipals,
        maxSessionDuration: spec.maxSessionDuration,
        requireApproval: !!spec.requireApproval,
        autoApprove: !!spec.autoApprove,
        priority: spec.priority,
        ...(developersGroup
          ? { subjects: { create: [{ subjectType: 'GROUP', subjectId: developersGroup.id }] } }
          : {}),
      },
    });
    createdIds.push(policy.id);
  }
  return createdIds;
}

const ROLE_TAGS = ['web', 'api', 'db', 'cache', 'worker', 'bastion'];
const ENVS = ['demo', 'dev', 'staging', 'prod'];
const PROTOCOLS = ['ssh', 'rdp', 'both'];
const CLOUDS = [null, 'aws', 'azure', 'gcp'];
const CLOUD_REGIONS = { aws: 'us-east-1', azure: 'eastus', gcp: 'us-central1' };
const HEALTHS = ['healthy', 'unhealthy', 'unknown', 'maintenance'];
const PROVISION_STATUSES = ['provisioned', 'pending', 'failed'];

function buildServerSpecs(customersBySlug, credentialsByName) {
  const customerSlugs = DEMO_CUSTOMERS.map((c) => c.slug);
  const credentialCycle = [
    `${DEMO_PREFIX}Acme Web Deploy`,
    `${DEMO_PREFIX}Globex DB Admin`,
    `${DEMO_PREFIX}Initech Ops`,
  ];
  const specs = [];
  for (let i = 0; i < 30; i++) {
    const customer = customersBySlug[customerSlugs[i % customerSlugs.length]];
    const roleTag = ROLE_TAGS[i % ROLE_TAGS.length];
    const environment = ENVS[i % ENVS.length];
    const protocol = PROTOCOLS[i % PROTOCOLS.length];
    const osType = protocol === 'rdp' ? 'windows' : (i % 5 === 0 ? 'windows' : 'linux');
    const cloudProvider = CLOUDS[i % CLOUDS.length];
    const healthStatus = HEALTHS[i % HEALTHS.length];
    const provisionStatus = PROVISION_STATUSES[i % PROVISION_STATUSES.length];
    const authMode = i % 4 === 3 ? 'credential' : 'certificate';
    const credentialName = authMode === 'credential' ? credentialCycle[i % credentialCycle.length] : null;

    specs.push({
      customerId: customer.id,
      hostname: `${roleTag}-${String(i + 1).padStart(2, '0')}.${customer.slug}.internal`,
      displayName: null,
      description: `${roleTag} host for ${customer.name}`,
      ipAddress: `10.${40 + (i % 6)}.${Math.floor(i / 6)}.${10 + i}`,
      port: protocol === 'rdp' ? 3389 : 22,
      protocol,
      environment,
      labels: ['demo', environment, roleTag],
      osType,
      osVersion: osType === 'windows' ? 'Windows Server 2022' : 'Ubuntu 22.04 LTS',
      cloudProvider,
      cloudRegion: cloudProvider ? CLOUD_REGIONS[cloudProvider] : null,
      healthStatus,
      lastHealthCheck: hoursAgo((i % 12) + 1),
      authMode,
      credentialId: credentialName ? credentialsByName[credentialName]?.id ?? null : null,
      provisionStatus,
      provisionError: provisionStatus === 'failed' ? 'Bootstrap script timed out waiting for SSH banner' : null,
      provisionedAt: provisionStatus === 'provisioned' ? daysAgo((i % 20) + 1) : null,
      agentId: provisionStatus === 'provisioned' && i % 2 === 0 ? `agent-demo-${i + 1}` : null,
      agentLastSeen: provisionStatus === 'provisioned' && i % 2 === 0 ? hoursAgo((i % 6) + 1) : null,
    });
  }
  return specs;
}

async function upsertServers(orgId, specs) {
  const created = [];
  for (const spec of specs) {
    const existing = await prisma.server.findFirst({ where: { orgId, hostname: spec.hostname } });
    if (existing) {
      created.push(existing);
      continue;
    }
    const server = await prisma.server.create({ data: { orgId, ...spec } });
    created.push(server);
  }
  return created;
}

async function upsertSshTestServer(orgId, customersBySlug, credentialsByName) {
  const hostname = 'sshtest.local';
  const existing = await prisma.server.findFirst({ where: { orgId, hostname } });
  if (existing) return existing;
  const testCred = credentialsByName[`${DEMO_PREFIX}SSH Test User`];
  return prisma.server.create({
    data: {
      orgId,
      customerId: customersBySlug['acme-corp'].id,
      hostname,
      displayName: 'SSH Test Container (local)',
      description: 'Real reachable target for connect/quick-connect testing. Requires the '
        + 'shellius-sshtest docker container and SSH_TARGET_ALLOW_LOOPBACK=true.',
      ipAddress: '127.0.0.1',
      port: 52222,
      protocol: 'ssh',
      environment: 'dev',
      osType: 'linux',
      labels: ['demo', 'dev', 'sshtest'],
      authMode: 'credential',
      credentialId: testCred?.id ?? null,
      provisionStatus: 'provisioned',
      provisionedAt: new Date(),
      healthStatus: 'healthy',
    },
  });
}

async function attachDenyPolicyTarget(orgId) {
  const policy = await prisma.accessPolicy.findFirst({
    where: { orgId, name: `${DEMO_PREFIX}Deny Legacy Database Hosts` },
  });
  if (!policy || policy.targetServerIds.length > 0) return;
  const dbServer = await prisma.server.findFirst({
    where: { orgId, environment: 'prod', hostname: { startsWith: 'db-' } },
  });
  const fallback = dbServer || (await prisma.server.findFirst({ where: { orgId, environment: 'prod' } }));
  if (fallback) {
    await prisma.accessPolicy.update({ where: { id: policy.id }, data: { targetServerIds: [fallback.id] } });
  }
}

async function seedKeyDeployments(orgId, keysByName, servers, adminId) {
  const existing = await prisma.keyDeployment.findFirst({ where: { orgId } });
  if (existing) return;

  const key = keysByName[`${DEMO_PREFIX}Backup Signing Key`];
  const legacyKey = keysByName[`${DEMO_PREFIX}Legacy Ops Key`];
  if (!key || servers.length < 3) return;

  const batchId = `demo-batch-${Date.now().toString(36)}`;
  const rows = [
    { sshKeyId: key.id, serverId: servers[0].id, status: 'success', startedAt: hoursAgo(5), finishedAt: hoursAgo(5), output: 'Key deployed to ~/.ssh/authorized_keys' },
    { sshKeyId: key.id, serverId: servers[1].id, status: 'failed', startedAt: hoursAgo(5), finishedAt: hoursAgo(5), error: 'Connection refused (port 22)' },
    { sshKeyId: key.id, serverId: servers[2].id, status: 'pending' },
    { sshKeyId: legacyKey.id, serverId: servers[3]?.id ?? servers[0].id, status: 'success', startedAt: hoursAgo(24), finishedAt: hoursAgo(24), output: 'Rotated legacy key' },
  ];
  for (const row of rows) {
    await prisma.keyDeployment.create({
      data: {
        orgId,
        batchId,
        sshKeyId: row.sshKeyId,
        serverId: row.serverId,
        action: 'deploy',
        targetUser: 'ubuntu',
        authMode: 'certificate',
        status: row.status,
        error: row.error || null,
        output: row.output || null,
        deployedById: adminId,
        startedAt: row.startedAt || null,
        finishedAt: row.finishedAt || null,
      },
    });
  }
  log(`created ${rows.length} key deployments (batch ${batchId})`);
}

async function seedAccessRequestsAndNotifications(orgId, usersByLocalPart, servers) {
  const existing = await prisma.accessRequest.findFirst({
    where: { orgId, requesterId: { in: Object.values(usersByLocalPart).map((u) => u.id) } },
  });
  if (existing) return;

  const prodServers = servers.filter((s) => s.environment === 'prod');
  const devServers = servers.filter((s) => s.environment === 'dev');
  const stagingServers = servers.filter((s) => s.environment === 'staging');
  const pick = (arr, i) => arr[i % Math.max(arr.length, 1)];

  const { james, daniel, lena, fatima, marcus, priya, sarah } = {
    james: usersByLocalPart['james.oconnor'],
    daniel: usersByLocalPart['daniel.kim'],
    lena: usersByLocalPart['lena.novak'],
    fatima: usersByLocalPart['fatima.alsayed'],
    marcus: usersByLocalPart['marcus.rivera'],
    priya: usersByLocalPart['priya.patel'],
    sarah: usersByLocalPart['sarah.chen'],
  };

  const requests = [];

  const pending1 = await prisma.accessRequest.create({
    data: {
      orgId, requesterId: james.id, serverId: pick(prodServers, 0).id, status: 'PENDING',
      reason: 'Investigating elevated 5xx error rate on the checkout service.',
      requestedPrincipal: 'ubuntu', requestedDuration: 7200, protocol: 'SSH',
    },
  });
  requests.push(pending1);
  await prisma.accessRequestApprover.createMany({
    data: [marcus, sarah].map((u) => ({ requestId: pending1.id, userId: u.id })),
    skipDuplicates: true,
  });

  const pending2 = await prisma.accessRequest.create({
    data: {
      orgId, requesterId: daniel.id, serverId: pick(prodServers, 1).id, status: 'PENDING',
      reason: 'Deploying an approved hotfix for the payment gateway timeout bug.',
      requestedPrincipal: 'admin', requestedDuration: 3600, protocol: 'SSH',
    },
  });
  requests.push(pending2);
  await prisma.accessRequestApprover.createMany({
    data: [priya, sarah].map((u) => ({ requestId: pending2.id, userId: u.id })),
    skipDuplicates: true,
  });

  const pending3 = await prisma.accessRequest.create({
    data: {
      orgId, requesterId: fatima.id, serverId: pick(stagingServers, 0).id, status: 'PENDING',
      reason: 'Need to review the nginx config during the staging outage.',
      requestedPrincipal: 'ubuntu', requestedDuration: 3600, protocol: 'SSH',
    },
  });
  requests.push(pending3);
  await prisma.accessRequestApprover.createMany({
    data: [priya].map((u) => ({ requestId: pending3.id, userId: u.id })),
    skipDuplicates: true,
  });

  requests.push(await prisma.accessRequest.create({
    data: {
      orgId, requesterId: lena.id, reviewerId: marcus.id, serverId: pick(devServers, 0).id, status: 'APPROVED',
      reason: 'Routine debugging session for the worker queue backlog.',
      requestedPrincipal: 'ubuntu', requestedDuration: 28800, protocol: 'SSH',
      approvedDuration: 28800, approvedAt: hoursAgo(1), expiresAt: hoursFromNow(7),
    },
  }));

  requests.push(await prisma.accessRequest.create({
    data: {
      orgId, requesterId: fatima.id, reviewerId: priya.id, serverId: pick(stagingServers, 1).id, status: 'DENIED',
      reason: 'Want to poke around the staging DB for a report.',
      requestedPrincipal: 'ubuntu', requestedDuration: 3600, protocol: 'SSH',
      deniedAt: daysAgo(2), deniedReason: 'Insufficient justification for direct staging database access.',
    },
  }));

  requests.push(await prisma.accessRequest.create({
    data: {
      orgId, requesterId: james.id, reviewerId: sarah.id, serverId: pick(prodServers, 2).id, status: 'EXPIRED',
      reason: 'On-call incident response.',
      requestedPrincipal: 'ubuntu', requestedDuration: 3600, protocol: 'SSH',
      approvedDuration: 3600, approvedAt: daysAgo(10), expiresAt: daysAgo(9),
    },
  }));

  requests.push(await prisma.accessRequest.create({
    data: {
      orgId, requesterId: daniel.id, reviewerId: marcus.id, serverId: pick(devServers, 1).id, status: 'REVOKED',
      reason: 'Short-term contractor project access.',
      requestedPrincipal: 'ubuntu', requestedDuration: 14400, protocol: 'SSH',
      approvedDuration: 14400, approvedAt: daysAgo(3), expiresAt: hoursFromNow(72),
      revokedAt: daysAgo(1), revokedReason: 'Contractor engagement ended early.',
    },
  }));

  log(`created ${requests.length} access requests`);

  // Notifications for the org's actual super admin (not a demo user) about
  // the pending prod requests + one expiring-access reminder.
  const realAdmin = await prisma.user.findFirst({ where: { orgId, role: 'super_admin' } });
  if (realAdmin) {
    await notificationService.create({
      orgId, userId: realAdmin.id, type: 'ACCESS_REQUEST_SUBMITTED',
      title: `${DEMO_PREFIX}Production access requested`,
      body: `${james.name} requested SSH access to ${pick(prodServers, 0).hostname}.`,
      metadata: { accessRequestId: pending1.id },
    });
    await notificationService.create({
      orgId, userId: realAdmin.id, type: 'ACCESS_REQUEST_SUBMITTED',
      title: `${DEMO_PREFIX}Production access requested`,
      body: `${daniel.name} requested SSH access to ${pick(prodServers, 1).hostname}.`,
      metadata: { accessRequestId: pending2.id },
    });
    await notificationService.create({
      orgId, userId: realAdmin.id, type: 'ACCESS_REQUEST_EXPIRING',
      title: `${DEMO_PREFIX}Access expiring soon`,
      body: `${lena.name}'s access to ${pick(devServers, 0).hostname} expires in a few hours.`,
      metadata: {},
    });
    log('created 3 notifications for the org super admin');
  } else {
    log('WARNING: no super_admin found in org — skipped demo notifications');
  }

  return requests;
}

async function seedSessions(orgId, usersByLocalPart, servers) {
  const users = Object.values(usersByLocalPart).filter((u) => u.status !== 'invited');
  const existing = await prisma.session.findFirst({ where: { orgId, userId: { in: users.map((u) => u.id) } } });
  if (existing) return 0;

  let count = 0;
  for (let i = 0; i < 25; i++) {
    const user = users[i % users.length];
    const isQuickConnect = i % 5 === 4;
    const startedAt = daysAgo((i % 28) + 1);
    const durationSeconds = 300 + ((i * 53) % 3600);
    const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);
    const status = i % 7 === 0 ? 'TERMINATED' : 'ENDED';

    if (isQuickConnect) {
      const sessionType = i % 2 === 0 ? 'SSH' : 'RDP';
      await prisma.session.create({
        data: {
          orgId, userId: user.id, serverId: null, sessionType,
          authMethod: 'quick_connect',
          targetHost: `10.99.${i}.5`, targetPort: sessionType === 'SSH' ? 22 : 3389, targetUser: 'qcuser',
          status, startedAt, endedAt, durationSeconds,
          clientIp: `203.0.113.${(i % 254) + 1}`,
        },
      });
    } else {
      const server = servers[i % servers.length];
      const sessionType = server.protocol === 'rdp' ? 'RDP' : (server.protocol === 'both' && i % 2 === 0 ? 'RDP' : 'SSH');
      const authMethod = server.authMode === 'credential' ? 'credential' : 'certificate';
      await prisma.session.create({
        data: {
          orgId, userId: user.id, serverId: server.id, sessionType, authMethod,
          status, startedAt, endedAt, durationSeconds,
          clientIp: `203.0.113.${(i % 254) + 1}`,
        },
      });
    }
    count++;
  }
  log(`created ${count} sessions`);
  return count;
}

async function seedAuditLogEntries(orgId, actorId, customersBySlug, servers, policyIds) {
  const first = DEMO_CUSTOMERS[0];
  const firstServer = servers[0];
  await auditService.log({
    orgId, actorId, action: auditService.ACTIONS.customer.create, resourceType: 'Customer',
    resourceId: customersBySlug[first.slug].id, metadata: { name: first.name, demo: true },
  });
  if (firstServer) {
    await auditService.log({
      orgId, actorId, action: auditService.ACTIONS.server.create, resourceType: 'Server',
      resourceId: firstServer.id, metadata: { hostname: firstServer.hostname, demo: true },
    });
  }
  for (const policyId of policyIds) {
    await auditService.log({
      orgId, actorId, action: auditService.ACTIONS.policy.create, resourceType: 'AccessPolicy',
      resourceId: policyId, metadata: { demo: true },
    });
  }
  log('created demo audit log entries (never removed by --reset)');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const org = await resolveOrg();
  log(`target org: ${org.name} (${org.slug})`);

  if (RESET) {
    await resetDemoData(org.id);
    return;
  }

  const customersBySlug = await upsertCustomers(org.id);
  log(`customers: ${Object.keys(customersBySlug).length}`);

  const usersByLocalPart = await upsertUsers(org.id);
  log(`users: ${Object.keys(usersByLocalPart).length}`);
  await addGroupMemberships(org.id, usersByLocalPart);

  const adminId = usersByLocalPart['sarah.chen']?.id;

  const identitiesByName = await upsertIdentities(org.id, adminId);
  log(`identities: ${Object.keys(identitiesByName).length}`);

  const standaloneKeysByName = await upsertStandaloneKeys(org.id, adminId);
  const allKeysByName = { ...standaloneKeysByName };
  // Keys created as part of an identity's newKey aren't returned by name here
  // (they're named "<identity name> key"), so pull them back for deployments.
  const linkedKeys = await prisma.sshKey.findMany({ where: { orgId: org.id, name: { startsWith: DEMO_PREFIX } } });
  for (const k of linkedKeys) allKeysByName[k.name] = allKeysByName[k.name] || k;
  log(`keys: ${linkedKeys.length}`);

  const policyIds = await upsertPolicies(org.id);
  log(`demo policies: ${policyIds.length} (baseline policies untouched)`);

  const serverSpecs = buildServerSpecs(customersBySlug, identitiesByName);
  const servers = await upsertServers(org.id, serverSpecs);
  const sshTestServer = await upsertSshTestServer(org.id, customersBySlug, identitiesByName);
  const allServers = [...servers, sshTestServer];
  log(`servers: ${allServers.length} (includes sshtest.local — requires the shellius-sshtest `
    + 'container + SSH_TARGET_ALLOW_LOOPBACK=true to actually connect)');

  await attachDenyPolicyTarget(org.id);

  await seedKeyDeployments(org.id, allKeysByName, servers, adminId);
  const requests = await seedAccessRequestsAndNotifications(org.id, usersByLocalPart, allServers);
  const sessionCount = await seedSessions(org.id, usersByLocalPart, allServers);
  await seedAuditLogEntries(org.id, adminId, customersBySlug, allServers, policyIds);

  log('--- summary ---');
  log(`customers=${Object.keys(customersBySlug).length} users=${Object.keys(usersByLocalPart).length} `
    + `identities=${Object.keys(identitiesByName).length} keys=${linkedKeys.length} `
    + `servers=${allServers.length} policies=${policyIds.length} `
    + `accessRequests=${requests?.length ?? 'skipped (already seeded)'} sessions=${sessionCount || 'skipped (already seeded)'}`);
  log(`demo user login: any @demo.shellius.local address above, password "${DEMO_PASSWORD}" `
    + '(DEMO_USER_PASSWORD env to override; olivia.wright is "invited" and has no password yet)');
  log('seed complete');
}

main()
  .catch((e) => {
    console.error('[seed-demo] failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
