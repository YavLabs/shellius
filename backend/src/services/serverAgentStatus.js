/**
 * serverAgentStatus.js — the two things a Shellius host runs, and whether
 * each is working, in one shape every server list can show.
 *
 *   SSH trust  — CA trust + check-principals + the heartbeat agent (what the
 *                full bootstrap installs). Judged from provisionStatus and
 *                the heartbeat, which the agent sends every 60 s.
 *   Collector  — the posture collector. Judged by postureCollectorState,
 *                the same classification the Posture pages use.
 *
 * Each returns { state, label, tone, detail } so the UI never re-derives a
 * verdict from raw columns and two lists never disagree about one host.
 */

import prisma from '../config/db.js';
import * as postureSettingsService from './postureSettingsService.js';
import { latestSnapshots, classifyCollector } from './postureCollectorState.js';
import { canInstallOn, isBootstrapped } from './bulkBootstrapService.js';
import { isOlderCollector, POSTURE_COLLECTOR_VERSION } from '../utils/postureCollectorVersion.js';

/** The heartbeat runs every 60 s; ten missed beats is "stopped", not a blip. */
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000;

export const SSH_TRUST_STATES = ['healthy', 'legacy_token', 'stale', 'no_heartbeat', 'installing', 'failed', 'not_installed', 'identity_auth', 'not_applicable'];
export const COLLECTOR_STATES = ['reporting', 'outdated', 'degraded', 'awaiting_report', 'rejected', 'stale', 'not_installed', 'not_applicable'];

/**
 * @param {object} s  server row: osType, protocol, authMode, provisionStatus,
 *                    provisionError, agentId, agentLastSeen, agentTokenHash
 */
export function sshTrustStatus(s, now = Date.now()) {
  if (!canInstallOn(s)) {
    return { state: 'not_applicable', label: 'Not applicable', tone: 'neutral', detail: 'Windows / RDP-only hosts do not run the Shellius agent.' };
  }
  if (s.provisionStatus === 'provisioning') {
    return { state: 'installing', label: 'Installing', tone: 'info', detail: 'A bootstrap is running now.' };
  }
  const bootstrapped = isBootstrapped(s);
  if (!bootstrapped) {
    if (s.provisionStatus === 'failed') {
      return { state: 'failed', label: 'Install failed', tone: 'danger', detail: s.provisionError || 'The last bootstrap failed.' };
    }
    if (s.authMode === 'credential') {
      return {
        state: 'identity_auth',
        label: 'Identity auth',
        tone: 'neutral',
        detail: 'Connects with a stored identity. Certificate access (SSH trust) is not installed — bootstrap the host to use it.',
      };
    }
    return { state: 'not_installed', label: 'Not installed', tone: 'warning', detail: 'Not bootstrapped: this host does not trust the Shellius CA yet.' };
  }
  const seen = s.agentLastSeen ? new Date(s.agentLastSeen).getTime() : null;
  if (!seen) {
    return {
      state: 'no_heartbeat',
      label: 'No heartbeat',
      tone: 'warning',
      detail: 'Bootstrapped, but the agent has never checked in. Its timer may not be running, or the host cannot reach Shellius.',
    };
  }
  if (now - seen > HEARTBEAT_STALE_MS) {
    return { state: 'stale', label: 'Agent silent', tone: 'warning', detail: 'The agent stopped checking in.', lastSeenAt: s.agentLastSeen };
  }
  if (!s.agentTokenHash) {
    return {
      state: 'legacy_token',
      label: 'Legacy token',
      tone: 'warning',
      detail: 'Working, but on the shared legacy token. Re-run the bootstrap to give it its own.',
      lastSeenAt: s.agentLastSeen,
    };
  }
  return { state: 'healthy', label: 'Healthy', tone: 'success', detail: 'CA trust installed and the agent is checking in.', lastSeenAt: s.agentLastSeen };
}

const COLLECTOR_LABELS = {
  reporting: { label: 'Reporting', tone: 'success', detail: 'Reporting on schedule and seeing everything it looks for.' },
  outdated: { label: 'Update available', tone: 'info', detail: 'Reporting, on an older collector. Reinstall to update.' },
  degraded: { label: 'Degraded', tone: 'danger', detail: 'Reporting, but could not see everything. Its report is incomplete.' },
  awaiting_report: { label: 'Waiting for report', tone: 'info', detail: 'Just (re)installed — the new collector has not reported yet.' },
  rejected: { label: 'Reports refused', tone: 'danger', detail: 'The collector is sending, but Shellius refuses its reports.' },
  stale: { label: 'Stopped reporting', tone: 'warning', detail: 'The collector has gone quiet.' },
  not_installed: { label: 'Not installed', tone: 'neutral', detail: 'No posture collector on this host.' },
  not_applicable: { label: 'Not applicable', tone: 'neutral', detail: 'Windows / RDP-only hosts cannot run the collector.' },
};

export function collectorStatus(server, latest, settings, now = Date.now()) {
  let state = classifyCollector(server, latest, settings, now);
  if (state === 'reporting' && isOlderCollector(latest?.agentVersion)) state = 'outdated';
  return {
    state,
    ...COLLECTOR_LABELS[state],
    version: latest?.agentVersion || null,
    latestVersion: POSTURE_COLLECTOR_VERSION,
    lastReportAt: latest?.receivedAt || null,
    notes: latest?.notes?.length || 0,
  };
}

/** The server columns the two statuses need, for callers building a select. */
export const STATUS_SELECT = {
  id: true,
  osType: true,
  protocol: true,
  authMode: true,
  provisionStatus: true,
  provisionError: true,
  agentId: true,
  agentLastSeen: true,
  agentTokenHash: true,
  postureRejectedAt: true,
  postureInstalledAt: true,
};

/**
 * Both statuses for many servers at once — two snapshot queries total,
 * whatever the page size.
 *
 * @param {string} orgId
 * @param {Array<object>} servers rows carrying STATUS_SELECT's fields
 * @returns {Promise<Map<string, {sshTrust, collector}>>}
 */
export async function statusesFor(orgId, servers) {
  const out = new Map();
  if (!servers?.length) return out;
  const [settings, latest] = await Promise.all([
    postureSettingsService.getSettings(orgId),
    latestSnapshots(orgId, servers.map((s) => s.id)),
  ]);
  const now = Date.now();
  for (const s of servers) {
    out.set(s.id, { sshTrust: sshTrustStatus(s, now), collector: collectorStatus(s, latest.get(s.id), settings, now) });
  }
  return out;
}

/**
 * Ids of the servers matching `where` whose statuses pass the filters.
 * Statuses are computed, not stored, so filtering on them means computing
 * them for the whole (already scope-filtered) candidate set first.
 */
export async function filterIdsByStatus(orgId, where, { sshTrust, collector } = {}) {
  const rows = await prisma.server.findMany({ where, select: STATUS_SELECT });
  const statuses = await statusesFor(orgId, rows);
  return rows
    .filter((r) => {
      const st = statuses.get(r.id);
      if (sshTrust && st.sshTrust.state !== sshTrust) return false;
      if (collector && st.collector.state !== collector) return false;
      return true;
    })
    .map((r) => r.id);
}

export default { sshTrustStatus, collectorStatus, statusesFor, filterIdsByStatus, SSH_TRUST_STATES, COLLECTOR_STATES };
