/**
 * Prisma seed — creates the bootstrap organization + super admin user.
 *
 * All values are read from environment variables so secrets never live
 * in source. The seed is idempotent: rerunning it on a populated DB
 * does NOT overwrite an existing super admin's password (use the UI's
 * "Change password" or `prisma db seed -- --force-password` to rotate).
 *
 * Required env (in `.env.prod` / `.env`):
 *   SEED_ORG_NAME
 *   SEED_ORG_SLUG
 *   SEED_ORG_DOMAIN          (optional)
 *   SEED_ADMIN_EMAIL
 *   SEED_ADMIN_NAME          (optional, defaults to "Super Admin")
 *   SEED_ADMIN_PASSWORD
 *
 * Behaviour:
 *   - If SEED_ADMIN_EMAIL or SEED_ADMIN_PASSWORD is missing, the seed
 *     refuses to run with a clear error message.
 *   - The organization is upserted by slug.
 *   - The super admin user is upserted by (orgId, email). On insert,
 *     the password is bcrypt-hashed from SEED_ADMIN_PASSWORD.
 *   - On update, the password is left untouched UNLESS the
 *     `--force-password` CLI flag is passed (or
 *     SEED_FORCE_ADMIN_PASSWORD=true is set), so a stale `.env`
 *     can't accidentally reset a super admin's password.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(
      `\n[seed] ERROR: ${name} is not set.\n` +
      `[seed] The seed requires SEED_ORG_NAME, SEED_ORG_SLUG,\n` +
      `[seed] SEED_ADMIN_EMAIL, and SEED_ADMIN_PASSWORD in .env / .env.prod.\n` +
      `[seed] See .env.prod.example for the full list.\n`
    );
    process.exit(1);
  }
  return v.trim();
}

async function main() {
  const ORG_NAME = requireEnv('SEED_ORG_NAME');
  const ORG_SLUG = requireEnv('SEED_ORG_SLUG');
  const ORG_DOMAIN = (process.env.SEED_ORG_DOMAIN || '').trim() || null;

  const ADMIN_EMAIL = requireEnv('SEED_ADMIN_EMAIL');
  const ADMIN_NAME = (process.env.SEED_ADMIN_NAME || 'Super Admin').trim();
  const ADMIN_PASSWORD = requireEnv('SEED_ADMIN_PASSWORD');

  const FORCE_PASSWORD =
    process.argv.includes('--force-password') ||
    String(process.env.SEED_FORCE_ADMIN_PASSWORD || '').toLowerCase() === 'true';

  // ---------------------------------------------------------------------
  // Organization
  // ---------------------------------------------------------------------
  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {
      name: ORG_NAME,
      ...(ORG_DOMAIN ? { domain: ORG_DOMAIN } : {}),
    },
    create: {
      name: ORG_NAME,
      slug: ORG_SLUG,
      domain: ORG_DOMAIN,
    },
  });
  console.log(`[seed] Organization: ${org.name} (${org.slug})`);

  // ---------------------------------------------------------------------
  // Super admin
  // ---------------------------------------------------------------------
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const existing = await prisma.user.findUnique({
    where: { orgId_email: { orgId: org.id, email: ADMIN_EMAIL } },
  });

  if (!existing) {
    const admin = await prisma.user.create({
      data: {
        orgId: org.id,
        email: ADMIN_EMAIL,
        name: ADMIN_NAME,
        passwordHash,
        role: 'super_admin',
        status: 'active',
      },
    });
    console.log(`[seed] Super admin created: ${admin.email}`);
  } else {
    // Idempotent re-run: never silently overwrite the password unless
    // explicitly forced. Always keep the role at super_admin and the
    // status active in case somebody downgraded it via SQL.
    const update = {
      name: ADMIN_NAME,
      role: 'super_admin',
      status: 'active',
    };
    if (FORCE_PASSWORD) update.passwordHash = passwordHash;

    const admin = await prisma.user.update({
      where: { orgId_email: { orgId: org.id, email: ADMIN_EMAIL } },
      data: update,
    });
    console.log(
      `[seed] Super admin updated: ${admin.email}` +
        (FORCE_PASSWORD ? ' (password reset via --force-password)' : ' (password preserved)')
    );
  }

  await seedGroupsAndPolicies(org.id);
}

// ---------------------------------------------------------------------------
// Groups + access policies
// ---------------------------------------------------------------------------
//
// Seeds a small, opinionated baseline of groups and access policies so a
// freshly deployed Shellius instance is immediately useful (Engineers can
// SSH into dev/staging without an admin manually wiring up policies first).
//
// Idempotent contract:
//
//   - Groups are upserted by (orgId, name).
//   - Policies are looked up by (orgId, name); if found, the existing row
//     is left UNTOUCHED — operators frequently tune things like
//     maxSessionDuration / allowedPrincipals via the UI and we must not
//     stomp those edits on every redeploy. The seed only writes when
//     creating from scratch.
//   - PolicySubject links use the @@unique constraint to skipDuplicates
//     on insert.
//
// Adjust the BASELINE_* constants below if you want different defaults
// for new deployments. Existing deployments are unaffected because the
// seed never updates an existing policy.

const BASELINE_GROUPS = [
  {
    name: 'All Users',
    description: 'Default catch-all group — every user in the org.',
  },
  {
    name: 'Engineers',
    description: 'Developers with self-serve access to dev and staging hosts.',
  },
  {
    name: 'Operators',
    description: 'On-call / SRE — production access with manager approval.',
  },
  {
    name: 'Read Only',
    description: 'Viewer-tier audience — no SSH access by default.',
  },
];

// A reasonable default set of Linux usernames the SSH cert will be valid
// for, covering the major cloud-image conventions plus a generic admin.
const DEFAULT_PRINCIPALS = ['ubuntu', 'ec2-user', 'azureuser', 'root', 'admin'];

const BASELINE_POLICIES = [
  {
    name: 'Default Dev Access',
    description:
      'Self-serve SSH into dev hosts. Auto-approves requests, 8 hour cert lifetime, key download enabled so the TUI can connect natively.',
    effect: 'ALLOW',
    targetEnvironments: ['dev'],
    allowedPrincipals: DEFAULT_PRINCIPALS,
    maxSessionDuration: 8 * 3600,
    requireApproval: false,
    autoApprove: true,
    allowKeyDownload: true,
    isBreakGlass: false,
    priority: 100,
    subjectGroups: ['Engineers', 'All Users'],
  },
  {
    name: 'Staging Access',
    description:
      'Self-serve SSH into staging hosts for engineers. 4 hour cert lifetime.',
    effect: 'ALLOW',
    targetEnvironments: ['staging'],
    allowedPrincipals: DEFAULT_PRINCIPALS,
    maxSessionDuration: 4 * 3600,
    requireApproval: false,
    autoApprove: true,
    allowKeyDownload: true,
    isBreakGlass: false,
    priority: 100,
    subjectGroups: ['Engineers'],
  },
  {
    name: 'Production Approval',
    description:
      'Production access for on-call operators. Requires manager approval. 2 hour cert lifetime.',
    effect: 'ALLOW',
    targetEnvironments: ['prod'],
    allowedPrincipals: DEFAULT_PRINCIPALS,
    maxSessionDuration: 2 * 3600,
    requireApproval: true,
    autoApprove: false,
    allowKeyDownload: true,
    isBreakGlass: false,
    priority: 50,
    subjectGroups: ['Operators'],
  },
  {
    name: 'Break-glass Production',
    description:
      'Emergency production access without approval. 1 hour cert lifetime. Audited as a high-severity event. Use sparingly.',
    effect: 'ALLOW',
    targetEnvironments: ['prod'],
    allowedPrincipals: DEFAULT_PRINCIPALS,
    maxSessionDuration: 1 * 3600,
    requireApproval: false,
    autoApprove: true,
    allowKeyDownload: true,
    isBreakGlass: true,
    priority: 10,
    subjectGroups: ['Operators'],
  },
];

async function seedGroupsAndPolicies(orgId) {
  // ---------- Groups ----------
  const groupsByName = {};
  for (const g of BASELINE_GROUPS) {
    const row = await prisma.group.upsert({
      where: { orgId_name: { orgId, name: g.name } },
      update: { description: g.description },
      create: { orgId, name: g.name, description: g.description },
    });
    groupsByName[g.name] = row;
  }
  console.log(
    `[seed] Groups: ${Object.keys(groupsByName).join(', ')}`
  );

  // ---------- Policies ----------
  let created = 0;
  let preserved = 0;
  for (const p of BASELINE_POLICIES) {
    const existingPolicy = await prisma.accessPolicy.findFirst({
      where: { orgId, name: p.name },
    });

    if (existingPolicy) {
      // Never overwrite an operator-tuned policy on re-run.
      preserved++;
      continue;
    }

    const policy = await prisma.accessPolicy.create({
      data: {
        orgId,
        name: p.name,
        description: p.description,
        effect: p.effect,
        targetEnvironments: p.targetEnvironments,
        targetServerIds: [],
        allowedPrincipals: p.allowedPrincipals,
        maxSessionDuration: p.maxSessionDuration,
        requireApproval: p.requireApproval,
        autoApprove: p.autoApprove,
        allowKeyDownload: p.allowKeyDownload,
        isBreakGlass: p.isBreakGlass,
        priority: p.priority,
        isActive: true,
      },
    });

    // Link the policy to its subject groups via PolicySubject. Use
    // skipDuplicates so a partial-create on a previous run doesn't
    // crash the next one.
    const subjects = (p.subjectGroups || [])
      .map((groupName) => groupsByName[groupName])
      .filter(Boolean)
      .map((g) => ({
        policyId: policy.id,
        subjectType: 'GROUP',
        subjectId: g.id,
      }));
    if (subjects.length > 0) {
      await prisma.policySubject.createMany({
        data: subjects,
        skipDuplicates: true,
      });
    }

    created++;
  }
  console.log(
    `[seed] Policies: ${created} created, ${preserved} preserved (existing rows are never overwritten)`
  );
}

main()
  .catch((e) => {
    console.error('[seed] failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
