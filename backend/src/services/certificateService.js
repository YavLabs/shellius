import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import * as caService from './caService.js';
import * as policyService from './policyService.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function writeAudit(orgId, action, resourceId, metadata = {}) {
  try {
    await prisma.auditLog.create({
      data: {
        orgId,
        actorId: null,
        action,
        resourceType: 'Certificate',
        resourceId: resourceId ?? null,
        metadata,
      },
    });
  } catch (err) {
    logger.error('certificateService: audit log write failed', { action, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue a signed SSH certificate.
 *
 * @param {object} params
 * @param {string}   params.orgId
 * @param {string}   params.userId          - Requesting user's DB id
 * @param {string}   params.serverId        - Target server DB id (optional for HOST certs)
 * @param {string[]} params.principals      - SSH principals to embed
 * @param {number}   params.validitySeconds - TTL (max 7 days = 604800)
 * @param {string}   params.publicKey       - User's public key to sign
 * @param {string}   [params.keyId]         - Cert key-id label; defaults to user email or userId
 * @param {'USER'|'HOST'} [params.certType='USER']
 * @param {object}   [params.extensions]
 * @param {object}   [params.criticalOptions]
 * @param {string}   [params.issuedVia='web']
 * @returns {Promise<{ certificate: object, signedCert: string }>}
 */
export async function issue({
  orgId,
  userId,
  serverId,
  principals,
  validitySeconds,
  publicKey,
  keyId,
  certType = 'USER',
  extensions = {},
  criticalOptions = {},
  issuedVia = 'web',
}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!userId) throw new ApiError(400, 'userId is required');
  if (!publicKey) throw new ApiError(400, 'publicKey is required');
  if (!Array.isArray(principals) || principals.length === 0) {
    throw new ApiError(400, 'principals must be a non-empty array');
  }
  if (!validitySeconds || validitySeconds <= 0) {
    throw new ApiError(400, 'validitySeconds must be positive');
  }
  if (validitySeconds > 604800) {
    throw new ApiError(400, 'validitySeconds may not exceed 604800 (7 days)');
  }

  // Load and verify user (scoped to org)
  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user) throw new ApiError(404, 'User not found in organization');

  // Load and verify server (scoped to org) — required for USER certs
  let server = null;
  if (serverId) {
    server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
    if (!server) throw new ApiError(404, 'Server not found in organization');
  }

  // Policy evaluation (phase 6): deny-before-allow engine with prod hard-block
  if (server) {
    const policyResult = await policyService.evaluate({
      orgId,
      userId,
      serverId,
      requestedPrincipal: principals[0],
    });

    if (policyResult.requiresApproval) {
      // Belt-and-braces: prod guard is now inside evaluate(), but we keep this
      // explicit secondary check to ensure prod never slips through even if the
      // policy engine has a regression.
      if (server.environment === 'prod' && !policyResult.allowed) {
        throw new ApiError(
          403,
          'Production access requires an approved access request (phase 7 approval flow)'
        );
      }
      throw new ApiError(
        403,
        'Access requires approval (phase 7 approval flow)'
      );
    }

    if (!policyResult.allowed) {
      throw new ApiError(403, `Access denied by policy: ${policyResult.reason}`);
    }

    // Clamp validitySeconds to the policy's maxTtl
    if (policyResult.maxTtl > 0 && validitySeconds > policyResult.maxTtl) {
      logger.info('certificateService.issue: clamping validitySeconds to policy maxTtl', {
        orgId,
        userId,
        serverId,
        requestedTtl: validitySeconds,
        clampedTtl: policyResult.maxTtl,
        policyId: policyResult.policyId,
      });
      validitySeconds = policyResult.maxTtl;
    }
  }

  const effectiveKeyId = keyId || user.email || userId;

  const { signedCert, serial, caKeyPairId } = await caService.signCertificate({
    orgId,
    publicKey,
    principals,
    validitySeconds,
    certType,
    keyId: effectiveKeyId,
    extensions,
    criticalOptions,
  });

  const now = new Date();
  const validBefore = new Date(now.getTime() + validitySeconds * 1000);

  const certificate = await prisma.certificate.create({
    data: {
      orgId,
      caKeyPairId,
      serial,
      type: certType,
      keyId: effectiveKeyId,
      principals,
      publicKey,
      // signedCert is stored in DB (schema has the column); the cert is returned
      // to the caller as well. This is intentional — the DB record stores the
      // full cert for audit/verify purposes.
      signedCert,
      validAfter: now,
      validBefore,
      extensions: Object.keys(extensions).length ? extensions : null,
      criticalOptions: Object.keys(criticalOptions).length ? criticalOptions : null,
      status: 'ACTIVE',
      issuedToId: userId,
      issuedForId: serverId ?? null,
      issuedVia,
    },
    include: {
      issuedTo: { select: { id: true, email: true, name: true } },
      issuedFor: { select: { id: true, hostname: true, environment: true } },
    },
  });

  logger.info('certificateService: certificate issued', {
    orgId,
    certId: certificate.id,
    serial: serial.toString(),
    userId,
    serverId: serverId ?? null,
    principals,
    validitySeconds,
  });

  await writeAudit(orgId, 'certificate.issued', certificate.id, {
    serial: serial.toString(),
    userId,
    serverId: serverId ?? null,
    principals,
    certType,
  });

  return { certificate, signedCert };
}

/**
 * List certificates with optional filters (paginated).
 *
 * @param {object} params
 * @param {string}  params.orgId
 * @param {string}  [params.userId]    - Filter by issuedToId
 * @param {string}  [params.serverId]  - Filter by issuedForId
 * @param {string}  [params.status]    - ACTIVE | REVOKED | EXPIRED
 * @param {number}  [params.page=1]
 * @param {number}  [params.limit=25]
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
export async function list({ orgId, userId, serverId, status, page = 1, limit = 25 }) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  page = parseInt(page, 10) || 1;
  limit = Math.min(parseInt(limit, 10) || 25, 100);

  const where = { orgId };
  if (userId) where.issuedToId = userId;
  if (serverId) where.issuedForId = serverId;
  if (status) where.status = status;

  const [items, total] = await Promise.all([
    prisma.certificate.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        issuedTo: { select: { id: true, email: true, name: true } },
        issuedFor: { select: { id: true, hostname: true, environment: true } },
      },
    }),
    prisma.certificate.count({ where }),
  ]);

  return { items, total, page, limit };
}

/**
 * Get a single certificate by id, scoped to org.
 *
 * @param {string} orgId
 * @param {string} certId
 * @returns {Promise<object>}
 */
export async function getById(orgId, certId) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!certId) throw new ApiError(400, 'certId is required');

  const cert = await prisma.certificate.findFirst({
    where: { id: certId, orgId },
    include: {
      issuedTo: { select: { id: true, email: true, name: true } },
      issuedFor: { select: { id: true, hostname: true, environment: true } },
      revokedBy: { select: { id: true, email: true, name: true } },
    },
  });

  if (!cert) throw new ApiError(404, 'Certificate not found');
  return cert;
}

