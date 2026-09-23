import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import prisma from '../config/db.js';
import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import * as caService from './caService.js';
import * as policyService from './policyService.js';
import * as jitManifestService from './jitManifestService.js';
import * as notificationService from './notificationService.js';
import { notifyEvent } from './notify/notifyService.js';
import * as rdpService from './rdpService.js';
import * as mailer from './mailer.js';
import * as inviteService from './inviteService.js';
import * as mfaService from './mfaService.js';
import redis from '../config/redis.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { renderTemplate } from '../email/index.js';
import { TIERS } from '../config/permissions.js';
import { canBypassProdApproval, isProdBypassEnabled } from './orgService.js';
import { usersWithPermission } from './roleService.js';
import { UNSCOPED, isUnscoped, assertServerInScope, serverScopeWhere, relationScopeWhere } from '../lib/scope.js';
import { endOfDayInclusive } from '../utils/dateRange.js';

const execFileAsync = promisify(execFile);

// A server is "onboarded" (requestable/connectable) once the agent + CA trust
// is in place: either auto-provisioning succeeded, OR the agent has enrolled /
// checked in (agentId / agentLastSeen — covers manual bootstrap too).
//
// NOTE: do NOT use healthStatus / lastHealthCheck — the periodic health probe
// runs against ANY server (even unreachable / never-onboarded ones), so those
// fields say nothing about whether the agent is actually installed.
export function isServerOnboarded(server) {
  if (!server) return false;
  if (server.provisionStatus === 'provisioned') return true;
  // RDP-only servers need no host agent — Guacamole injects credentials at
  // connect time, so they're connectable as soon as they're added.
  if (server.protocol === 'rdp') return true;
  // Credential-mode (Keystore) servers connect via a stored identity over
  // ssh2 — no CA bootstrap / agent required, so they're connectable as soon
  // as they're added.
  if (server.authMode === 'credential') return true;
  return !!server.agentId || !!server.agentLastSeen;
}

// ---------------------------------------------------------------------------
// Permission helper — callers pass the requester's permission Set (from
// req.user.permissions); see config/permissions.js.
// ---------------------------------------------------------------------------
function has(permissions, key) {
  if (!permissions) return false;
  return permissions instanceof Set ? permissions.has(key) : permissions.includes(key);
}

