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
import * as notificationService from './notificationService.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Role rank helper for revoke authorization
// ---------------------------------------------------------------------------
const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };

function isAdminOrAbove(role) {
  return (ROLE_RANK[role] ?? 0) >= ROLE_RANK.admin;
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
}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!requesterId) throw new ApiError(400, 'requesterId is required');
  if (!serverId) throw new ApiError(400, 'serverId is required');
  if (!reason) throw new ApiError(400, 'reason is required');
  if (!requestedDuration || requestedDuration <= 0) {
    throw new ApiError(400, 'requestedDuration must be a positive integer (seconds)');
  }
  if (!requestedPrincipal) throw new ApiError(400, 'requestedPrincipal is required');

  // Load server scoped to org
  const server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!server) throw new ApiError(404, 'Server not found');

  // Load requester with manager relation
  const requester = await prisma.user.findFirst({
    where: { id: requesterId, orgId },
    include: { manager: { select: { id: true, name: true, email: true } } },
  });
  if (!requester) throw new ApiError(404, 'Requester not found');

  // Evaluate policy (handles prod hard-block internally)
  const policyResult = await policyService.evaluate({
    orgId,
    userId: requesterId,
    serverId,
    requestedPrincipal,
  });

  const now = new Date();
  let requestData;

  const needsApproval = server.environment === 'prod' || policyResult.requiresApproval;

  if (needsApproval) {
    // Prod or policy-requires-approval path → PENDING
    if (!requester.manager) {
      throw new Error('A manager must be assigned to request access to this server');
    }

    requestData = {
      orgId,
      requesterId,
      serverId,
      reason,
      requestedDuration,
      requestedPrincipal,
      protocol,
      status: 'PENDING',
      reviewerId: requester.manager.id,
    };

    const accessRequest = await prisma.accessRequest.create({
      data: requestData,
      include: REQUEST_INCLUDE,
    });

    // Notify the reviewer (manager)
    await notificationService.create({
      orgId,
      userId: requester.manager.id,
      type: 'ACCESS_REQUEST_SUBMITTED',
      title: 'New access request requires your review',
      body: `${requester.name} is requesting ${protocol} access to ${server.hostname} (${server.environment}). Reason: ${reason}`,
      metadata: { accessRequestId: accessRequest.id, requesterId, serverId },
    });

    await writeAudit(orgId, requesterId, 'access_request.submitted', accessRequest.id, {
      serverId,
      environment: server.environment,
      protocol,
      status: 'PENDING',
    });

    logger.info('accessRequestService.submit: request created PENDING', {
      orgId,
      requestId: accessRequest.id,
      requesterId,
      serverId,
      environment: server.environment,
    });

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
    },
  });

  if (!accessRequest) throw new ApiError(404, 'Access request not found');
  if (accessRequest.reviewerId !== reviewerId) {
    throw new ApiError(403, 'You are not the assigned reviewer for this request');
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
export async function generateSshCredentials({ requestId, callerId }) {
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
  const principal = accessRequest.requestedPrincipal;
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
      principals: [principal],
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
        principals: [principal],
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
      { certId: certRow.id, principal, remainingSeconds }
    );

    logger.info('accessRequestService.generateSshCredentials: credentials issued', {
      requestId,
      callerId,
      certId: certRow.id,
      principal,
      remainingSeconds,
    });

    const port = server.port ?? 22;
    const connectCommand =
      `ssh -i id_ed25519 -o CertificateFile=id_ed25519-cert.pub ${principal}@${server.hostname} -p ${port}`;

    const result = {
      privateKey: privateKeyBuf.toString('utf8'),
      certificate: signedCert,
      hostname: server.hostname,
      port,
      username: principal,
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
 * Generate a stub .rdp download file for an approved RDP access request.
 *
 * TODO(phase-11): Replace placeholder gateway token with real Guacamole
 * connection creation and auth token generation.
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

  const server = accessRequest.server;
  const rdpPort = server.port ?? 3389;
  // TODO(phase-11): Replace PLACEHOLDER_PHASE_11 with real Guacamole gateway token
  const gatewayToken = 'PLACEHOLDER_PHASE_11';

  const rdpContent = [
    'full address:s:' + server.hostname,
    'server port:i:' + rdpPort,
    'username:s:' + accessRequest.requestedPrincipal,
    'authentication level:i:2',
    'prompt for credentials:i:0',
    'negotiate security layer:i:1',
    'remoteapplicationmode:i:0',
    'alternate shell:s:',
    'shell working directory:s:',
    'gatewayhostname:s:' + server.hostname,
    'gatewayusagemethod:i:1',
    'gatewayprofileusagemethod:i:1',
    'gatewaycredentialssource:i:0',
    'gatewayaccesstoken:s:' + gatewayToken,
    'gatewaybrokeringtype:i:0',
    'use multimon:i:0',
    'session bpp:i:32',
    'winposstr:s:0,1,0,0,800,600',
    'compression:i:1',
    'keyboardhook:i:2',
    'audiocapturemode:i:0',
    'videoplaybackmode:i:1',
    'connection type:i:7',
    'networkautodetect:i:1',
    'bandwidthautodetect:i:1',
    'displayconnectionbar:i:1',
    'enableworkspacereconnect:i:0',
    'disable wallpaper:i:0',
    'allow font smoothing:i:0',
    'allow desktop composition:i:0',
    'disable full window drag:i:1',
    'disable menu anims:i:1',
    'disable themes:i:0',
    'disable cursor setting:i:0',
    'bitmapcachepersistenable:i:1',
    'shellius-request-id:s:' + requestId,
    'shellius-expires-at:s:' + accessRequest.expiresAt.toISOString(),
  ].join('\r\n');

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
    where = { orgId, reviewerId: userId, status: 'PENDING' };
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

export default {
  submit,
  review,
  generateSshCredentials,
  generateRdpFile,
  revoke,
  list,
  getById,
  markExpired,
  markPendingExpired,
};
