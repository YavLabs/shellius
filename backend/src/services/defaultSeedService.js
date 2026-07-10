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
// Role hierarchy: super_admin > admin > manager > member.
// Groups (membership-based, used as policy subjects + approver pools):
export const BASELINE_GROUPS = [
  { name: 'Admin', description: 'Administrators — full access; no approval needed for production.' },
  { name: 'Managers', description: 'Managers — production access without approval; can approve others.' },
  { name: 'Approvers', description: 'Designated approvers for production access requests.' },
  { name: 'Developers', description: 'Developers — self-serve dev/staging; production requires approval.' },
];

// Linux usernames the SSH cert will be valid for, covering major cloud-image
// conventions plus a generic admin.
const DEFAULT_PRINCIPALS = ['ubuntu', 'ec2-user', 'azureuser', 'root', 'admin'];

// Approval-aware default policies (role-driven). Prod approval is policy-driven
// in policyService.evaluate(): a matching ALLOW policy with autoApprove=true
// grants prod access without approval; otherwise prod requires approval.
//   super_admin → bypasses all policy (full access).
//   admin / manager → dev + prod without approval.
//   member / Developers → dev self-serve; prod requires approval (Approvers).
export const BASELINE_POLICIES = [
  {
    name: 'Dev & Staging Access',
    description:
      'Self-serve SSH into dev/staging/demo hosts for everyone. Auto-approved, 8 hour cert lifetime.',
    effect: 'ALLOW',
    targetEnvironments: ['dev', 'staging', 'demo'],
    allowedPrincipals: DEFAULT_PRINCIPALS,
    maxSessionDuration: 8 * 3600,
    requireApproval: false,
    autoApprove: true,
    allowKeyDownload: true,
    isBreakGlass: false,
    priority: 100,
    subjectRoles: ['admin', 'manager', 'member'],
    subjectGroups: ['Developers', 'Managers', 'Admin'],
  },
  {
    name: 'Production Access — Admins & Managers',
    description:
      'Admins and managers access production WITHOUT approval. 2 hour cert lifetime. Higher precedence than the standard prod policy.',
    effect: 'ALLOW',
    targetEnvironments: ['prod'],
    allowedPrincipals: DEFAULT_PRINCIPALS,
    maxSessionDuration: 2 * 3600,
    requireApproval: false,
    autoApprove: true,
    allowKeyDownload: true,
    isBreakGlass: false,
    priority: 40,
    subjectRoles: ['admin', 'manager'],
    subjectGroups: ['Admin', 'Managers'],
  },
  {
    name: 'Production Access — Approval Required',
    description:
      'Everyone else needs approval for production. Routes to the Approvers group (admins/managers may also approve). 2 hour cert lifetime.',
    effect: 'ALLOW',
    targetEnvironments: ['prod'],
    allowedPrincipals: DEFAULT_PRINCIPALS,
    maxSessionDuration: 2 * 3600,
    requireApproval: true,
    autoApprove: false,
    allowKeyDownload: true,
    isBreakGlass: false,
    priority: 50,
    subjectRoles: ['member'],
    subjectGroups: ['Developers'],
    approverGroup: 'Approvers',
    approverRoles: ['admin', 'manager', 'super_admin'],
  },
  {
    name: 'Break-glass Production',
    description:
      'Emergency production access without approval for admins. 1 hour cert lifetime. Audited as a high-severity event.',
    effect: 'ALLOW',
    targetEnvironments: ['prod'],
    allowedPrincipals: DEFAULT_PRINCIPALS,
    maxSessionDuration: 1 * 3600,
    requireApproval: false,
    autoApprove: true,
    allowKeyDownload: true,
    isBreakGlass: true,
    priority: 10,
    subjectRoles: ['admin'],
    subjectGroups: ['Admin'],
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

    const subjects = [
      ...(p.subjectGroups || [])
        .map((name) => groupsByName[name])
        .filter(Boolean)
        .map((g) => ({ policyId: policy.id, subjectType: 'GROUP', subjectId: g.id })),
      ...(p.subjectRoles || []).map((role) => ({
        policyId: policy.id,
        subjectType: 'ROLE',
        subjectId: role,
      })),
    ];
    if (subjects.length > 0) {
      await prisma.policySubject.createMany({ data: subjects, skipDuplicates: true });
    }
    created++;
  }
  log(`policies: ${created} created, ${preserved} preserved`);

  return { groupsByName, created, preserved };
}

export default { BASELINE_GROUPS, BASELINE_POLICIES, seedRolesAndPolicies };