function formatDurationLabel(seconds) {
  const mins = Math.round((seconds || 0) / 60);
  if (mins >= 60) {
    const h = Math.round((mins / 60) * 10) / 10;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

/**
 * Best-effort: email every approver a one-click (token → confirm page) approval
 * link. Never throws — email failures must not block request submission.
 */
async function sendApprovalEmails({ orgId, accessRequest, requester, server, reason, approvers }) {
  const durationLabel = formatDurationLabel(accessRequest.requestedDuration);
  for (const approver of approvers) {
    if (!approver.email) continue;
    try {
      const { rawToken } = await inviteService.createResourceToken(
        approver.id,
        inviteService.TOKEN_TYPES.ACCESS_APPROVAL,
        accessRequest.id,
        24
      );
      const base = inviteService.buildTokenUrl(
        inviteService.TOKEN_TYPES.ACCESS_APPROVAL,
        rawToken
      );
      const tpl = renderTemplate('accessRequestApprovalNeeded', {
        approverName: approver.name,
        requesterName: requester.name,
        serverHostname: server.hostname,
        environment: server.environment,
        reason,
        durationLabel,
        approveUrl: `${base}?intent=approve`,
        rejectUrl: `${base}?intent=reject`,
      });
      await mailer.sendMail({
        orgId,
        to: approver.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
    } catch (err) {
      logger.warn('accessRequestService: approval email failed', {
        approverId: approver.id,
        error: err.message,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------
async function writeAudit(orgId, actorId, action, resourceId, metadata = {}) {
  try {
    await prisma.auditLog.create({
      data: {
        orgId,
        actorId: actorId ?? null,
        action,
        resourceType: 'AccessRequest',
        resourceId: resourceId ?? null,
        metadata,
      },
    });
  } catch (err) {
    logger.error('accessRequestService: audit log write failed', { action, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Approver resolution
// ---------------------------------------------------------------------------
/**
 * Resolve the set of users eligible to approve a request, from the matched
 * policy's approver routing (explicit users + roles + group), excluding the
 * requester. Falls back to the requester's manager when the policy specifies
 * no approvers. Returns a deduped array of { id, name, email }.
 *
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.requesterId
 * @param {object|null} params.policy   - matched AccessPolicy (approver fields)
 * @param {object|null} params.manager  - requester's manager { id, name, email }
 */
async function resolveApprovers({ orgId, requesterId, policy, manager }) {
  const byId = new Map();
  const add = (u) => {
    if (u && u.id && u.id !== requesterId) byId.set(u.id, u);
  };

  if (policy) {
    const orFilters = [];
    if (policy.approverUserIds?.length) orFilters.push({ id: { in: policy.approverUserIds } });
    if (policy.approverRoles?.length) {
      // Role keys match the base tier or a custom role's own key.
      orFilters.push({ role: { in: policy.approverRoles.filter((k) => TIERS.includes(k)) } });
      orFilters.push({ assignedRole: { key: { in: policy.approverRoles } } });
    }
    if (policy.approverGroupId) {
      orFilters.push({ groupMemberships: { some: { groupId: policy.approverGroupId } } });
    }
    if (orFilters.length) {
      const users = await prisma.user.findMany({
        where: { orgId, status: 'active', deletedAt: null, kind: 'human', OR: orFilters },
        select: { id: true, name: true, email: true },
      });
      users.forEach(add);
    }
  }

  // Fallback: the requester's direct manager, if still an active user.
  if (byId.size === 0 && manager) {
    const active = await prisma.user.findFirst({
      where: { id: manager.id, orgId, status: 'active', deletedAt: null },
      select: { id: true },
    });
    if (active) add(manager);
  }

  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Internal include shapes (reused across queries)
// ---------------------------------------------------------------------------
const REQUEST_INCLUDE = {
  requester: { select: { id: true, name: true, email: true, avatarUrl: true } },
  reviewer: { select: { id: true, name: true, email: true, avatarUrl: true } },
  server: {
    select: {
      id: true,
      hostname: true,
      displayName: true,
      environment: true,
      protocol: true,
      port: true,
      ipAddress: true,
      customerId: true,
      customer: { select: { id: true, name: true } },
    },
  },
  certificate: { select: { id: true, serial: true, status: true, validBefore: true } },
};

// ---------------------------------------------------------------------------
// Public API — submit
// ---------------------------------------------------------------------------

/**
 * Submit an access request.
 *
 * Decision tree:
 *   - prod env → PENDING (requires manager approval)
 *   - policy.requiresApproval → PENDING
 *   - policy.allowed && !requiresApproval → immediately APPROVED (auto or standard allow)
 *   - !policy.allowed → throw denied
 *
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.requesterId
 * @param {string} params.serverId
 * @param {string} params.reason
 * @param {number} params.requestedDuration  - seconds
 * @param {string} params.requestedPrincipal
 * @param {'SSH'|'RDP'} [params.protocol='SSH']
 * @returns {Promise<object>}
 */
export async function submit({
  orgId,
  requesterId,
  serverId,
  reason,
  requestedDuration,
  requestedPrincipal,
  protocol = 'SSH',
  callerRole,
  callerPermissions,
  scope = UNSCOPED,
}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!requesterId) throw new ApiError(400, 'requesterId is required');
  if (!serverId) throw new ApiError(400, 'serverId is required');
  if (!reason) throw new ApiError(400, 'reason is required');
  if (!requestedDuration || requestedDuration <= 0) {
    throw new ApiError(400, 'requestedDuration must be a positive integer (seconds)');
  }

  // Load server scoped to org
  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId },
    include: { credential: true },
  });
  if (!server) throw new ApiError(404, 'Server not found');
  // Out-of-scope reads 404 just like a nonexistent server — never let a
  // customer-scoped requester open a request against a server they can't see.
  assertServerInScope(scope, server);
  if (!isServerOnboarded(server)) {
    throw new ApiError(400, 'This server has not been onboarded yet, so access cannot be requested.');
  }

  // Load requester with manager relation
  const requester = await prisma.user.findFirst({
    where: { id: requesterId, orgId },
    include: { manager: { select: { id: true, name: true, email: true } } },
  });
  if (!requester) throw new ApiError(404, 'Requester not found');

  // Phase 21A Part 2 — JIT-aware principal resolution.
  //
  //   1. Look for an ALLOW policy that matches this user+server AND has
  //      non-empty osProvisioning (linuxGroups, sudo, aclReadPaths, or
  //      hardCutoff). If one exists, the default principal is the user's
  //      stable JIT account name (e.g. "alice_jit").
  //   2. Otherwise fall back to server.sshUser (the legacy shared-user
  //      path that existing bootstrapped hosts already use).
  //
  // Caller-supplied `requestedPrincipal` is honored as an override, but
  // only if the caller is admin/super_admin OR the value matches one of
  // the two resolved candidates. This prevents non-admins from requesting
  // arbitrary Linux usernames (which would fail at sshd auth anyway, but
  // better to reject early with a clear error).
  if (protocol === 'RDP') {
    // RDP uses the server's configured RDP account (injected by the gateway),
    // not an SSH/Linux principal — the SSH allow-list rules don't apply.
    // Credential-mode RDP servers use the stored identity's username instead
    // of Server.rdpUsername (see rdpService.buildRdpToken).
    requestedPrincipal =
      (server.authMode === 'credential' ? server.credential?.username : null) ||
      server.rdpUsername ||
      requestedPrincipal ||
      'Administrator';
  } else if (server.authMode === 'credential') {
    // Keystore (credential-mode) servers connect as the stored identity's
    // fixed username — there is no Linux allow-list concept here, so the
    // principal is not user-choosable.
    if (!server.credential) {
      throw new ApiError(400, 'This server has no identity configured');
    }
    requestedPrincipal = server.credential.username;
  } else {
    const jitPolicy = await jitManifestService.findJitPolicyForUserServer({
      orgId,
      userId: requesterId,
      serverId,
    });
    const jitPrincipal = jitPolicy ? jitManifestService.jitPrincipalFor(requester) : null;
    const legacyPrincipal = server.sshUser || 'root';
    const defaultPrincipal = jitPrincipal || legacyPrincipal;

    const isAdminCaller = has(callerPermissions, 'access.choose_principal');
    if (!requestedPrincipal) {
      requestedPrincipal = defaultPrincipal;
    } else if (!isAdminCaller) {
      const allowed = new Set([legacyPrincipal]);
      if (jitPrincipal) allowed.add(jitPrincipal);
      if (!allowed.has(requestedPrincipal)) {
        throw new ApiError(
          403,
          `Principal "${requestedPrincipal}" is not allowed for this user. Allowed: ${[...allowed].join(', ')}.`
        );
      }
    }
  }

  // Evaluate policy (handles prod hard-block internally). For RDP the principal
  // is the gateway-injected Windows account (e.g. "Administrator"), which is not
  // part of a policy's SSH allow-list — passing it would filter out every policy
  // ("No matching policy"). Evaluate RDP on subject + target only.
  const policyResult = await policyService.evaluate({
    orgId,
    userId: requesterId,
    serverId,
    requestedPrincipal: protocol === 'RDP' ? undefined : requestedPrincipal,
  });

  const now = new Date();
  let requestData;

  // Approval is policy-driven (prod defaults to requiring approval, but a
  // policy can auto-approve privileged subjects — see policyService.evaluate).
  const needsApproval = policyResult.requiresApproval;

  if (needsApproval) {
    // Resolve who may approve from the matched policy's approver routing
    // (group / roles / users), falling back to the requester's manager.
    const approverPolicy = await policyService.findApproverPolicy({
      orgId,
      userId: requesterId,
      serverId,
      requestedPrincipal,
    });
    const approvers = await resolveApprovers({
      orgId,
      requesterId,
      policy: approverPolicy,
      manager: requester.manager,
    });
    if (approvers.length === 0) {
      throw new ApiError(
        400,
        'No approver is configured for this server. Assign the requester a manager, or set an approver group/role on the matching policy.'
      );
    }

    // reviewerId holds the primary approver for backward compatibility; any of
    // the AccessRequestApprover rows may act (enforced in review()).
    const accessRequest = await prisma.accessRequest.create({
      data: {
        orgId,
        requesterId,
        serverId,
        reason,
        requestedDuration,
        requestedPrincipal,
        protocol,
        status: 'PENDING',
        reviewerId: approvers[0].id,
        approvers: { create: approvers.map((a) => ({ userId: a.id })) },
      },
      include: REQUEST_INCLUDE,
    });

    // The audit entry is written BEFORE anyone is told, and telling them
    // cannot throw. The request row is already committed at this point, so an
    // exception here used to leave an orphaned PENDING request that nobody had
    // been notified about and that had no audit row at all — the request
    // existed, and nothing in the system said how.
    await writeAudit(orgId, requesterId, 'access_request.submitted', accessRequest.id, {
      serverId,
      environment: server.environment,
      protocol,
      status: 'PENDING',
      approverCount: approvers.length,
      approverPolicyId: approverPolicy?.id || null,
    });

    // Notify every eligible approver (in-app + chat) and email a one-click
    // link. The in-app rows go one per approver; the chat message goes once.
    try {
      await notifyEvent({
        orgId,
        event: 'access_request.submitted',
        recipients: approvers.map((a) => a.id),
        title: 'New access request requires your review',
        body: `${requester.name} is requesting ${protocol} access to ${server.displayName || server.hostname} (${server.environment}). Reason: ${reason}`,
        metadata: { accessRequestId: accessRequest.id, requesterId, serverId },
        chat: {
          fields: [
            { label: 'Requester', value: requester.name },
            { label: 'Server', value: server.displayName || server.hostname },
            { label: 'Environment', value: server.environment },
            { label: 'Login as', value: requestedPrincipal },
            { label: 'Reason', value: reason },
          ],
          url: `${config.frontendUrl}/access-requests?request=${accessRequest.id}`,
          context: {
            environment: server.environment,
            customerId: server.customerId,
            accessRequestId: accessRequest.id,
            serverName: server.displayName || server.hostname,
          },
        },
      });
      // The email is separate and stays separate: each approver's link carries
      // a token minted for them alone, which is exactly what must never be
      // posted into a shared channel.
      await sendApprovalEmails({ orgId, accessRequest, requester, server, reason, approvers });
    } catch (err) {
      logger.error('accessRequestService.submit: approver notification failed', {
        requestId: accessRequest.id,
        error: err.message,
      });
    }

    logger.info('accessRequestService.submit: request created PENDING', {
      orgId,
      requestId: accessRequest.id,
      requesterId,
      serverId,
      environment: server.environment,
      approverCount: approvers.length,
    });

    // Expose resolved approvers so the email layer (F5) can address each.
    accessRequest._approvers = approvers;
    return accessRequest;
  }

  if (!policyResult.allowed) {
    throw new ApiError(403, `Access denied by policy: ${policyResult.reason}`);
  }

  // Immediately approve — clamp TTL to policy maxTtl
  const effectiveDuration =
    policyResult.maxTtl > 0
      ? Math.min(requestedDuration, policyResult.maxTtl)
      : requestedDuration;

  const expiresAt = new Date(now.getTime() + effectiveDuration * 1000);

  requestData = {
    orgId,
    requesterId,
    serverId,
    reason,
    requestedDuration,
    requestedPrincipal,
    protocol,
    status: 'APPROVED',
    reviewerId: null,
    approvedDuration: effectiveDuration,
    approvedAt: now,
    expiresAt,
  };

  const accessRequest = await prisma.accessRequest.create({
    data: requestData,
    include: REQUEST_INCLUDE,
  });

  // Notify requester of auto-approval
  await notificationService.create({
    orgId,
    userId: requesterId,
    type: 'ACCESS_REQUEST_APPROVED',
    title: 'Your access request was automatically approved',
    body: `Access to ${server.displayName || server.hostname} (${server.environment}) has been granted for ${Math.round(effectiveDuration / 60)} minutes.`,
    metadata: { accessRequestId: accessRequest.id, serverId, expiresAt },
  });

  // Production approval bypass (see docs/auth-hardening.md Revision 2
  // "Production approval"): the requester's role is at/above the org's
  // prodApprovalBypassMinRole, so the request skipped manager review. This is
  // distinct from an ordinary non-prod policy auto-approve — audited under a
  // dedicated action and the server's resolved approvers are notified
  // after the fact so the bypass is visible even though it wasn't reviewed.
  if (policyResult.prodBypass) {
    await writeAudit(orgId, requesterId, 'access_request.prod_bypass', accessRequest.id, {
      serverId,
      environment: server.environment,
      protocol,
      effectiveDuration,
      policyId: policyResult.policyId,
      requesterRole: callerRole,
      reason,
    });

    logger.info('accessRequestService.submit: prod approval bypassed by role', {
      orgId,
      requestId: accessRequest.id,
      requesterId,
      requesterRole: callerRole,
      serverId,
      effectiveDuration,
    });

    // Best-effort — notify the server's resolved approver set (from the
    // matched policy's routing, falling back to the requester's manager) so
    // the bypass doesn't happen silently. Never blocks the response.
    try {
      const approverPolicy = await policyService.findApproverPolicy({
        orgId,
        userId: requesterId,
        serverId,
        requestedPrincipal,
      });
      let approvers = await resolveApprovers({
        orgId,
        requesterId,
        policy: approverPolicy,
        manager: requester.manager,
      });
      // No approver routing (e.g. the admin prod policies) and no manager:
      // tell the people who can revoke it instead of nobody (G8).
      if (approvers.length === 0) {
        approvers = await usersWithPermission(orgId, 'access_requests.revoke_any', { excludeUserId: requesterId });
      }
      await notifyEvent({
        orgId,
        event: 'access_request.prod_bypass',
        recipients: approvers.map((a) => a.id),
        title: `Production access bypass — ${requester.name}`,
        body: `${requester.name} (${callerRole}) was auto-approved for ${protocol} access to ${server.displayName || server.hostname} (prod) without review, because their role may skip production approval. Reason: ${reason}`,
        metadata: { accessRequestId: accessRequest.id, requesterId, serverId, bypass: true },
        chat: {
          title: `Production access taken without review — ${requester.name}`,
          fields: [
            { label: 'Who', value: `${requester.name} (${callerRole})` },
            { label: 'Server', value: server.displayName || server.hostname },
            { label: 'Reason', value: reason },
          ],
          url: `${config.frontendUrl}/access-requests?request=${accessRequest.id}`,
          context: { environment: server.environment, customerId: server.customerId },
        },
      });
    } catch (err) {
      logger.warn('accessRequestService.submit: prod bypass approver notification failed', {
        requestId: accessRequest.id,
        error: err.message,
      });
    }
  } else {
    await writeAudit(orgId, requesterId, 'access_request.auto_approved', accessRequest.id, {
      serverId,
      environment: server.environment,
      protocol,
      effectiveDuration,
      policyId: policyResult.policyId,
    });

    logger.info('accessRequestService.submit: request auto-approved', {
      orgId,
      requestId: accessRequest.id,
      requesterId,
      serverId,
      effectiveDuration,
    });
  }

  return accessRequest;
}

// ---------------------------------------------------------------------------
// Public API — review
// ---------------------------------------------------------------------------

/**
 * Manager reviews a pending access request (approve or deny).
 *
 * @param {object} params
 * @param {string}  params.requestId
 * @param {string}  params.reviewerId
 * @param {'approve'|'deny'} params.decision
 * @param {number}  [params.approvedDuration]  - seconds; defaults to requestedDuration
 * @param {string}  [params.deniedReason]
 * @returns {Promise<object>}
 */
/**
 * @param {string} [params.via] - how the decision reached us: 'session' (the
 *   web UI), 'email_token' (a link from the approval email), or a chat
 *   platform. Recorded on the audit entry, because "was this production
 *   approval made by someone logged in, or by whoever held a link?" is a
 *   question the audit log could not previously answer.
 */
export async function review({ requestId, reviewerId, decision, approvedDuration, deniedReason, via = 'session' }) {
  if (!requestId) throw new ApiError(400, 'requestId is required');
  if (!reviewerId) throw new ApiError(400, 'reviewerId is required');
  if (!decision || !['approve', 'deny'].includes(decision)) {
    throw new ApiError(400, "decision must be 'approve' or 'deny'");
  }

  const accessRequest = await prisma.accessRequest.findUnique({
    where: { id: requestId },
    include: {
      ...REQUEST_INCLUDE,
      approvers: { select: { userId: true } },
    },
  });

  if (!accessRequest) throw new ApiError(404, 'Access request not found');
  // Any eligible approver (the legacy primary reviewerId OR a member of the
  // resolved approver set) may act on the request.
  const isEligibleApprover =
    accessRequest.reviewerId === reviewerId ||
    accessRequest.approvers.some((a) => a.userId === reviewerId);
  if (!isEligibleApprover) {
    throw new ApiError(403, 'You are not an eligible approver for this request');
  }
  if (accessRequest.status !== 'PENDING') {
    throw new ApiError(409, `Request is not pending (current status: ${accessRequest.status})`);
  }
  // The approver set is a snapshot from submit time; make sure the approver
  // is still an active member of this org (F-12 — email links used to work
  // for suspended or deleted approvers).
  const approverNow = await prisma.user.findFirst({
    where: { id: reviewerId, orgId: accessRequest.orgId, status: 'active', deletedAt: null },
    select: { id: true },
  });
  if (!approverNow) throw new ApiError(403, 'Your account can no longer approve requests');

  const now = new Date();
  let updated;

  if (decision === 'approve') {
    let duration =
      approvedDuration && approvedDuration > 0
        ? approvedDuration
        : accessRequest.requestedDuration;
    // Never longer than the matching policy allows (G4: approvers could
    // grant up to 7 days regardless of the policy's max session length).
    const policy = await policyService.findApproverPolicy({
      orgId: accessRequest.orgId,
      userId: accessRequest.requesterId,
      serverId: accessRequest.serverId,
      requestedPrincipal: accessRequest.requestedPrincipal || undefined,
    });
    if (policy?.maxSessionDuration > 0 && duration > policy.maxSessionDuration) {
      duration = policy.maxSessionDuration;
    }
    const expiresAt = new Date(now.getTime() + duration * 1000);

    // Conditional update, not a plain one. The PENDING check above is a
    // separate round trip, so two decisions arriving together both passed it
    // and both wrote — two approvals, two audit rows, two different expiry
    // times for one request. Making PENDING part of the WHERE means exactly
    // one writer wins; the loser is told the request was already decided.
    // (A Slack approve button will make this race ordinary rather than rare:
    // Slack re-sends any interaction it does not get a response to within
    // three seconds, and each retry is separately signed and valid.)
    const claimed = await prisma.accessRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        // Record the actual decider (may differ from the primary reviewer).
        reviewerId,
        approvedDuration: duration,
        approvedAt: now,
        expiresAt,
      },
    });
    if (claimed.count === 0) {
      throw new ApiError(409, 'Request is not pending (it was just decided by someone else)');
    }
    updated = await prisma.accessRequest.findUnique({ where: { id: requestId }, include: REQUEST_INCLUDE });

    // Audit first: the decision has already been committed above, so a
    // notification failure must not be able to lose the record of it.
    await writeAudit(
      accessRequest.orgId,
      reviewerId,
      'access_request.approved',
      requestId,
      { duration, expiresAt, via, environment: accessRequest.server?.environment ?? null }
    );

    try {
      await notificationService.create({
        orgId: accessRequest.orgId,
        userId: accessRequest.requesterId,
        type: 'ACCESS_REQUEST_APPROVED',
        title: 'Your access request was approved',
        body: `Your request for ${accessRequest.server.displayName || accessRequest.server.hostname} has been approved for ${Math.round(duration / 60)} minutes.`,
        metadata: { accessRequestId: requestId, reviewerId, expiresAt },
      });
    } catch (err) {
      logger.error('accessRequestService.review: approval notification failed', { requestId, error: err.message });
    }

    logger.info('accessRequestService.review: request approved', {
      requestId,
      reviewerId,
      duration,
      expiresAt,
    });
  } else {
    const claimed = await prisma.accessRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      data: {
        status: 'DENIED',
        reviewerId,
        deniedAt: now,
        deniedReason: deniedReason ?? null,
      },
    });
    if (claimed.count === 0) {
      throw new ApiError(409, 'Request is not pending (it was just decided by someone else)');
    }
    updated = await prisma.accessRequest.findUnique({ where: { id: requestId }, include: REQUEST_INCLUDE });

    await writeAudit(
      accessRequest.orgId,
      reviewerId,
      'access_request.denied',
      requestId,
      { deniedReason, via, environment: accessRequest.server?.environment ?? null }
    );

    try {
      await notificationService.create({
        orgId: accessRequest.orgId,
        userId: accessRequest.requesterId,
        type: 'ACCESS_REQUEST_DENIED',
        title: 'Your access request was denied',
        body: deniedReason
          ? `Your request for ${accessRequest.server.displayName || accessRequest.server.hostname} was denied. Reason: ${deniedReason}`
          : `Your request for ${accessRequest.server.displayName || accessRequest.server.hostname} was denied.`,
        metadata: { accessRequestId: requestId, reviewerId, deniedReason },
      });
    } catch (err) {
      logger.error('accessRequestService.review: denial notification failed', { requestId, error: err.message });
    }

    logger.info('accessRequestService.review: request denied', { requestId, reviewerId });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Public API — generateSshCredentials
// ---------------------------------------------------------------------------

/**
 * Generate ephemeral SSH credentials (Ed25519 private key + signed CA cert).
 * The private key is NEVER stored server-side — returned once and zeroed.
 *
 * @param {object} params
 * @param {string} params.requestId
 * @param {string} params.callerId   - Must match request.requesterId
 * @returns {Promise<{
 *   privateKey: string,
 *   certificate: string,
 *   hostname: string,
 *   port: number,
 *   username: string,
 *   expiresAt: Date,
 *   connectCommand: string,
 * }>}
 */
export async function generateSshCredentials({
  requestId,
  callerId,
  callerRole,
  callerPermissions,
  principalOverride,
}) {
  if (!requestId) throw new ApiError(400, 'requestId is required');
  if (!callerId) throw new ApiError(400, 'callerId is required');

  const accessRequest = await prisma.accessRequest.findUnique({
    where: { id: requestId },
    include: {
      server: true,
      certificate: { select: { id: true } },
    },
  });

  if (!accessRequest) throw new ApiError(404, 'Access request not found');
  if (accessRequest.requesterId !== callerId) {
    throw new ApiError(403, 'Only the requester may download credentials for this request');
  }
  if (accessRequest.status !== 'APPROVED') {
    throw new ApiError(409, `Access request is not approved (status: ${accessRequest.status})`);
  }

  const now = new Date();
  if (!accessRequest.expiresAt || accessRequest.expiresAt <= now) {
    throw new ApiError(410, 'Access request has expired');
  }

  const remainingSeconds = Math.floor((accessRequest.expiresAt.getTime() - now.getTime()) / 1000);
  if (remainingSeconds < 60) {
    throw new ApiError(410, 'Access request expires too soon to issue credentials (< 60s remaining)');
  }

  const server = accessRequest.server;
  const legacySshUser = server.sshUser || 'root';
  const isAdminCaller = has(callerPermissions, 'access.choose_principal');

  // Phase 21A Part 2 — optional per-connect principal override.
  //   - Without access.choose_principal only the AR's stored principal or the
  //     legacy sshUser are allowed. Anything else → 403.
  //   - With it, any login user the matching policy allows (F-18). On prod
  //     the approver approved one principal, so switching needs the
  //     prod-approval bypass as well.
  // If no override is passed, use the AR's stored principal as primary.
  let primaryPrincipal = accessRequest.requestedPrincipal;
  if (principalOverride) {
    const LINUX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
    if (!LINUX_USER_RE.test(principalOverride)) {
      throw new ApiError(400, 'principalOverride is not a valid Linux username');
    }
    const allowedSet = new Set([accessRequest.requestedPrincipal, legacySshUser]);
    if (!allowedSet.has(principalOverride)) {
      if (!isAdminCaller) {
        throw new ApiError(403, `Principal "${principalOverride}" is not allowed for this connection.`);
      }
      const check = await policyService.evaluate({
        orgId: accessRequest.orgId,
        userId: callerId,
        serverId: server.id,
        requestedPrincipal: principalOverride,
      });
      if (!check.allowed || check.requiresApproval) {
        throw new ApiError(
          403,
          check.requiresApproval
            ? `Connecting as "${principalOverride}" needs its own approved request.`
            : `Principal "${principalOverride}" is not allowed by policy: ${check.reason}`
        );
      }
    }
    primaryPrincipal = principalOverride;
  }

  // Sign the cert with both the primary and the legacy sshUser so the
  // client can connect as either one. Host-side check-principals will
  // validate whichever the ssh client actually asks for.
  const certPrincipals = [primaryPrincipal];
  if (legacySshUser && legacySshUser !== primaryPrincipal) {
    certPrincipals.push(legacySshUser);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellius-ssh-cred-'));
  const keyPath = path.join(tmpDir, 'id_ed25519');

  let privateKeyBuf;

  try {
    // Generate ephemeral Ed25519 key pair — no passphrase
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath]);

    const [privateKeyRaw, publicKeyRaw] = await Promise.all([
      fs.readFile(keyPath, 'utf8'),
      fs.readFile(`${keyPath}.pub`, 'utf8'),
    ]);

    privateKeyBuf = Buffer.from(privateKeyRaw, 'utf8');

    // Sign public key with the org CA — ttl = time remaining on the access request
    const { signedCert, serial, caKeyPairId } = await caService.signCertificate({
      orgId: accessRequest.orgId,
      publicKey: publicKeyRaw.trim(),
      principals: certPrincipals,
      validitySeconds: remainingSeconds,
      certType: 'USER',
      keyId: `ar-${requestId}`,
    });

    // Persist Certificate row directly (bypass certificateService.issue to avoid
    // re-running policy evaluation — access request is the already-approved gate)
    const validBefore = new Date(now.getTime() + remainingSeconds * 1000);

    const certRow = await prisma.certificate.create({
      data: {
        orgId: accessRequest.orgId,
        caKeyPairId,
        serial,
        type: 'USER',
        keyId: `ar-${requestId}`,
        principals: certPrincipals,
        publicKey: publicKeyRaw.trim(),
        signedCert,
        validAfter: now,
        validBefore,
        status: 'ACTIVE',
        issuedToId: callerId,
        issuedForId: server.id,
        issuedVia: 'access_request',
      },
    });

    // Link certificate to the access request
    await prisma.accessRequest.update({
      where: { id: requestId },
      data: { certificateId: certRow.id },
    });

    await writeAudit(
      accessRequest.orgId,
      callerId,
      'access_request.ssh_credentials_generated',
      requestId,
      { certId: certRow.id, principal: primaryPrincipal, principals: certPrincipals, remainingSeconds }
    );

    logger.info('accessRequestService.generateSshCredentials: credentials issued', {
      requestId,
      callerId,
      certId: certRow.id,
      principal: primaryPrincipal,
      remainingSeconds,
    });

    const port = server.port ?? 22;
    // Use the routable IP for the connect command — the user's machine usually
    // can't resolve the server's internal hostname (e.g. ip-172-31-37-143).
    // accept-new mirrors the web terminal so the first connect isn't blocked by
    // an interactive host-key prompt.
    const connectHost = server.ipAddress || server.hostname;
    const connectCommand =
      `ssh -i id_ed25519 -o CertificateFile=id_ed25519-cert.pub -o StrictHostKeyChecking=accept-new ${primaryPrincipal}@${connectHost} -p ${port}`;

    const result = {
      privateKey: privateKeyBuf.toString('utf8'),
      certificate: signedCert,
      hostname: server.hostname,
      // Prefer the IP address for the actual SSH connection — the backend
      // container's DNS may not resolve user-supplied hostnames.
      address: server.ipAddress || server.hostname,
      port,
      username: primaryPrincipal,
      expiresAt: accessRequest.expiresAt,
      connectCommand,
    };

    return result;
  } finally {
    // Zero out in-memory private key buffer
    if (privateKeyBuf) {
      privateKeyBuf.fill(0);
    }
    // Always remove temp files — private key never persists
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Public API — generateRdpFile
// ---------------------------------------------------------------------------

/**
 * Generate a downloadable .rdp file for an approved RDP access request.
 *
 * The file targets the RDP server directly (MSTSC format). The RDP password
 * is NEVER included in the file — it is injected by Guacamole at the
 * browser-terminal layer only.
 *
 * Security note: Windows MSTSC .rdp files connect directly to the target
 * host when network-reachable. For true RD Gateway support (which wraps the
 * RDP connection in HTTPS), a separate Windows RD Gateway component is
 * required. The gatewayToken field is embedded as a comment line for
 * Shellius-aware tooling; standard MSTSC ignores comment lines.
 *
 * TODO(rdp-gateway): When a real RD Gateway is deployed, replace
 *   `full address` with the gateway's public hostname and set
 *   `gatewayhostname` + `gatewaycredentialssource:i:5` (token-based auth).
 *   The gatewayToken JWT can be presented as the gateway access token.
 *   Until then, the .rdp file connects directly and the browser terminal
 *   (WebSocket → guacd path) should be preferred for credential injection.
 *
 * @param {object} params
 * @param {string} params.requestId
 * @param {string} params.callerId
 * @returns {Promise<{ filename: string, content: string, expiresAt: Date }>}
 */
export async function generateRdpFile({ requestId, callerId, scope = UNSCOPED }) {
  if (!requestId) throw new ApiError(400, 'requestId is required');
  if (!callerId) throw new ApiError(400, 'callerId is required');

  const accessRequest = await prisma.accessRequest.findUnique({
    where: { id: requestId },
    include: { server: true },
  });

  if (!accessRequest) throw new ApiError(404, 'Access request not found');
  if (accessRequest.requesterId !== callerId) {
    throw new ApiError(403, 'Only the requester may download credentials for this request');
  }
  if (accessRequest.status !== 'APPROVED') {
    throw new ApiError(409, `Access request is not approved (status: ${accessRequest.status})`);
  }

  const now = new Date();
  if (!accessRequest.expiresAt || accessRequest.expiresAt <= now) {
    throw new ApiError(410, 'Access request has expired');
  }

  // Issue gateway token for Guacamole / Shellius-aware tooling
  const { server, gatewayToken } = await rdpService.createConnectionForRequest(requestId, scope);

  const rdpPort = server.port ?? 3389;
  const publicGatewayHost = process.env.PUBLIC_GATEWAY_HOST || 'localhost';
  const rdpUsername = server.rdpUsername || accessRequest.requestedPrincipal;

  // .rdp file in Windows MSTSC format (key:type:value, CRLF line endings).
  // Comment lines begin with a bare text prefix before the first colon — MSTSC
  // ignores lines it does not recognise, so custom metadata is safe to include.
  const lines = [
    // shellius metadata (treated as unknown keys by MSTSC — safely ignored)
    `shellius-request-id:s:${requestId}`,
    `shellius-expires-at:s:${accessRequest.expiresAt.toISOString()}`,
    // NOTE: gatewayToken is NOT the RDP password — it is a short-lived JWT
    // for the Shellius WebSocket RDP proxy. The RDP password is never exposed.
    `shellius-gateway-token:s:${gatewayToken}`,
    '',
    // Display
    'screen mode id:i:2',
    'use multimon:i:0',
    'desktopwidth:i:1920',
    'desktopheight:i:1080',
    'session bpp:i:32',
    'smart sizing:i:0',
    'displayconnectionbar:i:1',
    '',
    // Connection — direct to server (see TODO above re: RD Gateway).
    // Prefer the routable IP so MSTSC connects even when the display hostname
    // isn't DNS-resolvable; dynamicIp overrides are persisted into ipAddress.
    `full address:s:${server.ipAddress || server.hostname}:${rdpPort}`,
    `username:s:${rdpUsername}`,
    '',
    // Gateway fields — currently pointing at target server directly.
    // Replace with real RD Gateway hostname when available.
    `gatewayhostname:s:${publicGatewayHost}`,
    'gatewayusagemethod:i:1',
    'gatewaycredentialssource:i:4',
    'gatewayprofileusagemethod:i:1',
    '',
    // Security
    'authentication level:i:2',
    'prompt for credentials:i:0',
    'negotiate security layer:i:1',
    'enablecredsspsupport:i:1',
    '',
    // Performance
    'connection type:i:7',
    'networkautodetect:i:1',
    'bandwidthautodetect:i:1',
    'compression:i:1',
    'disable wallpaper:i:0',
    'allow font smoothing:i:1',
    'allow desktop composition:i:1',
    'disable full window drag:i:1',
    'disable menu anims:i:1',
    'disable themes:i:0',
    'bitmapcachepersistenable:i:1',
    '',
    // Audio / input
    'audiocapturemode:i:0',
    'videoplaybackmode:i:1',
    'keyboardhook:i:2',
    'redirectclipboard:i:1',
    'remoteapplicationmode:i:0',
  ];

  const rdpContent = lines.join('\r\n');

  await writeAudit(
    accessRequest.orgId,
    callerId,
    'access_request.rdp_file_generated',
    requestId,
    { hostname: server.hostname, rdpPort }
  );

  logger.info('accessRequestService.generateRdpFile: RDP file generated', {
    requestId,
    callerId,
    hostname: server.hostname,
  });

  return {
    filename: `shellius-${requestId}.rdp`,
    content: rdpContent,
    expiresAt: accessRequest.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Public API — revoke
// ---------------------------------------------------------------------------

/**
 * Revoke an access request.
 * Caller needs access_requests.revoke_any, or must be one of the request's
 * approvers (the one who decided or anyone else in the approver set).
 *
 * @param {object} params
 * @param {string} params.requestId
 * @param {string} params.callerId
 * @param {string} params.orgId
 * @param {Set<string>} params.callerPermissions
 * @param {string} [params.reason]
 * @returns {Promise<object>}
 */
export async function revoke({ requestId, orgId, callerId, callerPermissions, reason }) {
  if (!requestId) throw new ApiError(400, 'requestId is required');
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!callerId) throw new ApiError(400, 'callerId is required');

  // Org-scoped lookup (F-07: a bare findUnique let one org revoke another's).
  const accessRequest = await prisma.accessRequest.findFirst({
    where: { id: requestId, orgId },
    include: { server: { select: { hostname: true, displayName: true } }, approvers: { select: { userId: true } } },
  });

  if (!accessRequest) throw new ApiError(404, 'Access request not found');

  // Anyone who could approve it may also take it back.
  const canRevoke =
    has(callerPermissions, 'access_requests.revoke_any') ||
    accessRequest.reviewerId === callerId ||
    accessRequest.approvers.some((a) => a.userId === callerId);
  if (!canRevoke) {
    throw new ApiError(403, 'You do not have permission to revoke this access request');
  }

  if (accessRequest.status === 'REVOKED') {
    throw new ApiError(409, 'Access request is already revoked');
  }

  const now = new Date();

  await prisma.accessRequest.update({
    where: { id: requestId },
    data: {
      status: 'REVOKED',
      revokedAt: now,
      revokedReason: reason ?? null,
    },
  });

  // Revoke associated certificate if one was issued
  if (accessRequest.certificateId) {
    try {
      await caService.revokeCertificate(accessRequest.certificateId, callerId);
    } catch (err) {
      // Log but do not fail the revoke operation if cert is already revoked / not found
      logger.warn('accessRequestService.revoke: certificate revocation failed', {
        requestId,
        certId: accessRequest.certificateId,
        error: err.message,
      });
    }
  }

  // Notify the requester
  await notificationService.create({
    orgId: accessRequest.orgId,
    userId: accessRequest.requesterId,
    type: 'ACCESS_REQUEST_REVOKED',
    title: 'Your access has been revoked',
    body: reason
      ? `Your access to ${accessRequest.server.displayName || accessRequest.server.hostname} was revoked. Reason: ${reason}`
      : `Your access to ${accessRequest.server.displayName || accessRequest.server.hostname} was revoked.`,
    metadata: { accessRequestId: requestId, revokedBy: callerId, reason },
  });

  await writeAudit(
    accessRequest.orgId,
    callerId,
    'access_request.revoked',
    requestId,
    { reason, certId: accessRequest.certificateId }
  );

  logger.info('accessRequestService.revoke: request revoked', { requestId, callerId });

  return prisma.accessRequest.findUnique({ where: { id: requestId }, include: REQUEST_INCLUDE });
}

// ---------------------------------------------------------------------------
// Public API — getActiveByServerForUser
// ---------------------------------------------------------------------------

/**
 * Find the most recent APPROVED, non-expired access request for a given
 * (orgId, userId, serverId) tuple. Returns the AR row or null if none exists.
 *
 * Used by the Quick Connect button on the Servers list page.
 *
 * @param {string} orgId    - tenant scope (Task 15R-D fix)
 * @param {string} userId
 * @param {string} serverId
 * @returns {Promise<object|null>}
 */
export async function getActiveByServerForUser(orgId, userId, serverId) {
  const now = new Date();
  const ar = await prisma.accessRequest.findFirst({
    where: {
      orgId, // tenant isolation — prevents cross-org existence oracle (15R-D)
      requesterId: userId,
      serverId,
      status: 'APPROVED',
      expiresAt: { gt: now },
    },
    orderBy: { approvedAt: 'desc' },
    include: REQUEST_INCLUDE,
  });
  return ar; // null when none
}

// ---------------------------------------------------------------------------
// list() sort whitelist — every value here MUST also be enumerated in the
// route's Joi schema (routes/accessRequests.js `listQuerySchema.sortBy`), so
// an unrecognised column is rejected with a 400 before it ever reaches here.
// ---------------------------------------------------------------------------
function buildOrderBy(sortBy, sortDir) {
  const dir = sortDir === 'asc' ? 'asc' : 'desc';
  switch (sortBy) {
    case 'status':
      return { status: dir };
    case 'requestedDuration':
      return { requestedDuration: dir };
    case 'server':
      return { server: { hostname: dir } };
    case 'createdAt':
    default:
      return { createdAt: dir };
  }
}

// ---------------------------------------------------------------------------
// Public API — list
// ---------------------------------------------------------------------------

/**
 * List access requests.
 *
 * tab='mine'      → requests where requesterId === userId (all roles)
 * tab='to-review' → requests where reviewerId === userId AND status=PENDING
 * tab='all'       → all requests in org (access_requests.view_all)
 *
 * @param {object} params
 * @param {string}  params.orgId
 * @param {string}  params.userId
 * @param {Set<string>} params.permissions
 * @param {string}  [params.tab='mine']
 * @param {string}  [params.status]   optional status filter (PENDING, APPROVED, …)
 * @param {string}  [params.search]   matches reason, server hostname/displayName/ip, requester name/email
 * @param {string}  [params.reviewerId] matches the primary reviewer OR the resolved approver set
 * @param {string}  [params.customerId] via the server relation, ANDed with scope
 * @param {string}  [params.sortBy='createdAt']  one of createdAt|status|requestedDuration|server
 * @param {string}  [params.sortDir='desc']
 * @param {number}  [params.page=1]
 * @param {number}  [params.limit=25]
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
export async function list({
  orgId,
  userId,
  permissions,
  tab = 'mine',
  status,
  serverId,
  requesterId,
  reviewerId,
  customerId,
  protocol,
  environment,
  search,
  sortBy = 'createdAt',
  sortDir = 'desc',
  startDate,
  endDate,
  page = 1,
  limit = 25,
  scope = UNSCOPED,
}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!userId) throw new ApiError(400, 'userId is required');

  page = parseInt(page, 10) || 1;
  limit = Math.min(parseInt(limit, 10) || 25, 100);

  let where;
  if (tab === 'all') {
    if (!has(permissions, 'access_requests.view_all')) {
      throw new ApiError(403, "You don't have permission to view all access requests");
    }
    // Only tab=all is customer-scoped. 'mine' is the caller's own requests
    // (submit() already rejects out-of-scope servers, so nothing to filter),
    // and 'to-review' deliberately stays unscoped — an approver named by
    // policy may legitimately sit outside the server's customer (spec §4.3,
    // open question 3).
    where = { orgId, ...relationScopeWhere(scope, 'server') };
  } else if (tab === 'to-review') {
    // Surface requests where the user is the primary reviewer OR a member of
    // the resolved approver set.
    where = {
      orgId,
      status: 'PENDING',
      OR: [{ reviewerId: userId }, { approvers: { some: { userId } } }],
    };
  } else {
    // 'mine' (default)
    where = { orgId, requesterId: userId };
  }

  // Additional filters, ANDed on top of the tab's base predicate so they can
  // only narrow — never widen — what the tab (and its scope) already allows.
  const extra = [];
  if (status) extra.push({ status });
  if (serverId) extra.push({ serverId });
  // requesterId only makes sense outside 'mine' (which is already scoped to
  // the caller) — harmless to accept there too, it just narrows to nothing
  // or to the caller themselves.
  if (requesterId) extra.push({ requesterId });
  // Any eligible approver — the primary reviewerId OR a member of the
  // resolved approver set — matches, same eligibility rule review()/getById()
  // already use.
  if (reviewerId) extra.push({ OR: [{ reviewerId }, { approvers: { some: { userId: reviewerId } } }] });
  // Merged as its own AND element (never spread into an existing `server`
  // key) so it composes with `environment` above instead of clobbering it.
  if (customerId) extra.push({ server: { customerId } });
  if (protocol) extra.push({ protocol });
  if (environment) extra.push({ server: { environment } });
  if (search) {
    const q = search.trim();
    if (q) {
      extra.push({
        OR: [
          { reason: { contains: q, mode: 'insensitive' } },
          { server: { hostname: { contains: q, mode: 'insensitive' } } },
          { server: { displayName: { contains: q, mode: 'insensitive' } } },
          { server: { ipAddress: { contains: q, mode: 'insensitive' } } },
          { requester: { name: { contains: q, mode: 'insensitive' } } },
          { requester: { email: { contains: q, mode: 'insensitive' } } },
        ],
      });
    }
  }
  if (startDate || endDate) {
    const createdAt = {};
    if (startDate) createdAt.gte = new Date(startDate);
    if (endDate) createdAt.lte = endOfDayInclusive(endDate);
    extra.push({ createdAt });
  }
  if (extra.length > 0) where = { AND: [where, ...extra] };

  const [items, total] = await Promise.all([
    prisma.accessRequest.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: buildOrderBy(sortBy, sortDir),
      include: REQUEST_INCLUDE,
    }),
    prisma.accessRequest.count({ where }),
  ]);

  return { items, total, page, limit };
}

// ---------------------------------------------------------------------------
// Public API — getById
// ---------------------------------------------------------------------------

/**
 * Get a single access request.
 * Visible to the requester, any of its approvers, or holders of
 * access_requests.view_all (secondary approvers used to get a 403 on the
 * request they were asked to approve — UI-2.11).
 *
 * @param {object} params
 * @param {string} params.requestId
 * @param {string} params.callerId
 * @param {Set<string>} params.callerPermissions
 * @param {{mode: string, customerIds: string[]}} [params.scope=UNSCOPED]
 * @returns {Promise<object>}
 */
export async function getById({ requestId, orgId, callerId, callerPermissions, scope = UNSCOPED }) {
  if (!requestId) throw new ApiError(400, 'requestId is required');
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!callerId) throw new ApiError(400, 'callerId is required');

  // Org-scoped: an admin's "can view any request" applies to their own org only.
  const accessRequest = await prisma.accessRequest.findFirst({
    where: { id: requestId, orgId },
    include: { ...REQUEST_INCLUDE, approvers: { select: { userId: true } } },
  });

  if (!accessRequest) throw new ApiError(404, 'Access request not found');

  const isRequester = accessRequest.requesterId === callerId;
  const isApprover =
    accessRequest.reviewerId === callerId || accessRequest.approvers.some((a) => a.userId === callerId);
  const isViaViewAll = has(callerPermissions, 'access_requests.view_all');
  const canView = isViaViewAll || isRequester || isApprover;

  if (!canView) {
    throw new ApiError(403, 'You do not have permission to view this access request');
  }

  // Customer scope applies ONLY to the access_requests.view_all path — the
  // requester's own request was already validated against their scope at
  // submit() time, and a named approver may legitimately sit outside the
  // customer (spec §4.3, open question 3: being named an approver is an
  // explicit grant that outranks scope). Scoping those reads would silently
  // strand an approval the requester is waiting on.
  if (isViaViewAll && !isRequester && !isApprover) {
    assertServerInScope(scope, accessRequest.server);
  }

  // Tell the client what this caller may do with it, so the UI never offers
  // a button the API will refuse (UI-2.9 / 2.10).
  const { approvers, ...rest } = accessRequest;
  return {
    ...rest,
    viewer: {
      canReview: isApprover && accessRequest.status === 'PENDING' && accessRequest.requesterId !== callerId,
      canRevoke:
        accessRequest.status === 'APPROVED' && (has(callerPermissions, 'access_requests.revoke_any') || isApprover),
    },
  };
}

// ---------------------------------------------------------------------------
// Public API — markExpired (job helper)
// ---------------------------------------------------------------------------

/**
 * Transition APPROVED requests whose expiresAt has passed to EXPIRED.
 * Revokes any linked certificates and notifies requesters.
 * Returns the count of requests transitioned.
 *
 * @returns {Promise<number>}
 */
export async function markExpired() {
  const now = new Date();

  // Find all approved requests that have passed their expiry
  const expired = await prisma.accessRequest.findMany({
    where: {
      status: 'APPROVED',
      expiresAt: { lt: now },
    },
    include: {
      server: { select: { hostname: true, displayName: true } },
    },
  });

  if (expired.length === 0) return 0;

  let count = 0;
  for (const req of expired) {
    try {
      await prisma.accessRequest.update({
        where: { id: req.id },
        data: { status: 'EXPIRED' },
      });

      if (req.certificateId) {
        try {
          await caService.revokeCertificate(req.certificateId, null);
        } catch (certErr) {
          logger.warn('accessRequestService.markExpired: cert revocation failed', {
            requestId: req.id,
            certId: req.certificateId,
            error: certErr.message,
          });
        }
      }

      await notificationService.create({
        orgId: req.orgId,
        userId: req.requesterId,
        type: 'ACCESS_REQUEST_EXPIRED',
        title: 'Your access has expired',
        body: `Your access to ${req.server.displayName || req.server.hostname} has expired.`,
        metadata: { accessRequestId: req.id },
      });

      count++;
    } catch (err) {
      logger.error('accessRequestService.markExpired: failed to expire request', {
        requestId: req.id,
        error: err.message,
      });
    }
  }

  if (count > 0) {
    logger.info('accessRequestService.markExpired: transitioned requests to EXPIRED', { count });
  }

  return count;
}

// ---------------------------------------------------------------------------
// Public API — markPendingExpired (job helper)
// ---------------------------------------------------------------------------

/**
 * Transition PENDING requests older than 24 hours to EXPIRED.
 * Notifies requesters.
 * Returns the count of requests transitioned.
 *
 * @returns {Promise<number>}
 */
export async function markPendingExpired() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const stale = await prisma.accessRequest.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: cutoff },
    },
    include: {
      server: { select: { hostname: true, displayName: true } },
    },
  });

  if (stale.length === 0) return 0;

  let count = 0;
  for (const req of stale) {
    try {
      await prisma.accessRequest.update({
        where: { id: req.id },
        data: { status: 'EXPIRED' },
      });

      await notificationService.create({
        orgId: req.orgId,
        userId: req.requesterId,
        type: 'ACCESS_REQUEST_EXPIRED',
        title: 'Your pending access request has expired',
        body: `Your pending request for access to ${req.server.displayName || req.server.hostname} was not reviewed within 24 hours and has expired.`,
        metadata: { accessRequestId: req.id },
      });

      count++;
    } catch (err) {
      logger.error('accessRequestService.markPendingExpired: failed to expire pending request', {
        requestId: req.id,
        error: err.message,
      });
    }
  }

  if (count > 0) {
    logger.info('accessRequestService.markPendingExpired: transitioned pending requests to EXPIRED', {
      count,
    });
  }

  return count;
}

// ---------------------------------------------------------------------------
// Public API — notifyExpiringAccess (job helper)
// ---------------------------------------------------------------------------

/**
 * Send ACCESS_REQUEST_EXPIRING notifications for APPROVED requests whose
 * expiresAt falls within the next 10 minutes, deduplicated by checking
 * whether a notification of that type already exists for each request.
 *
 * @returns {Promise<number>} Count of notifications created
 */
export async function notifyExpiringAccess() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 10 * 60 * 1000);

  const expiring = await prisma.accessRequest.findMany({
    where: {
      status: 'APPROVED',
      expiresAt: { gt: now, lte: windowEnd },
    },
    include: {
      server: { select: { hostname: true, displayName: true } },
    },
  });

  if (expiring.length === 0) return 0;

  let count = 0;
  for (const req of expiring) {
    try {
      // Deduplication: check for an existing ACCESS_REQUEST_EXPIRING notification
      // for this requester + requestId combination. O(n) per batch is acceptable
      // for the expected volume of concurrent expiring requests.
      const existing = await prisma.notification.findFirst({
        where: {
          userId: req.requesterId,
          type: 'ACCESS_REQUEST_EXPIRING',
          metadata: {
            path: ['requestId'],
            equals: req.id,
          },
        },
      });

      if (existing) continue;

      await notificationService.create({
        orgId: req.orgId,
        userId: req.requesterId,
        type: 'ACCESS_REQUEST_EXPIRING',
        title: 'Your access is expiring soon',
        body: `Your access to ${req.server.displayName || req.server.hostname} expires at ${req.expiresAt.toISOString()}. Download credentials now if you still need them.`,
        metadata: { requestId: req.id, expiresAt: req.expiresAt },
      });

      count++;
    } catch (err) {
      logger.error('accessRequestService.notifyExpiringAccess: failed to notify', {
        requestId: req.id,
        error: err.message,
      });
    }
  }

  if (count > 0) {
    logger.info('accessRequestService.notifyExpiringAccess: sent expiry warning notifications', { count });
  }

  return count;
}

export default {
  submit,
  review,
  generateSshCredentials,
  generateRdpFile,
  revoke,
  list,
  getById,
  getActiveByServerForUser,
  markExpired,
  markPendingExpired,
  notifyExpiringAccess,
  createBreakGlass,
  startBreakGlass,
  verifyBreakGlass,
  getAccessIntent,
  getAccessIntentsBulk,
};

// ---------------------------------------------------------------------------
// getAccessIntent — one-shot "what should the UI do for this server"
// ---------------------------------------------------------------------------

/**
 * Aggregates the minimum state a client needs to render the Request
 * Access / Connect button correctly for a given (user, server).
 *
 * Returned shape:
 *   {
 *     hasActiveAccess: boolean,           // APPROVED + not-expired AR exists
 *     activeRequestId: string | null,
 *     hasPendingRequest: boolean,         // a PENDING AR exists (neither req nor connect fits)
 *     preferredPrincipal: string,         // what to pre-fill in the form
 *     allowedPrincipals: string[],        // all legal values for this user
 *     adminCanOverride: boolean,          // whether the current caller can type custom
 *     protocol: 'SSH' | 'RDP',            // normalized
 *     requiresApproval: boolean,          // prod always, or policy says so
 *     isProduction: boolean,
 *     jitEnabled: boolean,                // a matching policy has osProvisioning
 *   }
 *
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.userId
 * @param {Set<string>} params.permissions
 * @param {string} params.serverId
 * @param {{mode: string, customerIds: string[]}} [params.scope=UNSCOPED]
 * @returns {Promise<object>}
 */
export async function getAccessIntent({ orgId, userId, permissions, serverId, scope = UNSCOPED }) {
  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId },
    select: {
      id: true,
      sshUser: true,
      environment: true,
      protocol: true,
      customerId: true,
    },
  });
  if (!server) throw new ApiError(404, 'Server not found');
  // Confirms a serverId exists (spec §4.1 #11) — out-of-scope must 404 just
  // like a nonexistent server.
  assertServerInScope(scope, server);

  const user = await prisma.user.findFirst({
    where: { id: userId, orgId },
    select: { id: true, email: true, name: true },
  });
  if (!user) throw new ApiError(404, 'User not found');

  // Active (APPROVED, unexpired) + pending lookups, in parallel.
  const [activeAr, pendingAr, jitPolicy] = await Promise.all([
    prisma.accessRequest.findFirst({
      where: {
        orgId,
        requesterId: userId,
        serverId,
        status: 'APPROVED',
        expiresAt: { gt: new Date() },
      },
      orderBy: { approvedAt: 'desc' },
      select: { id: true, requestedPrincipal: true, expiresAt: true, breakGlass: true },
    }),
    prisma.accessRequest.findFirst({
      where: {
        orgId,
        requesterId: userId,
        serverId,
        status: 'PENDING',
      },
      select: { id: true },
    }),
    jitManifestService.findJitPolicyForUserServer({ orgId, userId, serverId }),
  ]);

  const legacyPrincipal = server.sshUser || 'root';
  const jitPrincipal = jitPolicy ? jitManifestService.jitPrincipalFor(user) : null;
  const allowed = [legacyPrincipal];
  if (jitPrincipal && !allowed.includes(jitPrincipal)) allowed.push(jitPrincipal);

  // When the user has an active AR, honor the principal that was signed
  // into the cert — even admins shouldn't silently swap it. But admins
  // can still override at connect time via the override UI.
  const preferred = activeAr?.requestedPrincipal
    ? activeAr.requestedPrincipal
    : jitPrincipal || legacyPrincipal;

  // Normalize protocol (server stores lowercase ssh/rdp/both).
  let protocol = 'SSH';
  const p = String(server.protocol || 'ssh').toLowerCase();
  if (p === 'rdp') protocol = 'RDP';

  const isProduction = server.environment === 'prod';
  const skipsProdApproval = isProduction && (await canBypassProdApproval(orgId, permissions));

  return {
    hasActiveAccess: !!activeAr,
    activeRequestId: activeAr?.id || null,
    hasPendingRequest: !!pendingAr && !activeAr,
    preferredPrincipal: preferred,
    allowedPrincipals: allowed,
    adminCanOverride: has(permissions, 'access.choose_principal'),
    protocol,
    // Prod: unless the caller may skip approval. Non-prod policies can also
    // require approval — the full evaluation still runs on submit.
    requiresApproval: isProduction && !skipsProdApproval,
    isProduction,
    jitEnabled: !!jitPolicy,
    breakGlass: !!activeAr?.breakGlass,
  };
}

