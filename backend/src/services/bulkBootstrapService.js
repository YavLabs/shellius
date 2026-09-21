import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { UNSCOPED, serverScopeWhere } from '../lib/scope.js';
import * as postureSettingsService from './postureSettingsService.js';
import { latestSnapshots, classifyCollector } from './postureCollectorState.js';
import { isOlderCollector } from '../utils/postureCollectorVersion.js';

/**
 * Bulk bootstrap / collector install.
 *
 * Installing one host at a time is fine for a host you just added. It is not
 * fine for an org that has been using Shellius for a year and has ninety
 * servers in inventory: the honest outcome there is that the collector never
 * gets installed anywhere, and the posture pages stay empty while reporting
 * nothing wrong. This plans the fleet-wide run.
 *
 * The plan is computed server-side and returned before anything is executed,
 * because the interesting part of a bulk install is not the hosts it will
 * touch — it is the hosts it will not, and why. A silent skip is how you end
 * up believing a fleet is covered when a third of it never was.
 */

/** Why a host is not a target. Each reason is a correct end state, not a gap. */
export const SKIP_REASONS = {
  windows: 'Windows hosts do not run the Shellius agent or collector.',
  rdp_only: 'RDP-only host — no SSH channel to run the installer over.',
  inactive: 'Server is inactive or terminated.',
  already_provisioned: 'Already bootstrapped with the full agent.',
  collector_installed: 'The collector is already installed here.',
  no_credentials:
    'No saved identity on this host and no fallback credentials supplied — nothing to connect with.',
};

/**
 * Is this host already bootstrapped with the full agent?
 *
 * A bootstrapped host trusts the org CA, which means we can mint a 300-second
 * certificate and connect with no stored secret at all. It is the single most
 * common reason a long-standing fleet has "no credentials": nobody ever
 * needed to save any, because certificate access was the whole point.
 */
export function isBootstrapped(server) {
  return server?.provisionStatus === 'provisioned' || !!server?.agentId;
}

/**
 * Can the installer run on this host at all? Mirrors
 * frontend/src/lib/bootstrapEligibility.js `canBootstrapHost`.
 */
export function canInstallOn(server) {
  if (!server) return false;
  if (server.osType === 'windows') return false;
  return server.protocol === 'ssh' || server.protocol === 'both';
}

function hardSkipReason(server) {
  if (server.osType === 'windows') return 'windows';
  if (server.protocol === 'rdp') return 'rdp_only';
  if (server.isActive === false) return 'inactive';
  return null;
}

const SERVER_SELECT = {
  id: true,
  hostname: true,
  displayName: true,
  ipAddress: true,
  osType: true,
  protocol: true,
  isActive: true,
  authMode: true,
  credentialId: true,
  sshUser: true,
  environment: true,
  agentId: true,
  provisionStatus: true,
  postureRejectedAt: true,
  postureRejectReason: true,
  postureInstalledAt: true,
  customer: { select: { id: true, name: true } },
  credential: { select: { id: true, name: true, username: true } },
  sudoCredential: { select: { id: true, name: true, username: true } },
};

/**
 * Classify a selection of servers for a bulk run.
 *
 * @param {string} orgId
 * @param {string[]} serverIds  empty/omitted = every server in scope
 * @param {object} opts
 * @param {'full'|'posture'} opts.mode
 * @param {boolean} opts.hasFallbackCredentials  whether the caller is supplying
 *   one identity to use for hosts that have none of their own. Without it, a
 *   host with no bound identity is skipped rather than attempted and failed.
 * @param {boolean} opts.includeDone  keep already-done hosts as targets (re-run)
 * @param {object} opts.scope
 * @returns {Promise<{targets: [], skipped: [], counts: {}}>}
 */
