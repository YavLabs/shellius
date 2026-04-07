/**
 * seedDefaultPolicies — idempotent backend startup job (Task 17D).
 *
 * On boot, for every organization, check whether any AccessPolicy rows
 * exist. If none, seed three starter policies so the platform is usable
 * out of the box:
 *
 *   1. default-allow-non-prod (priority 100, ALLOW, autoApprove)
 *      — any user → any server with environment in (demo,dev,staging)
 *      — 1h sessions, no approval required
 *
 *   2. default-prod-requires-approval (priority 50, ALLOW)
 *      — any user → any server with environment 'prod'
 *      — 30min sessions, manager approval required
 *      (the backend invariant enforces this regardless; the policy
 *      makes the rule visible in the UI catalogue)
 *
 *   3. default-deny-inactive (priority 10, DENY)
 *      — every user with status='deactivated' → any server
 *
 * Idempotent: only seeds when an org has zero AccessPolicy rows. Safe to
 * re-run on every container boot.
 */

import prisma from '../config/db.js';
import logger from '../utils/logger.js';

const DEFAULT_POLICIES = [
  {
    name: 'default-allow-non-prod',
    description:
      'Default: allow any authenticated user to access non-production servers (demo, dev, staging) with auto-approval. 1 hour sessions.',
    effect: 'ALLOW',
    targetEnvironments: ['demo', 'dev', 'staging'],
    targetLabels: {},
    targetServerIds: [],
    allowedPrincipals: [],
    maxSessionDuration: 3600,
    requireApproval: false,
    autoApprove: true,
    isActive: true,
    priority: 100,
  },
  {
    name: 'default-prod-requires-approval',
    description:
      'Default: production servers always require manager approval before access is granted. 30 minute sessions. (Note: this is also enforced by a hard-coded backend invariant; this policy makes the rule visible in the UI.)',
    effect: 'ALLOW',
    targetEnvironments: ['prod'],
    targetLabels: {},
    targetServerIds: [],
    allowedPrincipals: [],
    maxSessionDuration: 1800,
    requireApproval: true,
    autoApprove: false,
    isActive: true,
    priority: 50,
  },
  {
    name: 'default-deny-inactive',
    description:
      'Default: deny access for any user whose account has been deactivated. Highest-precedence safety rule.',
    effect: 'DENY',
    targetEnvironments: [],
    targetLabels: {},
    targetServerIds: [],
    allowedPrincipals: [],
    maxSessionDuration: 0,
    requireApproval: false,
    autoApprove: false,
    isActive: true,
    priority: 10,
  },
];

/**
 * Seed default policies for any org that currently has zero rows.
 */
export async function seedDefaultPolicies() {
  try {
    const orgs = await prisma.organization.findMany({ select: { id: true, slug: true } });
    let seededOrgs = 0;
    for (const org of orgs) {
      const count = await prisma.accessPolicy.count({ where: { orgId: org.id } });
      if (count > 0) continue;

      await prisma.$transaction(
        DEFAULT_POLICIES.map((p) =>
          prisma.accessPolicy.create({ data: { ...p, orgId: org.id } })
        )
      );
      seededOrgs++;
      logger.info('seedDefaultPolicies: seeded org', {
        orgId: org.id,
        slug: org.slug,
        count: DEFAULT_POLICIES.length,
      });
    }
    if (seededOrgs > 0) {
      logger.info('seedDefaultPolicies: complete', { seededOrgs, totalOrgs: orgs.length });
    }
  } catch (err) {
    logger.error('seedDefaultPolicies: failed', { error: err.message });
  }
}

export default { seedDefaultPolicies };