// ---------------------------------------------------------------------------
// getAccessIntentsBulk — batched version of getAccessIntent for N servers
// ---------------------------------------------------------------------------

/**
 * Lightweight, batched sibling of `getAccessIntent`: given a list of server
 * ids, reports just enough for a list UI (e.g. the "New connection" dialog)
 * to pick Connect / Pending / Request access per row without an N+1 request
 * fan-out. Two `findMany` calls total, regardless of `serverIds.length`.
 *
 * Does NOT resolve JIT/preferred-principal state (see `getAccessIntent` for
 * that) — callers that need the full single-server intent (e.g. to actually
 * open a connection) should still call `getAccessIntent` for that one server.
 *
 * Admin/super_admin bypass: mirrors `getAccessIntent`, which does not grant
 * admins implicit access — `hasActiveAccess` only reflects a real APPROVED,
 * unexpired AccessRequest row the caller owns. Admins get the same
 * `hasActiveAccess`/`hasPendingRequest` as anyone else; their only special
 * power (bypassing manager approval) happens inside `submit()` and shows up
 * here as a normal APPROVED row once they submit.
 *
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.userId
 * @param {string[]} params.serverIds - already deduped/capped by the caller (route enforces max 50)
 * @param {{mode: string, customerIds: string[]}} [params.scope=UNSCOPED]
 * @returns {Promise<Record<string, {hasActiveAccess:boolean, activeRequestId:string|null, hasPendingRequest:boolean, pendingRequestId:string|null, expiresAt:string|null}>>}
 */
