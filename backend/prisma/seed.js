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
import { seedRolesAndPolicies } from '../src/services/defaultSeedService.js';
import * as caService from '../src/services/caService.js';

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

  let admin;
  if (!existing) {
    admin = await prisma.user.create({
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

    admin = await prisma.user.update({
      where: { orgId_email: { orgId: org.id, email: ADMIN_EMAIL } },
      data: update,
    });
    console.log(
      `[seed] Super admin updated: ${admin.email}` +
        (FORCE_PASSWORD ? ' (password reset via --force-password)' : ' (password preserved)')
    );
  }

  // Groups + approval-aware policies (shared with the boot-time seed job).
  const { groupsByName, created, preserved } = await seedRolesAndPolicies(
    prisma,
    org.id,
    (msg) => console.log(`[seed] ${msg}`)
  );
  console.log(`[seed] Policies: ${created} created, ${preserved} preserved (existing rows are never overwritten)`);

  // Put the super admin in the Admins group so the approver routing has at
  // least one member to fall back on. Idempotent via the unique constraint.
  const adminsGroup = groupsByName['Admin'];
  if (adminsGroup) {
    await prisma.groupMembership.upsert({
      where: { groupId_userId: { groupId: adminsGroup.id, userId: admin.id } },
      update: {},
      create: { groupId: adminsGroup.id, userId: admin.id },
    });
  }

  // Ensure an active SSH Certificate Authority key pair exists (idempotent).
  // Without it, cert signing / host onboarding fails with "No active CA key
  // pair found". Generated once; rotate later from Settings -> CA Management.
  try {
    const activeCa = await prisma.caKeyPair.findFirst({ where: { orgId: org.id, isActive: true } });
    if (!activeCa) {
      await caService.generateCaKeyPair(org.id, 'default');
      console.log('[seed] CA key pair generated');
    } else {
      console.log('[seed] CA key pair present');
    }
  } catch (e) {
    console.warn(`[seed] WARNING: CA key pair generation failed: ${e.message}`);
  }
}

main()
  .catch((e) => {
    console.error('[seed] failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