export async function planBulkInstall(
  orgId,
  serverIds,
  { mode = 'full', hasFallbackCredentials = false, includeDone = false, scope = UNSCOPED } = {}
) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  const where = { orgId, ...serverScopeWhere(scope) };
  // An explicit selection is filtered by scope, never widened by it — asking
  // for a server outside your scope returns nothing, not someone else's host.
  if (Array.isArray(serverIds) && serverIds.length > 0) where.id = { in: serverIds };

  const servers = await prisma.server.findMany({
    where,
    select: SERVER_SELECT,
    orderBy: [{ hostname: 'asc' }],
  });

  // Posture mode's "already done" is "has ever sent a snapshot", not "is
  // reporting right now". A stale collector is installed — skipping only the
  // fresh ones would put every silent host back in the install queue on
  // every run, which is the same conflation that once hid 22 real findings
  // behind an install prompt on Customer Details.
  //
  // Staleness is still reported per host so the caller can offer "reinstall
  // the ones that stopped reporting" deliberately, via `includeDone`.
  //
  // The collector's state — degraded, refused, stale — is reported per host
  // for the same reason: those are the hosts a person most wants to re-run
  // on, and "already done" must not hide them.
  const snapshots = new Map();
  let settings = null;
  if (mode === 'posture' && servers.length > 0) {
    settings = await postureSettingsService.getSettings(orgId);
    const latest = await latestSnapshots(orgId, servers.map((s) => s.id));
    for (const [id, snap] of latest) snapshots.set(id, snap);
  }
  const now = Date.now();

  const targets = [];
  const skipped = [];

  for (const server of servers) {
    // Server.sshUser is non-nullable (defaults to 'root'), so a bootstrapped
    // host always has a principal to name in the certificate.
    const certEligible = isBootstrapped(server);
    const entry = {
      id: server.id,
      hostname: server.hostname,
      displayName: server.displayName,
      ipAddress: server.ipAddress,
      environment: server.environment,
      osType: server.osType,
      protocol: server.protocol,
      authMode: server.authMode,
      sshUser: server.sshUser,
      customer: server.customer,
      credential: server.credential,
      // Which secret the run will use. 'server' needs nothing from the user;
      // 'supplied' consumes the one fallback identity for the whole batch.
      bootstrapped: certEligible,
      // Precedence: the host's own saved identity, then a certificate if the
      // host trusts our CA, then the one identity supplied for the batch.
      //
      // Certificate outranks the supplied fallback deliberately. The fallback
      // is a blunt instrument — one account typed once, for hosts that have
      // nothing — and there is no reason to believe it exists on a host that
      // never needed it. A certificate is minted for THIS host and THIS
      // principal, so it is both more likely to work and less to leak. The
      // runner still falls back to the supplied credentials if the
      // certificate connection fails.
      credentialSource: server.credentialId
        ? 'server'
        : certEligible
          ? 'certificate'
          : hasFallbackCredentials
            ? 'supplied'
            : null,
      alreadyDone:
        mode === 'posture'
          ? snapshots.has(server.id) || !!server.postureRejectedAt || !!server.postureInstalledAt
          : server.provisionStatus === 'provisioned' || !!server.agentId,
      collectorState: mode === 'posture' ? classifyCollector(server, snapshots.get(server.id), settings, now) : null,
      lastSnapshotAt: snapshots.get(server.id)?.receivedAt || null,
      degradedReasons: snapshots.get(server.id)?.collectorOk === false ? snapshots.get(server.id).degradedReasons : [],
      notes: snapshots.get(server.id)?.notes || [],
      collectorVersion: snapshots.get(server.id)?.agentVersion || null,
      rejection: server.postureRejectedAt ? { at: server.postureRejectedAt, reason: server.postureRejectReason } : null,
      // A sudo password saved for this host (Keystore). Only matters for a
      // certificate install as a non-root user, which has no password of its
      // own to answer sudo with.
      savedSudo: server.sudoCredential ? { id: server.sudoCredential.id, name: server.sudoCredential.name } : null,
    };
    // Installed but silent / degraded / refused. Not skip reasons on their
    // own — hints that this is a host worth re-running on.
    entry.stale = entry.collectorState === 'stale';
    entry.degraded = entry.collectorState === 'degraded';
    entry.rejected = entry.collectorState === 'rejected';
    // Reporting fine, but on an older collector than this Shellius ships —
    // the fixes in the newer one only arrive with a reinstall.
    entry.outdated =
      mode === 'posture' &&
      (entry.collectorState === 'reporting' || entry.collectorState === 'degraded') &&
      isOlderCollector(entry.collectorVersion);
    entry.needsReinstall = entry.stale || entry.degraded || entry.rejected || entry.outdated;
    const hard = hardSkipReason(server);
    // Whether a re-run is possible at all, independent of whether this plan
    // made the host a target — the UI offers "reinstall" on already-done
    // hosts, and must not offer it where nothing could connect.
    entry.installable = !hard && !!entry.credentialSource;

    if (hard) {
      skipped.push({ ...entry, reason: hard, message: SKIP_REASONS[hard] });
      continue;
    }
    if (entry.alreadyDone && !includeDone) {
      const reason = mode === 'posture' ? 'collector_installed' : 'already_provisioned';
      skipped.push({ ...entry, reason, message: SKIP_REASONS[reason] });
      continue;
    }
    if (!entry.credentialSource) {
      skipped.push({ ...entry, reason: 'no_credentials', message: SKIP_REASONS.no_credentials });
      continue;
    }
    targets.push(entry);
  }

  return {
    mode,
    targets,
    skipped,
    counts: {
      total: servers.length,
      targets: targets.length,
      skipped: skipped.length,
      usingServerIdentity: targets.filter((t) => t.credentialSource === 'server').length,
      usingCertificate: targets.filter((t) => t.credentialSource === 'certificate').length,
      usingSuppliedCredentials: targets.filter((t) => t.credentialSource === 'supplied').length,
      staleCollectors: skipped.filter((s) => s.stale).length,
      degradedCollectors: skipped.filter((s) => s.degraded).length,
      rejectedCollectors: skipped.filter((s) => s.rejected).length,
      outdatedCollectors: skipped.filter((s) => s.outdated).length,
    },
  };
}

export default { planBulkInstall, canInstallOn, isBootstrapped, SKIP_REASONS };
