import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import * as caService from './caService.js';
import * as policyService from './policyService.js';
import * as jitManifestService from './jitManifestService.js';
import * as notificationService from './notificationService.js';
import * as rdpService from './rdpService.js';
import * as mailer from './mailer.js';
import * as inviteService from './inviteService.js';
import { renderTemplate } from '../email/index.js';

const execFileAsync = promisify(execFile);

// A server is "onboarded" (and therefore requestable/connectable) once the
// agent + CA trust is in place: either auto-provisioning succeeded, or the host
// has checked in via heartbeat / health check. Servers merely added to the
// inventory (onboard=false in bulk import, or failed onboarding) are not.
export function isServerOnboarded(server) {
  if (!server) return false;
  if (server.provisionStatus === 'provisioned') return true;
  if (server.lastHealthCheck) return true;
  return !!server.healthStatus && server.healthStatus !== 'unknown';
}

// ---------------------------------------------------------------------------
// Role rank helper for revoke authorization
// ---------------------------------------------------------------------------
const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, member: 1 };

function isAdminOrAbove(role) {
  return (ROLE_RANK[role] ?? 0) >= ROLE_RANK.admin;
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
    if (policy.approverRoles?.length) orFilters.push({ role: { in: policy.approverRoles } });
    if (policy.approverGroupId) {
      orFilters.push({ groupMemberships: { some: { groupId: policy.approverGroupId } } });
    }
    if (orFilters.length) {
      const users = await prisma.user.findMany({
        where: { orgId, status: 'active', deletedAt: null, OR: orFilters },
        select: { id: true, name: true, email: true },
      });
      users.forEach(add);
    }
  }

  // Fallback: the requester's direct manager.
  if (byId.size === 0 && manager) add(manager);

  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Internal include shapes (reused across queries)
