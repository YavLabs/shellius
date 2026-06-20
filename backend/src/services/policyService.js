import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve all group IDs the user belongs to, scoped via the group's orgId.
 *
 * @param {string} userId
 * @param {string} orgId
 * @returns {Promise<string[]>}
 */
async function resolveUserGroupIds(userId, orgId) {
  const memberships = await prisma.groupMembership.findMany({
    where: { userId, group: { orgId } },
    select: { groupId: true },
  });
  return memberships.map((m) => m.groupId);
}

/**
 * Load all active AccessPolicies for the org that have at least one subject
 * matching the user (direct USER subject) or one of their groups (GROUP subject).
 *
 * @param {string} orgId
 * @param {string} userId
 * @param {string[]} userGroupIds
 * @returns {Promise<import('@prisma/client').AccessPolicy[]>}
 */
async function loadMatchingPolicies(orgId, userId, userGroupIds, userRole) {
  // Build subject filter: USER match OR GROUP match OR ROLE match
  const subjectFilter = [
    { subjectType: 'USER', subjectId: userId },
  ];
  if (userGroupIds.length > 0) {
    subjectFilter.push({ subjectType: 'GROUP', subjectId: { in: userGroupIds } });
  }
  if (userRole) {
    subjectFilter.push({ subjectType: 'ROLE', subjectId: userRole });
  }

  const policies = await prisma.accessPolicy.findMany({
    where: {
      orgId,
      isActive: true,
      subjects: {
        some: {
          OR: subjectFilter,
        },
      },
    },
    include: { subjects: true },
    orderBy: [{ effect: 'asc' }, { priority: 'asc' }],
  });

  return policies;
}

/**
 * Check whether all entries in targetLabels (a key→value object) are present
 * in the server's labels field.
 *
 * The Server.labels column is a Json array of strings (e.g. ["env:prod", "team:ops"]).
 * The AccessPolicy.targetLabels column is a Json object (e.g. { "env": "prod" }).
 * Matching: each key/value pair in targetLabels must have a corresponding
 * "key:value" entry in the server's labels array.
 *
 * @param {unknown} serverLabels  - Json from DB (expected: string[])
 * @param {unknown} targetLabels  - Json from DB (expected: Record<string,string>)
 * @returns {boolean}
 */
function labelsMatch(serverLabels, targetLabels) {
  if (!targetLabels || typeof targetLabels !== 'object' || Array.isArray(targetLabels)) {
    return true; // no label filter configured
  }
  const entries = Object.entries(targetLabels);
  if (entries.length === 0) return true; // empty object = wildcard

  const labelArray = Array.isArray(serverLabels) ? serverLabels : [];
  return entries.every(([k, v]) => labelArray.includes(`${k}:${v}`));
}

/**
 * Apply all policy-level filters and return only the policies that match the
 * given server + optional requested principal.
 *
 * @param {object[]} policies
 * @param {object}   server
 * @param {string}   serverId
 * @param {string|undefined} requestedPrincipal
 * @returns {object[]}
 */