export async function getAccessIntentsBulk({ orgId, userId, serverIds, scope = UNSCOPED }) {
  const ids = [...new Set(serverIds)].filter(Boolean);
  const intents = {};
  for (const id of ids) {
    intents[id] = {
      hasActiveAccess: false,
      activeRequestId: null,
      hasPendingRequest: false,
      pendingRequestId: null,
      expiresAt: null,
    };
  }
  if (ids.length === 0) return intents;

  // Reject the whole batch if it names a server outside the caller's scope,
  // matching the single-server /intent endpoint (assertServerInScope) —
  // silently dropping the id instead would make a scope violation invisible
  // rather than a 404.
  if (!isUnscoped(scope)) {
    const inScopeCount = await prisma.server.count({
      where: { orgId, id: { in: ids }, ...serverScopeWhere(scope) },
    });
    if (inScopeCount !== ids.length) {
      throw new ApiError(404, 'Server not found');
    }
  }

  const [activeArs, pendingArs] = await Promise.all([
    prisma.accessRequest.findMany({
      where: {
        orgId,
        requesterId: userId,
        serverId: { in: ids },
        status: 'APPROVED',
        expiresAt: { gt: new Date() },
      },
      orderBy: { approvedAt: 'desc' },
      select: { id: true, serverId: true, expiresAt: true },
    }),
    prisma.accessRequest.findMany({
      where: {
        orgId,
        requesterId: userId,
        serverId: { in: ids },
        status: 'PENDING',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, serverId: true },
    }),
  ]);

  // Most-recent-first ordering above means the first hit per serverId wins,
  // matching getAccessIntent's orderBy: { approvedAt: 'desc' }.
  for (const ar of activeArs) {
    const entry = intents[ar.serverId];
    if (!entry || entry.hasActiveAccess) continue;
    entry.hasActiveAccess = true;
    entry.activeRequestId = ar.id;
    entry.expiresAt = ar.expiresAt;
  }
  for (const ar of pendingArs) {
    const entry = intents[ar.serverId];
    if (!entry || entry.hasActiveAccess || entry.hasPendingRequest) continue;
    entry.hasPendingRequest = true;
    entry.pendingRequestId = ar.id;
  }

  return intents;
}