/**
 * Revoke a certificate.
 *
 * @param {string} orgId
 * @param {string} certId
 * @param {string} revokedById - User performing the revocation
 * @returns {Promise<object>}
 */
export async function revoke(orgId, certId, revokedById) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!certId) throw new ApiError(400, 'certId is required');

  // Verify cert belongs to this org
  const cert = await prisma.certificate.findFirst({ where: { id: certId, orgId } });
  if (!cert) throw new ApiError(404, 'Certificate not found');

  // caService.revokeCertificate does the actual DB update + audit
  const updated = await caService.revokeCertificate(certId, revokedById);
  return updated;
}

/**
 * Verify a certificate — used by the check-principals agent on target hosts.
 * Never throws; returns { valid: false, reason } on any invalid condition.
 *
 * @param {object} params
 * @param {string|bigint} params.serial    - Certificate serial number
 * @param {string}        params.principal - Principal name to check membership for
 * @returns {Promise<{ valid: boolean, reason?: string, principals?: string[], validBefore?: Date }>}
 */
export async function verify({ serial, principal }) {
  try {
    if (!serial) return { valid: false, reason: 'serial is required' };
    if (!principal) return { valid: false, reason: 'principal is required' };

    // Serial is stored as BigInt in DB; accept string or bigint from caller
    let serialBig;
    try {
      serialBig = BigInt(serial);
    } catch {
      return { valid: false, reason: 'invalid serial format' };
    }

    const cert = await prisma.certificate.findUnique({
      where: { serial: serialBig },
    });

    if (!cert) return { valid: false, reason: 'certificate not found' };
    if (cert.status === 'REVOKED') return { valid: false, reason: 'certificate revoked' };
    if (cert.status === 'EXPIRED') return { valid: false, reason: 'certificate expired' };

    const now = new Date();
    if (cert.validBefore <= now) {
      return { valid: false, reason: 'certificate has expired' };
    }
    if (cert.validAfter > now) {
      return { valid: false, reason: 'certificate not yet valid' };
    }

    if (!Array.isArray(cert.principals) || !cert.principals.includes(principal)) {
      return { valid: false, reason: 'principal not in certificate' };
    }

    const result = {
      valid: true,
      principals: cert.principals,
      validBefore: cert.validBefore,
    };

    // Phase 21A — attach optional JIT provisioning manifest. Only
    // populated when a matching policy has non-empty osProvisioning.
    // Existing hosts ignore unknown fields; future check-principals
    // will consume the manifest. Errors are swallowed so verify stays
    // fast and never fails on manifest issues.
    try {
      // Find the approved access request this cert was issued for.
      const ar = await prisma.accessRequest.findFirst({
        where: {
          certificateId: cert.id,
          status: 'APPROVED',
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (ar) {
        const jitManifestService = await import('./jitManifestService.js');
        const manifest = await jitManifestService.buildManifest({ accessRequestId: ar.id });
        if (manifest) {
          result.manifest = manifest;
        }
      }
    } catch (err) {
      logger.warn('certificateService.verify: manifest lookup failed (non-fatal)', {
        error: err.message,
      });
    }

    return result;
  } catch (err) {
    logger.error('certificateService.verify: unexpected error', { error: err.message });
    return { valid: false, reason: 'internal error during verification' };
  }
}

/**
 * Mark all ACTIVE certificates whose validBefore < now as EXPIRED.
 * Called by the certExpiry background job.
 *
 * @param {string} [orgId] - If omitted, process all orgs
 * @returns {Promise<number>} Count of records updated
 */
export async function markExpired(orgId) {
  const where = {
    status: 'ACTIVE',
    validBefore: { lt: new Date() },
  };
  if (orgId) where.orgId = orgId;

  const result = await prisma.certificate.updateMany({
    where,
    data: { status: 'EXPIRED' },
  });

  if (result.count > 0) {
    logger.info('certificateService.markExpired: transitioned certificates to EXPIRED', {
      count: result.count,
      orgId: orgId ?? 'all',
    });
  }

  return result.count;
}

export default { issue, list, getById, revoke, verify, markExpired };