function filterPolicies(policies, server, serverId, requestedPrincipal) {
  return policies.filter((p) => {
    // 1. Customer scope: null = org-wide, otherwise must match server's customer
    if (p.customerId !== null && p.customerId !== server.customerId) return false;

    // 2. Environment filter: empty array = all environments
    if (p.targetEnvironments.length > 0 && !p.targetEnvironments.includes(server.environment)) {
      return false;
    }

    // 3. Label filter: empty object = wildcard
    if (!labelsMatch(server.labels, p.targetLabels)) return false;

    // 4. Server ID filter: empty array = all servers
    if (p.targetServerIds.length > 0 && !p.targetServerIds.includes(serverId)) return false;

    // 5. Principal filter: empty = wildcard; otherwise requestedPrincipal must be listed
    if (requestedPrincipal && p.allowedPrincipals.length > 0) {
      if (!p.allowedPrincipals.includes(requestedPrincipal)) return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Public API — policy evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate access for a user against a specific server.
 *
 * Supports three modes:
 *   1. `draftPolicy` supplied — evaluate that single draft policy object without
 *      loading anything from the database.
 *   2. `policyId` supplied — load that specific saved policy and evaluate it
 *      against the server, ignoring all other org policies.
 *   3. Neither — org-wide evaluation (original behaviour): load all active
 *      policies the user is a subject of and apply deny-before-allow.
 *
 * @param {object} params
 * @param {string}  params.orgId
 * @param {string}  params.userId
 * @param {string}  params.serverId
 * @param {string}  [params.requestedPrincipal]
 * @param {string}  [params.policyId]     - evaluate a specific saved policy
 * @param {object}  [params.draftPolicy]  - evaluate an inline draft policy
 * @returns {Promise<{
 *   allowed: boolean,
 *   requiresApproval: boolean,
 *   autoApprove: boolean,
 *   reason?: string,
 *   principals: string[],
 *   maxTtl: number,
 *   policyId?: string,
 *   draft?: boolean,
 * }>}
 */
export async function evaluate({ orgId, userId, serverId, requestedPrincipal, policyId, draftPolicy }) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!userId) throw new ApiError(400, 'userId is required');
  if (!serverId) throw new ApiError(400, 'serverId is required');

  // Step 1: Load server scoped to org
  const server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!server) throw new ApiError(404, 'Server not found');

  // Step 1b: super_admin bypass — full direct access to every server, including prod
  const callerUser = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (callerUser && callerUser.role === 'super_admin') {
    return {
      allowed: true,
      requiresApproval: false,
      autoApprove: true,
      principals: requestedPrincipal ? [requestedPrincipal] : [],
      maxTtl: 24 * 60 * 60,
      reason: 'super_admin bypass',
    };
  }

  // Step 2: Production approval is policy-driven. By default prod requires
  // approval, but a matching ALLOW policy with autoApprove=true (e.g. scoped to
  // admins/managers) grants access without approval. super_admin already
  // bypassed above. This is applied at the final ALLOW selection below.
  const isProd = server.environment === 'prod';

  // ---------------------------------------------------------------------------
  // Mode A: Draft policy evaluation (inline, no DB lookup for the policy itself)
  // ---------------------------------------------------------------------------
  if (draftPolicy) {
    const matched = filterPolicies([draftPolicy], server, serverId, requestedPrincipal);
    if (matched.length === 0 || draftPolicy.effect === 'DENY') {
      return {
        allowed: false,
        requiresApproval: false,
        autoApprove: false,
        reason: draftPolicy.effect === 'DENY'
          ? `Denied by draft policy '${draftPolicy.name}'`
          : 'Draft policy does not match this server',
        principals: [],
        maxTtl: 0,
        draft: true,
      };
    }
    return {
      allowed: true,
      requiresApproval: draftPolicy.requireApproval ?? false,
      autoApprove: draftPolicy.autoApprove ?? false,
      principals: draftPolicy.allowedPrincipals ?? [],
      maxTtl: draftPolicy.maxSessionDuration,
      reason: `Allowed by draft policy '${draftPolicy.name}'`,
      draft: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Mode B: Specific saved policy evaluation
  // ---------------------------------------------------------------------------
  if (policyId) {
    const savedPolicy = await prisma.accessPolicy.findFirst({
      where: { id: policyId, orgId },
      include: { subjects: true },
    });
    if (!savedPolicy) throw new ApiError(404, 'Policy not found');

    const matched = filterPolicies([savedPolicy], server, serverId, requestedPrincipal);
    if (matched.length === 0 || savedPolicy.effect === 'DENY') {
      return {
        allowed: false,
        requiresApproval: false,
        autoApprove: false,
        reason: savedPolicy.effect === 'DENY'
          ? `Denied by policy '${savedPolicy.name}'`
          : 'Policy does not match this server',
        principals: [],
        maxTtl: 0,
        policyId: savedPolicy.id,
        policyName: savedPolicy.name,
      };
    }
    return {
      allowed: true,
      requiresApproval: savedPolicy.requireApproval,
      autoApprove: savedPolicy.autoApprove,
      principals: savedPolicy.allowedPrincipals,
      maxTtl: savedPolicy.maxSessionDuration,
      policyId: savedPolicy.id,
      policyName: savedPolicy.name,
    };
  }

  // ---------------------------------------------------------------------------
  // Mode C: Org-wide evaluation (original behaviour)
  // ---------------------------------------------------------------------------

  // Step 3: Resolve user's group memberships and role
  const [userGroupIds, userRecord] = await Promise.all([
    resolveUserGroupIds(userId, orgId),
    prisma.user.findUnique({ where: { id: userId }, select: { role: true } }),
  ]);
  const userRole = userRecord?.role || null;

  // Step 4: Load active policies where user, their groups, or their role are subjects
  const rawPolicies = await loadMatchingPolicies(orgId, userId, userGroupIds, userRole);

  // Steps 5-9: Apply server/environment/label/serverIds/principal filters
  const matchingPolicies = filterPolicies(rawPolicies, server, serverId, requestedPrincipal);

  if (matchingPolicies.length === 0) {
    return {
      allowed: false,
      requiresApproval: false,
      autoApprove: false,
      reason: 'No matching policy',
      principals: [],
      maxTtl: 0,
    };
  }

  // Step 10: Deny-before-allow — any DENY policy wins immediately
  const denyPolicy = matchingPolicies.find((p) => p.effect === 'DENY');
  if (denyPolicy) {
    logger.info('policyService.evaluate: access denied by policy', {
      orgId,
      userId,
      serverId,
      policyId: denyPolicy.id,
      policyName: denyPolicy.name,
    });
    return {
      allowed: false,
      requiresApproval: false,
      autoApprove: false,
      reason: `Denied by policy ${denyPolicy.name}`,
      principals: [],
      maxTtl: 0,
      policyId: denyPolicy.id,
    };
  }

  // Step 11: Pick highest-priority ALLOW policy (lowest priority number wins)
  const allowPolicies = matchingPolicies
    .filter((p) => p.effect === 'ALLOW')
    .sort((a, b) => a.priority - b.priority);

  const bestPolicy = allowPolicies[0];

  // Production requires approval UNLESS the matched policy auto-approves the
  // subject (e.g. an admins/managers policy). Non-prod follows the policy's
  // own requireApproval flag.
  const requiresApproval = isProd ? !bestPolicy.autoApprove : bestPolicy.requireApproval;

  logger.info('policyService.evaluate: access allowed by policy', {
    orgId,
    userId,
    serverId,
    policyId: bestPolicy.id,
    policyName: bestPolicy.name,
    isProd,
    requiresApproval,
  });

  return {
    allowed: true,
    requiresApproval,
    autoApprove: bestPolicy.autoApprove,
    principals: bestPolicy.allowedPrincipals,
    maxTtl: bestPolicy.maxSessionDuration,
    policyId: bestPolicy.id,
  };
}

/**
 * Find the best-matching ALLOW policy for a user+server purely to read its
 * approver routing (approverGroupId / approverRoles / approverUserIds).
 *
 * Unlike evaluate(), this does NOT short-circuit on the prod hard-rule — prod
 * requests still need approver routing even though the invariant forces
 * approval. Returns the policy row (or null when nothing matches).
 *
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.userId
 * @param {string} params.serverId
 * @param {string} [params.requestedPrincipal]
 * @returns {Promise<object|null>}
 */
export async function findApproverPolicy({ orgId, userId, serverId, requestedPrincipal }) {
  const server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!server) return null;

  const [userGroupIds, userRecord] = await Promise.all([
    resolveUserGroupIds(userId, orgId),
    prisma.user.findUnique({ where: { id: userId }, select: { role: true } }),
  ]);
  const rawPolicies = await loadMatchingPolicies(orgId, userId, userGroupIds, userRecord?.role || null);
  const matching = filterPolicies(rawPolicies, server, serverId, requestedPrincipal);
  const allow = matching
    .filter((p) => p.effect === 'ALLOW')
    .sort((a, b) => a.priority - b.priority);
  return allow[0] || null;
}

/**
 * Return all servers the user can access (allowed=true OR requiresApproval=true),
 * enriched with policy evaluation results.
 *
 * Note: iterates all org servers — suitable for moderate fleet sizes. A query-level
 * optimisation (pre-filtering by policy targetServerIds/environments) is deferred.
 *
 * @param {string} orgId
 * @param {string} userId
 * @returns {Promise<Array<{ server: object, evaluation: object }>>}
 */
export async function getAccessibleServers(orgId, userId) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!userId) throw new ApiError(400, 'userId is required');

  const servers = await prisma.server.findMany({
    where: { orgId, isActive: true },
    include: { customer: { select: { id: true, name: true, slug: true } } },
  });

  const results = [];
  for (const server of servers) {
    const evaluation = await evaluate({ orgId, userId, serverId: server.id });
    if (evaluation.allowed || evaluation.requiresApproval) {
      results.push({ server, evaluation });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API — CRUD
// ---------------------------------------------------------------------------

/**
 * List policies for an org with optional filters.
 *
 * @param {string} orgId
 * @param {object} [filters]
 * @param {string}  [filters.customerId]
 * @param {string}  [filters.effect]      - 'ALLOW' | 'DENY'
 * @param {boolean} [filters.isActive]
 * @param {number}  [filters.page=1]
 * @param {number}  [filters.pageSize=25]
 * @returns {Promise<{ items: object[], total: number, page: number, pageSize: number }>}
 */
export async function list(orgId, filters = {}) {
  const { customerId, effect, isActive, page = 1, pageSize = 25 } = filters;
  const p = parseInt(page, 10) || 1;
  const ps = Math.min(parseInt(pageSize, 10) || 25, 100);

  const where = { orgId };
  if (customerId !== undefined) where.customerId = customerId;
  if (effect !== undefined) where.effect = effect;
  if (isActive !== undefined) where.isActive = isActive === true || isActive === 'true';

  const [items, total] = await Promise.all([
    prisma.accessPolicy.findMany({
      where,
      skip: (p - 1) * ps,
      take: ps,
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      include: {
        subjects: true,
        customer: { select: { id: true, name: true, slug: true } },
      },
    }),
    prisma.accessPolicy.count({ where }),
  ]);

  await enrichPolicySubjects(orgId, items);
  return { items, total, page: p, pageSize: ps };
}

/**
 * Get a single policy by id, scoped to org.
 *
 * @param {string} orgId
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function getById(orgId, id) {
  const policy = await prisma.accessPolicy.findFirst({
    where: { id, orgId },
    include: {
      subjects: true,
      customer: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!policy) throw new ApiError(404, 'Policy not found');
  await enrichPolicySubjects(orgId, [policy]);
  return policy;
}

const ROLE_LABELS = { super_admin: 'Super Admin', admin: 'Admin', manager: 'Manager', member: 'Member' };

/**
 * Attach a human-readable `label` to each policy subject (USER → name/email,
 * GROUP → name, ROLE → role label) so the UI never has to render raw UUIDs.
 * Batched to avoid N+1. Mutates the passed policies in place.
 */
async function enrichPolicySubjects(orgId, policies) {
  const userIds = new Set();
  const groupIds = new Set();
  for (const p of policies) {
    for (const s of p.subjects || []) {
      if (s.subjectType === 'USER') userIds.add(s.subjectId);
      else if (s.subjectType === 'GROUP') groupIds.add(s.subjectId);
    }
  }
  const [users, groups] = await Promise.all([
    userIds.size
      ? prisma.user.findMany({ where: { orgId, id: { in: [...userIds] } }, select: { id: true, name: true, email: true } })
      : [],
    groupIds.size
      ? prisma.group.findMany({ where: { orgId, id: { in: [...groupIds] } }, select: { id: true, name: true } })
      : [],
  ]);
  const userMap = new Map(users.map((u) => [u.id, u.name || u.email]));
  const groupMap = new Map(groups.map((g) => [g.id, g.name]));
  for (const p of policies) {
    for (const s of p.subjects || []) {
      if (s.subjectType === 'USER') s.label = userMap.get(s.subjectId) || '(unknown user)';
      else if (s.subjectType === 'GROUP') s.label = groupMap.get(s.subjectId) || '(unknown group)';
      else if (s.subjectType === 'ROLE') s.label = ROLE_LABELS[s.subjectId] || s.subjectId;
    }
  }
}

/**
 * Create a new access policy with its subjects in a transaction.
 *
 * @param {string} orgId
 * @param {object} data
 * @param {Array<{ subjectType: 'USER'|'GROUP', subjectId: string }>} [data.subjects]
 * @returns {Promise<object>}
 */
export async function create(orgId, data) {
  const {
    subjects = [],
    customerId,
    name,
    description,
    effect,
    targetEnvironments = [],
    targetLabels = {},
    targetServerIds = [],
    allowedPrincipals = [],
    maxSessionDuration,
    requireApproval = false,
    autoApprove = false,
    isActive = true,
    priority = 100,
    osProvisioning = {},
    allowKeyDownload = false,
    isBreakGlass = false,
    approverGroupId = null,
    approverRoles = [],
    approverUserIds = [],
  } = data;

  if (!name) throw new ApiError(400, 'name is required');
  if (!effect) throw new ApiError(400, 'effect is required');
  if (!maxSessionDuration || maxSessionDuration <= 0) {
    throw new ApiError(400, 'maxSessionDuration must be a positive integer');
  }

  // Verify customerId belongs to org if provided
  if (customerId) {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, orgId } });
    if (!customer) throw new ApiError(400, 'Customer not found in organization');
  }

  const policy = await prisma.$transaction(async (tx) => {
    const created = await tx.accessPolicy.create({
      data: {
        orgId,
        customerId: customerId || null,
        name,
        description: description || null,
        effect,
        targetEnvironments,
        targetLabels,
        targetServerIds,
        allowedPrincipals,
        maxSessionDuration,
        requireApproval,
        autoApprove,
        isActive,
        priority,
        osProvisioning,
        allowKeyDownload,
        isBreakGlass,
        approverGroupId: approverGroupId || null,
        approverRoles,
        approverUserIds,
      },
    });

    if (subjects.length > 0) {
      await tx.policySubject.createMany({
        data: subjects.map((s) => ({
          policyId: created.id,
          subjectType: s.subjectType,
          subjectId: s.subjectId,
        })),
        skipDuplicates: true,
      });
    }

    return tx.accessPolicy.findUnique({
      where: { id: created.id },
      include: {
        subjects: true,
        customer: { select: { id: true, name: true, slug: true } },
      },
    });
  });

  logger.info('policyService.create: policy created', { orgId, policyId: policy.id, name });
  return policy;
}

