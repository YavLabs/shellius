/**
 * postureCollectorState.js — one classification of "how is this host's
 * collector doing", shared by everything that shows or acts on it.
 *
 * It used to be three: the coverage list, the fleet summary and the bulk
 * installer each worked it out from the newest snapshot's timestamp alone.
 * None of them looked at whether that snapshot was DEGRADED, so a host the
 * Server page flagged "Collector degraded" was, in the installer, "Already
 * done — reporting", with no way to reinstall it. And none of them could see
 * a host whose snapshots the API was refusing, which looks exactly like a
 * dead collector.
 *
 * States, most to least urgent for a person deciding what to do:
 *
 *   not_applicable  Windows / RDP-only — cannot run the collector at all.
 *   not_installed   never sent anything (and nothing refused either).
 *   rejected        the host IS sending, but its newest snapshot was
 *                   refused; the data shown is from before that.
 *   stale           sent before, has gone quiet.
 *   degraded        reporting, but could not see everything (no sudo, an
 *                   unparsed firewall, …) — its "no findings" means less.
 *   reporting       reporting, and saw everything it looks for.
 */

import prisma from '../config/db.js';
import { canInstallOn } from './bulkBootstrapService.js';

export const COLLECTOR_STATES = [
  'not_applicable',
  'not_installed',
  'rejected',
  'stale',
  'degraded',
  'reporting',
];

/** ~3 collect intervals, from receivedAt (server clock) — see postureQueryService. */
export function staleThresholdMs(settings) {
  return 3 * (settings?.collectIntervalSeconds || 300) * 1000;
}

/**
 * Newest snapshot per server: receivedAt, collectorOk, degradedReason(s),
 * agentVersion. Two queries regardless of fleet size — the max per server,
 * then exactly those rows — rather than every snapshot the retention window
 * still holds.
 *
 * @returns {Promise<Map<string, object>>}
 */
export async function latestSnapshots(orgId, serverIds) {
  const out = new Map();
  if (!serverIds || serverIds.length === 0) return out;
  const maxes = await prisma.hostSnapshot.groupBy({
    by: ['serverId'],
    where: { orgId, serverId: { in: serverIds } },
    _max: { receivedAt: true },
  });
  const pairs = maxes.filter((m) => m._max.receivedAt).map((m) => ({ serverId: m.serverId, receivedAt: m._max.receivedAt }));
  if (pairs.length === 0) return out;
  const rows = await prisma.hostSnapshot.findMany({
    where: { orgId, OR: pairs },
    select: {
      serverId: true,
      receivedAt: true,
      collectorOk: true,
      degradedReason: true,
      agentVersion: true,
      raw: true,
    },
  });
  for (const r of rows) {
    const prev = out.get(r.serverId);
    if (prev && prev.receivedAt >= r.receivedAt) continue;
    out.set(r.serverId, {
      receivedAt: r.receivedAt,
      collectorOk: r.collectorOk,
      degradedReason: r.degradedReason,
      degradedReasons: degradedReasonsOf(r),
      agentVersion: r.agentVersion,
    });
  }
  return out;
}

/** Every reason the collector gave, newest collector first, legacy fallback. */
export function degradedReasonsOf(snapshot) {
  const list = snapshot?.raw?.degradedReasons;
  if (Array.isArray(list) && list.length) return list.filter((r) => typeof r === 'string' && r);
  return snapshot?.degradedReason ? [snapshot.degradedReason] : [];
}

/**
 * Classify one server.
 *
 * @param {object} server   needs osType, protocol, postureRejectedAt
 * @param {object|undefined} latest  entry from latestSnapshots()
 * @param {object} settings  posture settings (collectIntervalSeconds)
 */
export function classifyCollector(server, latest, settings, now = Date.now()) {
  if (!canInstallOn(server)) return 'not_applicable';
  const rejectedAt = server?.postureRejectedAt ? new Date(server.postureRejectedAt).getTime() : null;
  const receivedAt = latest?.receivedAt ? new Date(latest.receivedAt).getTime() : null;
  // A refusal newer than the newest accepted snapshot means the collector is
  // alive and talking — the problem is between it and us, not on the host.
  if (rejectedAt && (!receivedAt || rejectedAt > receivedAt)) {
    // …unless the refusal itself is old: then it has gone quiet since.
    if (now - rejectedAt > staleThresholdMs(settings)) return receivedAt ? 'stale' : 'not_installed';
    return 'rejected';
  }
  if (!receivedAt) return 'not_installed';
  if (now - receivedAt > staleThresholdMs(settings)) return 'stale';
  if (latest.collectorOk === false) return 'degraded';
  return 'reporting';
}

export default { COLLECTOR_STATES, latestSnapshots, classifyCollector, degradedReasonsOf, staleThresholdMs };
