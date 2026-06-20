/**
 * defaultSeedService — single source of truth for default Groups (roles) and
 * approval-aware AccessPolicies. Used by BOTH:
 *   - prisma/seed.js          (manual `prisma db seed`, standalone client)
 *   - jobs/seedDefaultPolicies (idempotent backend boot job)
 *
 * Idempotent contract:
 *   - Groups are upserted by (orgId, name).
 *   - Policies are looked up by (orgId, name); existing rows are NEVER
 *     overwritten (operators tune them in the UI). Only created when absent.
 *   - PolicySubject links use the @@unique constraint via skipDuplicates.
 *
 * Roles are modelled as Groups (the OrgRole enum stays fixed). "Managers" is
 * the approver pool that production access requests route to.
 */

// Role-style groups seeded for every org.
export const BASELINE_GROUPS = [
  { name: 'Admins', description: 'Administrators — broad access; can approve production requests.' },
  { name: 'Managers', description: 'Approvers for production access requests.' },
  { name: 'Members', description: 'Standard members — self-serve access to dev and staging hosts.' },
  { name: 'All Users', description: 'Default catch-all group — every user in the org.' },
  { name: 'Read Only', description: 'Viewer-tier audience — no SSH access by default.' },
];

// Linux usernames the SSH cert will be valid for, covering major cloud-image
// conventions plus a generic admin.
const DEFAULT_PRINCIPALS = ['ubuntu', 'ec2-user', 'azureuser', 'root', 'admin'];

// Approval-aware default policies.
//
//   Dev / Staging → requireApproval:false (request flow runs but the request
//     is created already-APPROVED — i.e. "auto-approved").
//   Prod          → requireApproval:true. The hard-coded prod invariant in
//     policyService.evaluate() enforces approval regardless; this policy makes
//     the rule visible AND routes approval to the Managers group (+ admins).
export const BASELINE_POLICIES = [
  {
    name: 'Default Dev Access',
    description:
      'Self-serve SSH into dev hosts. Requests are auto-approved, 8 hour cert lifetime, key download enabled so the TUI can connect natively.',
    effect: 'ALLOW',
    targetEnvironments: ['dev'],
    allowedPrincipals: DEFAULT_PRINCIPALS,
    maxSessionDuration: 8 * 3600,
    requireApproval: false,
    autoApprove: true,
    allowKeyDownload: true,
    isBreakGlass: false,
    priority: 100,
    subjectGroups: ['Members', 'Admins', 'All Users'],
  },
  {
    name: 'Staging Access',
    description: 'Self-serve SSH into staging/demo hosts for members. 4 hour cert lifetime, auto-approved.',
    effect: 'ALLOW',
    targetEnvironments: ['staging', 'demo'],
    allowedPrincipals: DEFAULT_PRINCIPALS,
    maxSessionDuration: 4 * 3600,
    requireApproval: false,
    autoApprove: true,
    allowKeyDownload: true,
    isBreakGlass: false,
    priority: 100,
    subjectGroups: ['Members', 'Admins'],
  },
  {
    name: 'Production Approval',
    description:
      'Production access requires approval. Routes to the Managers group (admins may also approve). 2 hour cert lifetime.',
    effect: 'ALLOW',
    targetEnvironments: ['prod'],
    allowedPrincipals: DEFAULT_PRINCIPALS,
    maxSessionDuration: 2 * 3600,
    requireApproval: true,
    autoApprove: false,
    allowKeyDownload: true,
    isBreakGlass: false,
    priority: 50,
    subjectGroups: ['Members', 'Admins'],
    approverGroup: 'Managers',
    approverRoles: ['admin', 'super_admin'],
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
    subjectGroups: ['Admins'],
  },
];

/**
 * Seed groups + approval-aware policies for one org. Idempotent.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} orgId
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{ groupsByName: Record<string, {id:string}>, created: number, preserved: number }>}
 */
export async function seedRolesAndPolicies(prisma, orgId, log = () => {}) {
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
  log(`groups: ${Object.keys(groupsByName).join(', ')}`);

  // ---------- Policies ----------
  let created = 0;
  let preserved = 0;
  for (const p of BASELINE_POLICIES) {
    const existing = await prisma.accessPolicy.findFirst({ where: { orgId, name: p.name } });
    if (existing) {
      preserved++;
      continue;
    }

    const approverGroupId = p.approverGroup ? groupsByName[p.approverGroup]?.id || null : null;

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
        approverGroupId,
        approverRoles: p.approverRoles || [],
        approverUserIds: p.approverUserIds || [],
      },
    });

    const subjects = (p.subjectGroups || [])
      .map((name) => groupsByName[name])
      .filter(Boolean)
      .map((g) => ({ policyId: policy.id, subjectType: 'GROUP', subjectId: g.id }));
    if (subjects.length > 0) {
      await prisma.policySubject.createMany({ data: subjects, skipDuplicates: true });
    }
    created++;
  }
  log(`policies: ${created} created, ${preserved} preserved`);

  return { groupsByName, created, preserved };
}

export default { BASELINE_GROUPS, BASELINE_POLICIES, seedRolesAndPolicies };
