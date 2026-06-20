/**
 * seedDefaultPolicies — idempotent backend startup job.
 *
 * On boot, for every organization, seed the baseline role-groups
 * (Admins / Managers / Members / ...) and approval-aware access policies so a
 * fresh instance is usable out of the box. Delegates to the shared
 * defaultSeedService so this path and `prisma db seed` never diverge.
 *
 * Idempotent: groups are upserted; policies are created only when absent (an
 * operator-tuned policy is never overwritten). Safe to run on every boot.
 */

import prisma from '../config/db.js';
import logger from '../utils/logger.js';
import { seedRolesAndPolicies } from '../services/defaultSeedService.js';

export async function seedDefaultPolicies() {
  try {
    const orgs = await prisma.organization.findMany({ select: { id: true, slug: true } });
    let createdTotal = 0;
    for (const org of orgs) {
      const { created } = await seedRolesAndPolicies(prisma, org.id, (msg) =>
        logger.debug?.('seedDefaultPolicies', { orgId: org.id, slug: org.slug, msg })
      );
      createdTotal += created;
    }
    if (createdTotal > 0) {
      logger.info('seedDefaultPolicies: complete', { createdPolicies: createdTotal, totalOrgs: orgs.length });
    }
  } catch (err) {
    logger.error('seedDefaultPolicies: failed', { error: err.message });
  }
}

export default { seedDefaultPolicies };