/**
 * Update an existing policy and replace its subjects in a transaction.
 *
 * @param {string} orgId
 * @param {string} id
 * @param {object} data
 * @returns {Promise<object>}
 */
export async function update(orgId, id, data) {
  const existing = await prisma.accessPolicy.findFirst({ where: { id, orgId } });
  if (!existing) throw new ApiError(404, 'Policy not found');

  const {
    subjects,
    customerId,
    name,
    description,
    effect,
    targetEnvironments,
    targetLabels,
    targetServerIds,
    allowedPrincipals,
    maxSessionDuration,
    requireApproval,
    autoApprove,
    isActive,
    priority,
    osProvisioning,
    allowKeyDownload,
    isBreakGlass,
    approverGroupId,
    approverRoles,
    approverUserIds,
  } = data;

  // Verify customerId belongs to org if changing it
  if (customerId !== undefined && customerId !== null) {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, orgId } });
    if (!customer) throw new ApiError(400, 'Customer not found in organization');
  }

  const updateData = {};
  if (customerId !== undefined) updateData.customerId = customerId || null;
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (effect !== undefined) updateData.effect = effect;
  if (targetEnvironments !== undefined) updateData.targetEnvironments = targetEnvironments;
  if (targetLabels !== undefined) updateData.targetLabels = targetLabels;
  if (targetServerIds !== undefined) updateData.targetServerIds = targetServerIds;
  if (allowedPrincipals !== undefined) updateData.allowedPrincipals = allowedPrincipals;
  if (maxSessionDuration !== undefined) updateData.maxSessionDuration = maxSessionDuration;
  if (requireApproval !== undefined) updateData.requireApproval = requireApproval;
  if (autoApprove !== undefined) updateData.autoApprove = autoApprove;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (priority !== undefined) updateData.priority = priority;
  if (osProvisioning !== undefined) updateData.osProvisioning = osProvisioning;
  if (allowKeyDownload !== undefined) updateData.allowKeyDownload = allowKeyDownload;
  if (isBreakGlass !== undefined) updateData.isBreakGlass = isBreakGlass;
  if (approverGroupId !== undefined) updateData.approverGroupId = approverGroupId || null;
  if (approverRoles !== undefined) updateData.approverRoles = approverRoles;
  if (approverUserIds !== undefined) updateData.approverUserIds = approverUserIds;

  const policy = await prisma.$transaction(async (tx) => {
    await tx.accessPolicy.update({ where: { id }, data: updateData });

    // Replace subjects only when explicitly provided
    if (Array.isArray(subjects)) {
      await tx.policySubject.deleteMany({ where: { policyId: id } });
      if (subjects.length > 0) {
        await tx.policySubject.createMany({
          data: subjects.map((s) => ({
            policyId: id,
            subjectType: s.subjectType,
            subjectId: s.subjectId,
          })),
          skipDuplicates: true,
        });
      }
    }

    return tx.accessPolicy.findUnique({
      where: { id },
      include: {
        subjects: true,
        customer: { select: { id: true, name: true, slug: true } },
      },
    });
  });

  logger.info('policyService.update: policy updated', { orgId, policyId: id });
  return policy;
}

/**
 * Delete a policy (cascades to PolicySubject rows via DB constraint).
 *
 * @param {string} orgId
 * @param {string} id
 * @returns {Promise<{ success: boolean }>}
 */
export async function del(orgId, id) {
  const existing = await prisma.accessPolicy.findFirst({ where: { id, orgId } });
  if (!existing) throw new ApiError(404, 'Policy not found');
  await prisma.accessPolicy.delete({ where: { id } });
  logger.info('policyService.delete: policy deleted', { orgId, policyId: id });
  return { success: true };
}
