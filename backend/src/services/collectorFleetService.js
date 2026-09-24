/**
 * collectorFleetService.js — what version of the collector is actually
 * running out there?
 *
 * Every piece of this already existed per server: `serverAgentStatus` marks a
 * host "Update available" and the Server page shows it. What did not exist was
 * the fleet answer. "Three of your ninety hosts are two versions behind" is
 * not a question you can answer by paging through a list, and it is the
 * question that decides whether an upgrade is worth doing.
 *
 * Read-only and customer-scoped, like everything else on the posture side: a
 * scoped user's fleet is their customers' hosts, not the org's.
 */

import prisma from '../config/db.js';
import { serverScopeWhere } from '../lib/scope.js';
import * as postureSettingsService from './postureSettingsService.js';
import { latestSnapshots, classifyCollector } from './postureCollectorState.js';
import { canInstallOn } from './bulkBootstrapService.js';
import { isOlderCollector, POSTURE_COLLECTOR_VERSION } from '../utils/postureCollectorVersion.js';

const SELECT = {
  id: true,
  hostname: true,
  displayName: true,
  osType: true,
  protocol: true,
  isActive: true,
  authMode: true,
  environment: true,
  customerId: true,
  provisionStatus: true,
  provisionError: true,
  agentId: true,
  agentLastSeen: true,
  agentTokenHash: true,
  postureRejectedAt: true,
  postureInstalledAt: true,
  customer: { select: { id: true, name: true } },
};

/**
 * Collector coverage and version spread across the fleet.
 *
 * @param {string} orgId
 * @param {object} scope  caller's customer scope
 * @returns {Promise<{
 *   latestVersion: string|null,
 *   totals: object,
 *   versions: Array<{version: string|null, count: number, outdated: boolean}>,
 *   outdated: Array<object>
 * }>}
 */
export async function fleetCollectorVersions(orgId, scope) {
  const servers = await prisma.server.findMany({
    where: { orgId, ...serverScopeWhere(scope) },
    select: SELECT,
  });

  // Windows and RDP-only hosts cannot run the collector at all. Counting them
  // as "not installed" is how a fleet looks permanently half-covered, which
  // is the thing that makes a coverage number stop being read.
  const eligible = servers.filter((s) => canInstallOn(s) && s.isActive !== false);
  const notApplicable = servers.length - eligible.length;

  const settings = await postureSettingsService.getSettings(orgId);
  const snapshots = await latestSnapshots(orgId, eligible.map((s) => s.id));

  const byVersion = new Map();
  const outdated = [];
  const totals = {
    servers: servers.length,
    eligible: eligible.length,
    notApplicable,
    reporting: 0,
    outdated: 0,
    degraded: 0,
    stale: 0,
    notInstalled: 0,
    rejected: 0,
    awaitingReport: 0,
  };

  for (const s of eligible) {
    const latest = snapshots.get(s.id) || null;
    const state = classifyCollector(s, latest, settings);
    const version = latest?.agentVersion || null;
    const isOld = isOlderCollector(version);

    switch (state) {
      case 'reporting':
        totals.reporting += 1;
        break;
      case 'degraded':
        totals.degraded += 1;
        break;
      case 'stale':
        totals.stale += 1;
        break;
      case 'rejected':
        totals.rejected += 1;
        break;
      case 'awaiting_report':
        totals.awaitingReport += 1;
        break;
      default:
        totals.notInstalled += 1;
    }

    // A host that has reported at all has a version worth counting, whatever
    // else is wrong with it. `serverAgentStatus` only promotes 'reporting' to
    // 'outdated', so a degraded host on an ancient collector shows as
    // degraded there and would otherwise never appear in an upgrade list.
    if (latest) {
      const key = version || 'unknown';
      const entry = byVersion.get(key) || { version, count: 0, outdated: isOld };
      entry.count += 1;
      byVersion.set(key, entry);
      if (isOld) {
        totals.outdated += 1;
        outdated.push({
          id: s.id,
          hostname: s.hostname,
          displayName: s.displayName,
          environment: s.environment,
          customer: s.customer,
          version,
          state,
          lastReportAt: latest.receivedAt,
        });
      }
    }
  }

  const versions = [...byVersion.values()].sort((a, b) => {
    if (a.version === b.version) return 0;
    if (!a.version) return 1;
    if (!b.version) return -1;
    // Newest first.
    return isOlderCollector(a.version, b.version) ? 1 : -1;
  });

  // Worst first: the hosts furthest behind are the ones to fix.
  outdated.sort((a, b) => (isOlderCollector(a.version, b.version) ? -1 : 1));

  return { latestVersion: POSTURE_COLLECTOR_VERSION, totals, versions, outdated };
}

export default { fleetCollectorVersions };