// ---------------------------------------------------------------------------
// Break-glass — step-up-verified emergency access (start/verify)
// ---------------------------------------------------------------------------
//
// Two-step flow (docs/rbac/access-policies.md §1.3 "Break-glass Production"):
//   1. startBreakGlass  — validate the request, resolve a matching
//      `isBreakGlass: true` ALLOW policy (this is what makes the flag mean
//      something — see policyService.findBreakGlassPolicy), and issue a
//      short-lived Redis challenge that requires a second factor: the user's
//      enrolled MFA (TOTP or email OTP) when they have one, otherwise a
//      break-glass code emailed on the spot. Reuses mfaService end to end
//      (availableMethods/sendEmailOtp/verifyFactor) rather than a parallel
//      code path.
//   2. verifyBreakGlass — burn the challenge against the code, re-check
//      every invariant that could have changed since start() (policy still
//      matches, prod-bypass switch still on, no other break-glass session
//      already active on this server), then create the pre-approved
//      AccessRequest exactly as the old single-step endpoint did.
//
// The legacy single-step endpoint (`createBreakGlass`, below) now always
// refuses — nothing can grant break-glass access without passing through
// verify().

const BREAK_GLASS_CHALLENGE_TTL_SEC = 5 * 60;
const BREAK_GLASS_MAX_ATTEMPTS = 5;
const BREAK_GLASS_REDIS_PREFIX = 'breakglass:challenge:';
const BREAK_GLASS_ATTEMPTS_PREFIX = 'breakglass:attempts:';