// ---------------------------------------------------------------------------
const REQUEST_INCLUDE = {
  requester: { select: { id: true, name: true, email: true } },
  reviewer: { select: { id: true, name: true, email: true } },
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
}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!requesterId) throw new ApiError(400, 'requesterId is required');
  if (!serverId) throw new ApiError(400, 'serverId is required');
  if (!reason) throw new ApiError(400, 'reason is required');
  if (!requestedDuration || requestedDuration <= 0) {
    throw new ApiError(400, 'requestedDuration must be a positive integer (seconds)');
  }

  // Load server scoped to org
  const server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!server) throw new ApiError(404, 'Server not found');
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
  const jitPolicy = await jitManifestService.findJitPolicyForUserServer({
    orgId,
    userId: requesterId,
    serverId,
  });
  const jitPrincipal = jitPolicy ? jitManifestService.jitPrincipalFor(requester) : null;
  const legacyPrincipal = server.sshUser || 'root';
  const defaultPrincipal = jitPrincipal || legacyPrincipal;

  const isAdminCaller = callerRole === 'admin' || callerRole === 'super_admin';
  if (!requestedPrincipal) {
    requestedPrincipal = defaultPrincipal;
  } else if (!isAdminCaller) {
    const allowed = new Set([legacyPrincipal]);
    if (jitPrincipal) allowed.add(jitPrincipal);
    if (!allowed.has(requestedPrincipal)) {
      throw new ApiError(
        403,
        `Principal "${requestedPrincipal}" is not allowed for this user. Allowed: ${[...allowed].join(', ')}. Admins can override.`
      );
    }
  }

  // Evaluate policy (handles prod hard-block internally)
  const policyResult = await policyService.evaluate({
    orgId,
    userId: requesterId,
    serverId,
    requestedPrincipal,
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

    // Notify every eligible approver (in-app) and email a one-click link.
    for (const approver of approvers) {
      await notificationService.create({
        orgId,
        userId: approver.id,
        type: 'ACCESS_REQUEST_SUBMITTED',
        title: 'New access request requires your review',
        body: `${requester.name} is requesting ${protocol} access to ${server.hostname} (${server.environment}). Reason: ${reason}`,
        metadata: { accessRequestId: accessRequest.id, requesterId, serverId },
      });
    }
    await sendApprovalEmails({ orgId, accessRequest, requester, server, reason, approvers });

    await writeAudit(orgId, requesterId, 'access_request.submitted', accessRequest.id, {
      serverId,
      environment: server.environment,
      protocol,
      status: 'PENDING',
      approverCount: approvers.length,
      approverPolicyId: approverPolicy?.id || null,
    });

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
    body: `Access to ${server.hostname} (${server.environment}) has been granted for ${Math.round(effectiveDuration / 60)} minutes.`,
    metadata: { accessRequestId: accessRequest.id, serverId, expiresAt },
  });

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
export async function review({ requestId, reviewerId, decision, approvedDuration, deniedReason }) {
  if (!requestId) throw new ApiError(400, 'requestId is required');
  if (!reviewerId) throw new ApiError(400, 'reviewerId is required');
  if (!decision || !['approve', 'deny'].includes(decision)) {
    throw new ApiError(400, "decision must be 'approve' or 'deny'");
  }

  const accessRequest = await prisma.accessRequest.findUnique({
    where: { id: requestId },
    include: {
      ...REQUEST_INCLUDE,
      requester: { select: { id: true, name: true, email: true } },
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

  const now = new Date();
  let updated;

  if (decision === 'approve') {
    const duration =
      approvedDuration && approvedDuration > 0
        ? approvedDuration
        : accessRequest.requestedDuration;
    const expiresAt = new Date(now.getTime() + duration * 1000);

    updated = await prisma.accessRequest.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED',
        // Record the actual decider (may differ from the primary reviewer).
        reviewerId,
        approvedDuration: duration,
        approvedAt: now,
        expiresAt,
      },
      include: REQUEST_INCLUDE,
    });

    await notificationService.create({
      orgId: accessRequest.orgId,
      userId: accessRequest.requesterId,
      type: 'ACCESS_REQUEST_APPROVED',
      title: 'Your access request was approved',
      body: `Your request for ${accessRequest.server.hostname} has been approved for ${Math.round(duration / 60)} minutes.`,
      metadata: { accessRequestId: requestId, reviewerId, expiresAt },
    });

    await writeAudit(
      accessRequest.orgId,
      reviewerId,
      'access_request.approved',
      requestId,
      { duration, expiresAt }
    );

    logger.info('accessRequestService.review: request approved', {
      requestId,
      reviewerId,
      duration,
      expiresAt,
    });
  } else {
    updated = await prisma.accessRequest.update({
      where: { id: requestId },
      data: {
        status: 'DENIED',
        reviewerId,
        deniedAt: now,
        deniedReason: deniedReason ?? null,
      },
      include: REQUEST_INCLUDE,
    });

    await notificationService.create({
      orgId: accessRequest.orgId,
      userId: accessRequest.requesterId,
      type: 'ACCESS_REQUEST_DENIED',
      title: 'Your access request was denied',
      body: deniedReason
        ? `Your request for ${accessRequest.server.hostname} was denied. Reason: ${deniedReason}`
        : `Your request for ${accessRequest.server.hostname} was denied.`,
      metadata: { accessRequestId: requestId, reviewerId, deniedReason },
    });

    await writeAudit(
      accessRequest.orgId,
      reviewerId,
      'access_request.denied',
      requestId,
      { deniedReason }
    );

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
  const isAdminCaller = callerRole === 'admin' || callerRole === 'super_admin';

  // Phase 21A Part 2 — optional per-connect principal override.
  //   - Non-admins may only pass an override that matches the AR's stored
  //     principal or the legacy sshUser. Anything else → 403.
  //   - Admins may pass any valid Linux username (still regex-validated).
  // If no override is passed, use the AR's stored principal as primary.
  let primaryPrincipal = accessRequest.requestedPrincipal;
  if (principalOverride) {
    const LINUX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
    if (!LINUX_USER_RE.test(principalOverride)) {
      throw new ApiError(400, 'principalOverride is not a valid Linux username');
    }
    if (!isAdminCaller) {
      const allowedSet = new Set([accessRequest.requestedPrincipal, legacySshUser]);
      if (!allowedSet.has(principalOverride)) {
        throw new ApiError(
          403,
          `Principal "${principalOverride}" is not allowed for this connection. Admins can override.`
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
    const connectCommand =
      `ssh -i id_ed25519 -o CertificateFile=id_ed25519-cert.pub ${primaryPrincipal}@${server.hostname} -p ${port}`;

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
export async function generateRdpFile({ requestId, callerId }) {
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
  const { server, gatewayToken } = await rdpService.createConnectionForRequest(requestId);

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
    // Connection — direct to server (see TODO above re: RD Gateway)
    `full address:s:${server.hostname}:${rdpPort}`,
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
 * Caller must be admin+ OR the assigned reviewer.
 *
 * @param {object} params
 * @param {string} params.requestId
 * @param {string} params.callerId
 * @param {string} params.callerRole
 * @param {string} [params.reason]
 * @returns {Promise<object>}
 */
export async function revoke({ requestId, callerId, callerRole, reason }) {
  if (!requestId) throw new ApiError(400, 'requestId is required');
  if (!callerId) throw new ApiError(400, 'callerId is required');

  const accessRequest = await prisma.accessRequest.findUnique({
    where: { id: requestId },
    include: { server: { select: { hostname: true } } },
  });

  if (!accessRequest) throw new ApiError(404, 'Access request not found');

  const canRevoke = isAdminOrAbove(callerRole) || accessRequest.reviewerId === callerId;
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
      ? `Your access to ${accessRequest.server.hostname} was revoked. Reason: ${reason}`
      : `Your access to ${accessRequest.server.hostname} was revoked.`,
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
// Public API — list
// ---------------------------------------------------------------------------

/**
 * List access requests.
 *
 * tab='mine'      → requests where requesterId === userId (all roles)
 * tab='to-review' → requests where reviewerId === userId AND status=PENDING
 * tab='all'       → all requests in org (admin+ only)
 *
 * @param {object} params
 * @param {string}  params.orgId
 * @param {string}  params.userId
 * @param {string}  params.role
 * @param {string}  [params.tab='mine']
 * @param {number}  [params.page=1]
 * @param {number}  [params.limit=25]
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
export async function list({ orgId, userId, role, tab = 'mine', page = 1, limit = 25 }) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!userId) throw new ApiError(400, 'userId is required');

  page = parseInt(page, 10) || 1;
  limit = Math.min(parseInt(limit, 10) || 25, 100);

  let where;
  if (tab === 'all') {
    if (!isAdminOrAbove(role)) {
      throw new ApiError(403, 'Only admins can view all access requests');
    }
    where = { orgId };
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

  const [items, total] = await Promise.all([
    prisma.accessRequest.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
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
 * Visible to the requester, reviewer, or admin+.
 *
 * @param {object} params
 * @param {string} params.requestId
 * @param {string} params.callerId
 * @param {string} params.callerRole
 * @returns {Promise<object>}
 */
export async function getById({ requestId, callerId, callerRole }) {
  if (!requestId) throw new ApiError(400, 'requestId is required');
  if (!callerId) throw new ApiError(400, 'callerId is required');

  const accessRequest = await prisma.accessRequest.findUnique({
    where: { id: requestId },
    include: REQUEST_INCLUDE,
  });

  if (!accessRequest) throw new ApiError(404, 'Access request not found');

  const canView =
    isAdminOrAbove(callerRole) ||
    accessRequest.requesterId === callerId ||
    accessRequest.reviewerId === callerId;

  if (!canView) {
    throw new ApiError(403, 'You do not have permission to view this access request');
  }

  return accessRequest;
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
      server: { select: { hostname: true } },
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
        body: `Your access to ${req.server.hostname} has expired.`,
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
      server: { select: { hostname: true } },
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
        body: `Your pending request for access to ${req.server.hostname} was not reviewed within 24 hours and has expired.`,
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
      server: { select: { hostname: true } },
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
        body: `Your access to ${req.server.hostname} expires at ${req.expiresAt.toISOString()}. Download credentials now if you still need them.`,
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
  getAccessIntent,
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
 * @param {string} params.userRole
 * @param {string} params.serverId
 * @returns {Promise<object>}
 */
export async function getAccessIntent({ orgId, userId, userRole, serverId }) {
  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId },
    select: {
      id: true,
      sshUser: true,
      environment: true,
      protocol: true,
    },
  });
  if (!server) throw new ApiError(404, 'Server not found');

  const user = await prisma.user.findUnique({
    where: { id: userId },
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

  return {
    hasActiveAccess: !!activeAr,
    activeRequestId: activeAr?.id || null,
    hasPendingRequest: !!pendingAr && !activeAr,
    preferredPrincipal: preferred,
    allowedPrincipals: allowed,
    adminCanOverride: userRole === 'admin' || userRole === 'super_admin',
    protocol,
    requiresApproval: isProduction, // a partial signal; full eval still runs server-side on submit
    isProduction,
    jitEnabled: !!jitPolicy,
    breakGlass: !!activeAr?.breakGlass,
  };
}

// ---------------------------------------------------------------------------
// createBreakGlass — admin-only emergency access bypass
// ---------------------------------------------------------------------------

/**
 * Create a pre-approved AccessRequest flagged breakGlass. Used by admins
 * for emergency access to any server in the org. Every invocation writes
 * a high-severity audit event and notifies every admin/super_admin.
 *
 * @param {object} params
 * @param {string} params.orgId
 * @param {string} params.invokerId          - admin/super_admin initiating
 * @param {string} params.invokerRole        - must be admin or super_admin
 * @param {string} params.serverId
 * @param {string} params.reason             - mandatory, min 20 chars
 * @param {number} params.durationSeconds    - clamped to [300, 3600]
 * @returns {Promise<object>}                - the created AccessRequest
 */
export async function createBreakGlass({
  orgId,
  invokerId,
  invokerRole,
  serverId,
  reason,
  durationSeconds = 3600,
}) {
  if (!['admin', 'super_admin'].includes(invokerRole)) {
    throw new ApiError(403, 'Break-glass access requires admin or super_admin role');
  }
  if (!reason || reason.trim().length < 20) {
    throw new ApiError(400, 'reason must be at least 20 characters');
  }
  const ttl = Math.max(300, Math.min(Number(durationSeconds) || 3600, 3600));

  const server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!server) throw new ApiError(404, 'Server not found');

  const invoker = await prisma.user.findFirst({
    where: { id: invokerId, orgId },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!invoker) throw new ApiError(404, 'Invoker not found');

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  const principal = server.sshUser || 'root';

  const ar = await prisma.accessRequest.create({
    data: {
      orgId,
      requesterId: invokerId,
      reviewerId: invokerId, // self-approved
      serverId,
      protocol: 'SSH',
      requestedPrincipal: principal,
      reason: reason.trim(),
      requestedDuration: ttl,
      approvedDuration: ttl,
      status: 'APPROVED',
      approvedAt: now,
      expiresAt,
      breakGlass: true,
    },
    include: REQUEST_INCLUDE,
  });

  // Audit — distinct, high-severity event.
  await writeAudit(orgId, invokerId, 'access_request.break_glass', ar.id, {
    serverId,
    serverHostname: server.hostname,
    environment: server.environment,
    reason: reason.trim(),
    durationSeconds: ttl,
    expiresAt: expiresAt.toISOString(),
    severity: 'HIGH',
  });

  // Fan out a notification to every admin + super_admin in the org.
  try {
    const admins = await prisma.user.findMany({
      where: {
        orgId,
        role: { in: ['admin', 'super_admin'] },
        status: 'active',
        deletedAt: null,
      },
      select: { id: true, email: true, name: true },
    });
    for (const admin of admins) {
      await notificationService.create({
        orgId,
        userId: admin.id,
        type: 'BREAK_GLASS_INVOKED',
        title: `[Break-glass] access invoked on ${server.hostname}`,
        body: `${invoker.name} invoked break-glass access to ${server.hostname} (${server.environment}). Reason: ${reason.trim().slice(0, 160)}`,
        metadata: {
          accessRequestId: ar.id,
          invokerId,
          serverId,
          expiresAt: expiresAt.toISOString(),
        },
      });
    }
    logger.info('accessRequestService.createBreakGlass: fanned out notifications', {
      accessRequestId: ar.id,
      adminCount: admins.length,
    });
  } catch (err) {
    // Non-fatal — access still works, but flag it.
    logger.error('accessRequestService.createBreakGlass: notification fanout failed', {
      accessRequestId: ar.id,
      error: err.message,
    });
  }

  return ar;
}
