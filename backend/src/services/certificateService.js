import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import * as caService from './caService.js';
import * as policyService from './policyService.js';
import { UNSCOPED, assertServerInScope, relationScopeWhere } from '../lib/scope.js';
import { isDisabledStatus } from '../lib/userStatus.js';
import config from '../config/index.js';
import { endOfDayInclusive } from '../utils/dateRange.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function writeAudit(orgId, action, resourceId, metadata = {}, actorId = null) {
  try {
    await prisma.auditLog.create({
      data: {
        orgId,
        actorId,
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

const ALLOWED_EXTENSIONS = new Set([
  'permit-pty',
  'permit-port-forwarding',
  'permit-agent-forwarding',
  'permit-X11-forwarding',
  'permit-user-rc',
]);

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
 * @param {{mode: string, customerIds: string[]}} [params.scope=UNSCOPED]
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
  actorId = null,
  scope = UNSCOPED,
}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  // Direct issuance is a narrow, audited API (certificates.issue_direct). It
  // must never be a way around the access-request flow — docs/rbac F-03/F-04:
  //   - bound to a saved server, and every principal passes policy
  //   - USER certificates only, standard extensions only, no critical options
  //   - production always goes through an approved access request
  if (!serverId) throw new ApiError(400, 'serverId is required');
  if (certType !== 'USER') throw new ApiError(400, 'Only USER certificates can be issued directly');
  const badExt = Object.keys(extensions || {}).filter((k) => !ALLOWED_EXTENSIONS.has(k));
  if (badExt.length > 0) throw new ApiError(400, `Unsupported certificate extension(s): ${badExt.join(', ')}`);
  if (criticalOptions && Object.keys(criticalOptions).length > 0) {
    throw new ApiError(400, 'Critical options cannot be set on directly issued certificates');
  }
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

  const server = await prisma.server.findFirst({ where: { id: serverId, orgId } });
  if (!server) throw new ApiError(404, 'Server not found in organization');
  // Direct issuance mints access — an out-of-scope server must 404 exactly
  // like a nonexistent one, never leak a 403 that confirms it exists.
  assertServerInScope(scope, server);
  if (server.environment === 'prod') {
    throw new ApiError(403, 'Production certificates are only issued for an approved access request');
  }

  // Every principal must pass policy on its own — the old check only looked
  // at principals[0] and signed the rest unchecked (G2).
  for (const principal of principals) {
    const policyResult = await policyService.evaluate({
      orgId,
      userId,
      serverId,
      requestedPrincipal: principal,
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
      issuedTo: { select: { id: true, email: true, name: true, avatarUrl: true } },
      issuedFor: { select: { id: true, hostname: true, displayName: true, environment: true, customerId: true } },
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
    issuedVia,
  }, actorId);

  return { certificate, signedCert };
}

// list() sort whitelist — every value here MUST also be enumerated in the
// route's Joi schema (routes/certificates.js `listQuerySchema.sortBy`), so an
// unrecognised column is rejected with a 400 before it ever reaches here.
function buildOrderBy(sortBy, sortDir) {
  const dir = sortDir === 'asc' ? 'asc' : 'desc';
  switch (sortBy) {
    case 'serial':
      return { serial: dir };
    case 'issuedTo':
      return { issuedTo: { name: dir } };
    case 'server':
      return { issuedFor: { hostname: dir } };
    case 'status':
      return { status: dir };
    case 'validBefore':
      return { validBefore: dir };
    case 'createdAt':
    default:
      return { createdAt: dir };
  }
}

/**
 * Certificate ids whose serial, principals, keyId, issuedTo name/email, or
 * issuedFor hostname/displayName match `search`. Raw SQL because `serial` is
 * a Postgres bigint — Prisma has no `contains` for numeric columns, so
 * substring search needs an explicit `::text` cast. Deliberately NOT
 * scope-filtered here: the id list is only ever intersected (`id: { in }`)
 * with the caller's normal Prisma `where`, which already carries the scope
 * predicate — narrowing here just needs to stay inside the org.
 *
 * @returns {Promise<string[]>}
 */
async function searchCertificateIds(orgId, search) {
  const q = search.trim();
  if (!q) return null;
  const like = `%${q}%`;
  const rows = await prisma.$queryRaw`
    SELECT c.id
    FROM certificates c
    LEFT JOIN users u ON u.id = c.issued_to_id
    LEFT JOIN servers s ON s.id = c.issued_for_id
    WHERE c.org_id = ${orgId}
      AND (
        c.serial::text ILIKE ${like} OR
        c.key_id ILIKE ${like} OR
        array_to_string(c.principals, ',') ILIKE ${like} OR
        u.name ILIKE ${like} OR
        u.email ILIKE ${like} OR
        s.hostname ILIKE ${like} OR
        s.display_name ILIKE ${like}
      )
    LIMIT 5000
  `;
  return rows.map((r) => r.id);
}

/**
 * List certificates with optional filters (paginated).
 *
 * @param {object} params
 * @param {string}  params.orgId
 * @param {string}  [params.userId]    - Filter by issuedToId
 * @param {string}  [params.serverId]  - Filter by issuedForId
 * @param {string}  [params.status]    - ACTIVE | REVOKED | EXPIRED
 * @param {string}  [params.customerId] - via issuedFor, MERGED with (never replaces) scope
 * @param {string}  [params.search]     - serial, principals, keyId, user name/email, server name/hostname
 * @param {string}  [params.sortBy='createdAt'] one of createdAt|serial|issuedTo|server|status|validBefore
 * @param {string}  [params.sortDir='desc']
 * @param {number}  [params.page=1]
 * @param {number}  [params.limit=25]
 * @param {{mode: string, customerIds: string[]}} [params.scope=UNSCOPED]
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
 */
export async function list({
  orgId,
  userId,
  serverId,
  status,
  environment,
  certType,
  customerId,
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

  page = parseInt(page, 10) || 1;
  limit = Math.min(parseInt(limit, 10) || 25, 100);

  // Certificate has no customerId column, so scope is applied through the
  // issuedFor relation. A scoped user never sees certs issued without a
  // server (relationScopeWhere excludes null relations) — those are HOST
  // certs / ad-hoc issuance, not something a customer-scoped user requests.
  //
  // Each predicate below is its own `AND` element rather than being merged
  // into a shared `issuedFor` object — merging would let a later assignment
  // (e.g. `customerId`) silently clobber the scope predicate's `customerId`
  // key instead of narrowing alongside it.
  const where = { orgId };
  const andClauses = [];
  const scopePredicate = relationScopeWhere(scope, 'issuedFor');
  if (Object.keys(scopePredicate).length) andClauses.push(scopePredicate);
  if (userId) andClauses.push({ issuedToId: userId });
  if (serverId) andClauses.push({ issuedForId: serverId });
  if (status) andClauses.push({ status });
  // Prisma field is `type` (CertType enum) — `certType` is only the param
  // name the API/frontend use for it (see issue(): `type: certType`).
  if (certType) andClauses.push({ type: certType });
  if (environment) andClauses.push({ issuedFor: { environment } });
  if (customerId) andClauses.push({ issuedFor: { customerId } });
  if (search) {
    const ids = await searchCertificateIds(orgId, search);
    if (ids !== null) andClauses.push({ id: { in: ids } });
  }
  // "Valid until" range — the dimension the page actually displays.
  if (startDate || endDate) {
    const validBefore = {};
    if (startDate) validBefore.gte = new Date(startDate);
    if (endDate) validBefore.lte = endOfDayInclusive(endDate);
    andClauses.push({ validBefore });
  }
  if (andClauses.length) where.AND = andClauses;

  // "Expiring soon" — scoped to the org/caller like everything else here, but
  // NOT to the current filters/page: the page used to count only the certs
  // already on screen, so paging or filtering silently changed the number.
  // This always answers "how many of everything I can see expire within 24h".
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const expiringWhere = { orgId, status: 'ACTIVE', validBefore: { gt: now, lte: in24h } };
  if (Object.keys(scopePredicate).length) expiringWhere.AND = [scopePredicate];

  const [items, total, expiringSoonCount] = await Promise.all([
    prisma.certificate.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: buildOrderBy(sortBy, sortDir),
      include: {
        issuedTo: { select: { id: true, email: true, name: true, avatarUrl: true } },
        issuedFor: { select: { id: true, hostname: true, displayName: true, environment: true, customerId: true } },
      },
    }),
    prisma.certificate.count({ where }),
    prisma.certificate.count({ where: expiringWhere }),
  ]);

  return { items, total, page, limit, expiringSoonCount };
}

/**
 * Get a single certificate by id, scoped to org.
 *
 * @param {string} orgId
 * @param {string} certId
 * @param {{mode: string, customerIds: string[]}} [scope=UNSCOPED]
 * @returns {Promise<object>}
 */
export async function getById(orgId, certId, scope = UNSCOPED) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!certId) throw new ApiError(400, 'certId is required');

  const cert = await prisma.certificate.findFirst({
    where: { id: certId, orgId, ...relationScopeWhere(scope, 'issuedFor') },
    include: {
      issuedTo: { select: { id: true, email: true, name: true, avatarUrl: true } },
      issuedFor: { select: { id: true, hostname: true, displayName: true, environment: true, customerId: true } },
      revokedBy: { select: { id: true, email: true, name: true, avatarUrl: true } },
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
 * @param {string|bigint} params.serial      - Certificate serial number
 * @param {string}        params.principal   - Principal name to check membership for
 * @param {{id: string, orgId: string}|null} [params.agentServer] - The host asking,
 *   resolved from a per-host agent token by middleware/agentAuth.js. When
 *   present, the cert MUST belong to this org AND be bound to this exact
 *   host (Certificate.issuedForId === agentServer.id) — this is what stops a
 *   cert minted for server A from authenticating on server B/C. When null
 *   (legacy shared-secret caller, or unauthenticated internal caller), host
 *   binding cannot be enforced and is skipped — see middleware/agentAuth.js.
 * @returns {Promise<{ valid: boolean, reason?: string, principals?: string[], validBefore?: Date }>}
 */
export async function verify({ serial, principal, agentServer = null }) {
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
      include: { issuedTo: { select: { status: true } } },
    });

    if (!cert) return { valid: false, reason: 'certificate not found' };
    if (cert.status === 'REVOKED') return { valid: false, reason: 'certificate revoked' };
    if (cert.status === 'EXPIRED') return { valid: false, reason: 'certificate expired' };

    // The account behind the certificate must still be allowed in. Revoking
    // the certificate rows on suspension is the primary fix; this is the
    // backstop for a certificate issued in the window between the status
    // change and the revoke.
    //
    // A null issuedTo is not treated as a failure: direct issuance can
    // legitimately leave issuedToId unset, and a hard-deleted user's
    // certificates are SetNull'd — those are revoked by deleteUser instead,
    // since there is no owner left here to judge.
    //
    // Free: the include rides along on the lookup that already happens, so
    // this stays one query on a path that runs for every SSH connection.
    if (config.certificates.checkUserStatus && cert.issuedTo && isDisabledStatus(cert.issuedTo.status)) {
      logger.warn('certificateService.verify: certificate owner is disabled', {
        certId: cert.id,
        serial: serialBig.toString(),
        status: cert.issuedTo.status,
      });
      return { valid: false, reason: 'certificate owner is not active' };
    }

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

    // --- Per-host binding (B-1 fix) -----------------------------------
    // Only enforceable when the caller authenticated with a per-host agent
    // token (agentServer set by middleware/agentAuth.js). A cert must have
    // been issued for THIS org and THIS server — never any other host in
    // the org, even one with a matching local principal. Certs without a
    // server binding (issuedForId null — e.g. ad-hoc /certificates/issue
    // calls made without a serverId) are denied in this mode: there is no
    // safe way to know which host they're allowed on.
    if (agentServer) {
      if (cert.orgId !== agentServer.orgId || cert.issuedForId !== agentServer.id) {
        logger.warn('certificateService.verify: certificate/host binding mismatch', {
          certId: cert.id,
          serial: serialBig.toString(),
          certOrgId: cert.orgId,
          certIssuedForId: cert.issuedForId,
          agentOrgId: agentServer.orgId,
          agentServerId: agentServer.id,
        });
        return { valid: false, reason: 'certificate not issued for this host' };
      }
    }

    const result = {
      valid: true,
      principals: cert.principals,
      validBefore: cert.validBefore,
    };

    // Phase 21A — attach optional JIT provisioning manifest, and (per-host
    // mode only) re-check that the AccessRequest this cert was issued under
    // is still APPROVED and unexpired so a revocation/expiry takes effect
    // immediately, without waiting on the cert's own status to catch up.
    // Only populated when a matching policy has non-empty osProvisioning.
    // Existing hosts ignore unknown fields; future check-principals will
    // consume the manifest. Errors here are swallowed (fail open) so verify
    // stays fast and available — same trade-off this block already made
    // before per-host binding existed; the binding check above is what
    // actually closes the access-control gap and never fails open.
    try {
      const ar = await prisma.accessRequest.findFirst({
        where: { certificateId: cert.id },
        select: { id: true, status: true, expiresAt: true },
      });
      if (ar) {
        const arValid = ar.status === 'APPROVED' && (!ar.expiresAt || ar.expiresAt > new Date());
        if (agentServer && !arValid) {
          return { valid: false, reason: 'access request is no longer approved' };
        }
        if (arValid) {
          const jitManifestService = await import('./jitManifestService.js');
          const manifest = await jitManifestService.buildManifest({ accessRequestId: ar.id });
          if (manifest) {
            result.manifest = manifest;
          }
        }
      }
    } catch (err) {
      logger.warn('certificateService.verify: AR/manifest lookup failed (non-fatal)', {
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