function maskEmail(email) {
  const [u, d] = String(email || '').split('@');
  if (!d) return email;
  return `${u.slice(0, 2)}***@${d}`;
}

async function burnBreakGlassChallenge(challengeId) {
  await Promise.all([
    redis.del(BREAK_GLASS_REDIS_PREFIX + challengeId),
    redis.del(BREAK_GLASS_ATTEMPTS_PREFIX + challengeId),
  ]);
}

/** Prod-bypass switch check, shared by start() and verify() (re-checked at
 * both points since the org setting can change between the two calls). */
async function assertBreakGlassProdAllowed(orgId, server) {
  if (server.environment === 'prod' && !(await isProdBypassEnabled(orgId))) {
    throw new ApiError(403, 'Your organization requires approval for all production access, including break-glass', {
      code: 'BREAK_GLASS_PROD_BYPASS_DISABLED',
    });
  }
}

/** No two overlapping break-glass sessions on the same server — re-checked
 * at both start() (fast UX signal) and verify() (the authoritative check,
 * right before granting). */
async function assertNoActiveBreakGlass(orgId, serverId) {
  const active = await prisma.accessRequest.findFirst({
    where: { orgId, serverId, breakGlass: true, status: 'APPROVED', expiresAt: { gt: new Date() } },
    select: { id: true, expiresAt: true },
  });
  if (active) {
    throw new ApiError(
      409,
      `Break-glass access to this server is already active until ${active.expiresAt.toISOString()}.`,
      { code: 'BREAK_GLASS_ALREADY_ACTIVE' }
    );
  }
}

/**
 * Step 1 — validate the request and issue a step-up verification challenge.
 * Does NOT grant anything: no AccessRequest exists until verifyBreakGlass()
 * succeeds.
 *
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.invokerId
 * @param {Set<string>} params.invokerPermissions - must include access.break_glass
 * @param {string} params.serverId
 * @param {string} params.reason                  - mandatory, min 20 chars
 * @param {number} [params.durationSeconds]        - clamped to [300, matched policy's maxSessionDuration]
 * @param {'totp'|'email'} [params.method]         - which enrolled factor to use; required when the user has more than one
 * @param {{mode: string, customerIds: string[]}} [params.scope=UNSCOPED]
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 * @returns {Promise<{ challengeId: string, method: 'totp'|'email', emailHint?: string, expiresIn: number }>}
 */
export async function startBreakGlass({
  orgId,
  invokerId,
  invokerPermissions,
  serverId,
  reason,
  durationSeconds,
  method,
  scope = UNSCOPED,
  ip,
  userAgent,
}) {
  if (!has(invokerPermissions, 'access.break_glass')) {
    throw new ApiError(403, "You don't have permission to use break-glass access");
  }
  const trimmedReason = String(reason || '').trim();
  if (trimmedReason.length < 20) {
    throw new ApiError(400, 'reason must be at least 20 characters');
  }

  const server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!server) throw new ApiError(404, 'Server not found');
  // A scoped caller must not be able to use break-glass to reach a server
  // outside their own visibility limit.
  assertServerInScope(scope, server);
  await assertBreakGlassProdAllowed(orgId, server);

  // The one rule that makes AccessPolicy.isBreakGlass mean something: break-
  // glass may only target a server an active isBreakGlass ALLOW policy names
  // for THIS user (deny-before-allow still applies — see policyService).
  const policy = await policyService.findBreakGlassPolicy({ orgId, userId: invokerId, serverId });
  if (!policy) {
    throw new ApiError(403, 'No break-glass policy authorizes emergency access to this server for you.', {
      code: 'BREAK_GLASS_NOT_AUTHORIZED',
    });
  }

  await assertNoActiveBreakGlass(orgId, serverId);

  const invoker = await prisma.user.findFirst({ where: { id: invokerId, orgId } });
  if (!invoker) throw new ApiError(404, 'Invoker not found');

  // Only TOTP/email are offered here — backup codes are a break-glass path
  // for MFA *itself*, not a fit for a second, separate emergency-access flow.
  const enrolled = mfaService.availableMethods(invoker).filter((m) => m !== 'backup');
  const available = enrolled.length > 0 ? enrolled : ['email'];

  let chosen = method;
  if (chosen) {
    if (!available.includes(chosen)) {
      throw new ApiError(400, "That verification method isn't available for your account.", {
        code: 'BREAK_GLASS_METHOD_UNAVAILABLE',
      });
    }
  } else {
    chosen = available[0];
  }

  const challengeId = crypto.randomBytes(32).toString('base64url');
  const ttlSeconds = Math.max(300, Math.min(Number(durationSeconds) || policy.maxSessionDuration, policy.maxSessionDuration));

  // Email delivery must fail CLOSED — if the code can't be sent, no challenge
  // is persisted and nothing is granted. sendEmailOtp throws (503,
  // EMAIL_NOT_DELIVERED) when there's no working mail transport; that
  // propagates to the caller as-is. Reusing the challengeId as the mfaService
  // rate-limit key also caps resend attempts per break-glass challenge, same
  // as a login MFA challenge.
  if (chosen === 'email') {
    await mfaService.sendEmailOtp(invoker, challengeId);
  }

  const payload = {
    userId: invokerId,
    orgId,
    serverId,
    serverHostname: server.hostname,
    environment: server.environment,
    reason: trimmedReason,
    ttlSeconds,
    method: chosen,
    policyId: policy.id,
    policyName: policy.name,
    maxSessionDuration: policy.maxSessionDuration,
    ip: ip || null,
    userAgent: userAgent || null,
    createdAt: Date.now(),
  };
  await redis.set(
    BREAK_GLASS_REDIS_PREFIX + challengeId,
    encrypt(JSON.stringify(payload)),
    'EX',
    BREAK_GLASS_CHALLENGE_TTL_SEC
  );

  await writeAudit(orgId, invokerId, 'access_request.break_glass.started', null, {
    serverId,
    serverHostname: server.hostname,
    environment: server.environment,
    reason: trimmedReason,
    policyId: policy.id,
    policyName: policy.name,
    method: chosen,
    durationSeconds: ttlSeconds,
    ip,
    userAgent,
    severity: 'HIGH',
  });

  return {
    challengeId,
    method: chosen,
    ...(chosen === 'email' ? { emailHint: maskEmail(invoker.email) } : {}),
    expiresIn: BREAK_GLASS_CHALLENGE_TTL_SEC,
  };
}

/**
 * Step 2 — verify the second factor and, on success, create the pre-approved
 * break-glass AccessRequest. Single-use: the challenge is burned on success
 * (so it can't be replayed) and after BREAK_GLASS_MAX_ATTEMPTS wrong codes.
 *
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.invokerId
 * @param {Set<string>} params.invokerPermissions - must include access.break_glass
 * @param {string} params.challengeId
 * @param {string} params.code
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 * @returns {Promise<object>} the created AccessRequest
 */
export async function verifyBreakGlass({ orgId, invokerId, invokerPermissions, challengeId, code, ip, userAgent }) {
  if (!has(invokerPermissions, 'access.break_glass')) {
    throw new ApiError(403, "You don't have permission to use break-glass access");
  }
  if (!challengeId || typeof challengeId !== 'string') {
    throw new ApiError(401, 'This break-glass verification has expired — start again.', {
      code: 'BREAK_GLASS_CHALLENGE_EXPIRED',
    });
  }

  const challengeKey = BREAK_GLASS_REDIS_PREFIX + challengeId;
  const attemptsKey = BREAK_GLASS_ATTEMPTS_PREFIX + challengeId;

  const expiredError = () =>
    new ApiError(401, 'This break-glass verification has expired — start again.', {
      code: 'BREAK_GLASS_CHALLENGE_EXPIRED',
    });
  const tooManyAttemptsError = () =>
    new ApiError(429, 'Too many attempts — start again.', { code: 'BREAK_GLASS_TOO_MANY_ATTEMPTS' });

  const existingAttempts = Number((await redis.get(attemptsKey)) || 0);
  if (existingAttempts >= BREAK_GLASS_MAX_ATTEMPTS) {
    await burnBreakGlassChallenge(challengeId);
    throw tooManyAttemptsError();
  }

  const raw = await redis.get(challengeKey);
  if (!raw) throw expiredError();

  let payload;
  try {
    payload = JSON.parse(decrypt(raw));
  } catch (err) {
    logger.error('accessRequestService.verifyBreakGlass: failed to decode challenge', { error: err.message });
    await burnBreakGlassChallenge(challengeId);
    throw expiredError();
  }

  // The challenge is bound to the user/org that started it — never usable
  // by, or on behalf of, anyone else, whatever the response would otherwise
  // reveal.
  if (payload.userId !== invokerId || payload.orgId !== orgId) {
    throw expiredError();
  }

  const invoker = await prisma.user.findFirst({ where: { id: invokerId, orgId, status: 'active' } });
  if (!invoker) {
    await burnBreakGlassChallenge(challengeId);
    throw expiredError();
  }

  const server = await prisma.server.findFirst({ where: { id: payload.serverId, orgId } });
  if (!server) {
    await burnBreakGlassChallenge(challengeId);
    throw new ApiError(404, 'Server not found');
  }

  const failVerify = async (failureReason, err) => {
    await writeAudit(orgId, invokerId, 'access_request.break_glass.verify_failed', null, {
      serverId: payload.serverId,
      serverHostname: server.hostname,
      environment: server.environment,
      method: payload.method,
      failureReason,
      ip,
      userAgent,
      severity: 'HIGH',
    });
    throw err;
  };

  // Re-check every invariant that could have changed since start(): the org
  // may have turned prod-bypass off, the policy may have been edited/
  // disabled, or another break-glass session may have been granted for this
  // server in the meantime. This is the authoritative check — start()'s
  // checks are only an early UX signal.
  try {
    await assertBreakGlassProdAllowed(orgId, server);
  } catch (err) {
    await burnBreakGlassChallenge(challengeId);
    return failVerify('org_prod_bypass_disabled', err);
  }

  const policy = await policyService.findBreakGlassPolicy({ orgId, userId: invokerId, serverId: payload.serverId });
  if (!policy) {
    await burnBreakGlassChallenge(challengeId);
    return failVerify(
      'policy_no_longer_matches',
      new ApiError(403, 'Break-glass authorization for this server is no longer valid — start again.', {
        code: 'BREAK_GLASS_NOT_AUTHORIZED',
      })
    );
  }

  try {
    await assertNoActiveBreakGlass(orgId, payload.serverId);
  } catch (err) {
    await burnBreakGlassChallenge(challengeId);
    return failVerify('already_active', err);
  }

  const ok = await mfaService.verifyFactor(invoker, payload.method, code);
  if (!ok) {
    const count = await redis.incr(attemptsKey);
    if (count === 1) await redis.expire(attemptsKey, BREAK_GLASS_CHALLENGE_TTL_SEC);
    const burned = count >= BREAK_GLASS_MAX_ATTEMPTS;
    const attemptsRemaining = Math.max(0, BREAK_GLASS_MAX_ATTEMPTS - count);

    await writeAudit(orgId, invokerId, 'access_request.break_glass.verify_failed', null, {
      serverId: payload.serverId,
      serverHostname: server.hostname,
      environment: server.environment,
      method: payload.method,
      failureReason: 'invalid_code',
      attemptsRemaining,
      burned,
      ip,
      userAgent,
      severity: 'HIGH',
    });

    if (burned) {
      await burnBreakGlassChallenge(challengeId);
      throw tooManyAttemptsError();
    }
    throw new ApiError(401, 'Invalid verification code', { code: 'BREAK_GLASS_INVALID_CODE', details: { attemptsRemaining } });
  }

  // Success — burn the challenge immediately so it can never be replayed.
  await burnBreakGlassChallenge(challengeId);

  const ttl = Math.max(300, Math.min(payload.ttlSeconds, policy.maxSessionDuration));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  const principal = server.sshUser || 'root';

  const ar = await prisma.accessRequest.create({
    data: {
      orgId,
      requesterId: invokerId,
      reviewerId: invokerId, // self-approved, gated on step-up verification above
      serverId: payload.serverId,
      protocol: 'SSH',
      requestedPrincipal: principal,
      reason: payload.reason,
      requestedDuration: ttl,
      approvedDuration: ttl,
      status: 'APPROVED',
      approvedAt: now,
      expiresAt,
      breakGlass: true,
    },
    include: REQUEST_INCLUDE,
  });

  await writeAudit(orgId, invokerId, 'access_request.break_glass.granted', ar.id, {
    serverId: payload.serverId,
    serverHostname: server.hostname,
    environment: server.environment,
    reason: payload.reason,
    durationSeconds: ttl,
    expiresAt: expiresAt.toISOString(),
    policyId: policy.id,
    policyName: policy.name,
    method: payload.method,
    ip,
    userAgent,
    severity: 'HIGH',
  });

  try {
    const admins = await usersWithPermission(orgId, 'access_requests.revoke_any');
    const methodLabel = payload.method === 'totp' ? 'an authenticator app code' : 'an emailed one-time code';
    const reviewUrl = `${config.frontendUrl}/access-requests?request=${ar.id}`;
    await notifyEvent({
      orgId,
      event: 'break_glass.invoked',
      recipients: admins.map((a) => a.id),
      title: `[Break-glass] access invoked on ${server.displayName || server.hostname}`,
      body: `${invoker.name} invoked break-glass access to ${server.displayName || server.hostname} (${server.environment}), verified with ${methodLabel}. Reason: ${payload.reason.slice(0, 160)}`,
      metadata: {
        accessRequestId: ar.id,
        invokerId,
        serverId: payload.serverId,
        expiresAt: expiresAt.toISOString(),
        method: payload.method,
      },
      chat: {
        fields: [
          { label: 'Who', value: invoker.name },
          { label: 'Server', value: server.displayName || server.hostname },
          { label: 'Environment', value: server.environment },
          { label: 'Verified with', value: methodLabel },
          { label: 'Expires', value: expiresAt.toISOString() },
          { label: 'Reason', value: payload.reason },
        ],
        url: reviewUrl,
        context: { environment: server.environment, customerId: server.customerId },
      },
    });

    for (const admin of admins) {

      // Break-glass is the highest-severity event in the product, and until
      // now it reached administrators only as an in-app row they had to
      // notice. The template for this existed and was never registered.
      // Emailed per-admin and best-effort: a mail failure must never affect
      // the access that has already been granted.
      if (!admin.email) continue;
      try {
        const tpl = renderTemplate('breakGlassInvoked', {
          recipientName: admin.name,
          invokerName: invoker.name,
          serverHostname: server.displayName || server.hostname,
          environment: server.environment,
          reason: payload.reason,
          expiresAt: expiresAt.toISOString(),
          reviewUrl,
        });
        await mailer.sendMail({ orgId, to: admin.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
      } catch (err) {
        logger.warn('accessRequestService.verifyBreakGlass: break-glass email failed', {
          accessRequestId: ar.id,
          adminId: admin.id,
          error: err.message,
        });
      }
    }
    logger.info('accessRequestService.verifyBreakGlass: fanned out notifications', {
      accessRequestId: ar.id,
      adminCount: admins.length,
    });
  } catch (err) {
    // Non-fatal — access still works, but flag it.
    logger.error('accessRequestService.verifyBreakGlass: notification fanout failed', {
      accessRequestId: ar.id,
      error: err.message,
    });
  }

  return ar;
}

// ---------------------------------------------------------------------------
// createBreakGlass — RETIRED. Kept only so a stray caller gets a loud,
// actionable error instead of silently bypassing step-up verification.
// Use startBreakGlass()/verifyBreakGlass() (POST .../break-glass/start then
// .../break-glass/verify) instead.
// ---------------------------------------------------------------------------

export async function createBreakGlass() {
  throw new ApiError(
    410,
    'This endpoint has been retired. Use POST /api/access-requests/break-glass/start followed by ' +
      'POST /api/access-requests/break-glass/verify — break-glass now requires step-up verification.',
    { code: 'BREAK_GLASS_ENDPOINT_RETIRED' }
  );
}
