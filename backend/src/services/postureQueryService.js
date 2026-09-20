/**
 * postureQueryService.js
 *
 * Read APIs for exposure posture (docs/posture/posture-spec.md §8, §9) plus
 * the finding lifecycle actions a `posture.mute` holder can take: mute,
 * unmute, acknowledge. Ingest (`postureService.ingest`) and the alerting
 * emit path are owned elsewhere — this module only reads and toggles state
 * that already exists.
 *
 * SECURITY: every query here is customer-scoped through the `server`
 * relation (docs/rbac/customer-scope-spec.md §3.2) — `serverScopeWhere` for
 * models with their own `customerId` (Server itself), `relationScopeWhere`
 * for models that reach a server through a relation (ExposureFinding).
 * Aggregate counts (getSummary) are computed AFTER the scope filter, never
 * before — an unscoped total is as much a leak as an unscoped row.
 */

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { serverScopeWhere, relationScopeWhere } from '../lib/scope.js';
import * as postureSettingsService from './postureSettingsService.js';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const FINDING_SERVER_SELECT = {
  id: true,
  hostname: true,
  displayName: true,
  environment: true,
  customer: { select: { id: true, name: true } },
};

const FINDING_INCLUDE = { server: { select: FINDING_SERVER_SELECT } };

const SERVER_SELECT = {
  id: true,
  hostname: true,
  displayName: true,
  environment: true,
  ipAddress: true,
  port: true,
  osType: true,
  osVersion: true,
  isActive: true,
  customer: { select: { id: true, name: true } },
};

const SEVERITY_KEYS = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFO: 'info' };

// A server whose newest snapshot is older than ~3x the collect interval is
// stale (spec §9.1 / build brief). Uses `receivedAt` (server clock), not the
// agent-reported `collectedAt`, because the snapshot is attacker-controlled
// input from a host that may already be compromised (§1) — a lying clock
// must not be able to make a dead collector look fresh.
function staleThresholdMs(settings) {
  return 3 * settings.collectIntervalSeconds * 1000;
}

function isStale(lastReceivedAt, settings, now = Date.now()) {
  if (!lastReceivedAt) return false;
  return now - new Date(lastReceivedAt).getTime() > staleThresholdMs(settings);
}

/**
 * A finding's display status. `resolvedAt` wins (terminal state); a live
 * mute (mutedUntil in the future) is `muted` even if it was previously
 * acknowledged; otherwise `acknowledged` sticks until resolved so escalation
 * stays stopped (§6 rule 5) without hiding the finding from "open".
 */
function findingStatus(f, now = new Date()) {
  if (f.resolvedAt) return 'resolved';
  if (f.mutedUntil && new Date(f.mutedUntil) > now) return 'muted';
  if (f.acknowledgedAt) return 'acknowledged';
  return 'open';
}

function findingDto(f) {
  return {
    id: f.id,
    code: f.code,
    severity: f.severity,
    proto: f.proto,
    port: f.port,
    service: f.service,
    ownerLabel: f.ownerLabel,
    message: f.message,
    detail: f.detail,
    firstSeenAt: f.firstSeenAt,
    lastSeenAt: f.lastSeenAt,
    resolvedAt: f.resolvedAt,
    mutedUntil: f.mutedUntil,
    mutedReason: f.mutedReason,
    acknowledgedAt: f.acknowledgedAt,
    status: findingStatus(f),
    server: f.server
      ? {
          id: f.server.id,
          hostname: f.server.hostname,
          displayName: f.server.displayName,
          environment: f.server.environment,
          customer: f.server.customer ? { id: f.server.customer.id, name: f.server.customer.name } : null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/posture/servers — collector coverage, so the Posture page can turn
// "reporting 3 of 31" into an actionable list instead of a dead statistic.
// Same classification as getSummary(), same scope filter.
// ---------------------------------------------------------------------------

export async function listServerCoverage(orgId, scope, { state, page = 1, limit = 25 } = {}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  const settings = await postureSettingsService.getSettings(orgId);
  const servers = await prisma.server.findMany({
    where: { orgId, isActive: true, ...serverScopeWhere(scope) },
    select: {
      id: true,
      hostname: true,
      displayName: true,
      environment: true,
      authMode: true,
      customer: { select: { id: true, name: true } },
    },
    orderBy: [{ hostname: 'asc' }],
  });

  const latestPerServer = servers.length
    ? await prisma.hostSnapshot.groupBy({
        by: ['serverId'],
        where: { orgId, serverId: { in: servers.map((s) => s.id) } },
        _max: { receivedAt: true },
      })
    : [];
  const latestMap = new Map(latestPerServer.map((r) => [r.serverId, r._max.receivedAt]));
  const now = Date.now();

  const rows = servers.map((server) => {
    const lastReceivedAt = latestMap.get(server.id) || null;
    let collectorState = 'reporting';
    if (!lastReceivedAt) collectorState = 'not_installed';
    else if (isStale(lastReceivedAt, settings, now)) collectorState = 'stale';
    return { ...server, collectorState, lastReceivedAt };
  });

  const filtered = state ? rows.filter((r) => r.collectorState === state) : rows;
  const start = (Math.max(1, Number(page)) - 1) * Math.min(Number(limit) || 25, 100);
  const take = Math.min(Number(limit) || 25, 100);

  return {
    items: filtered.slice(start, start + take),
    total: filtered.length,
    page: Math.max(1, Number(page)),
    limit: take,
    counts: {
      reporting: rows.filter((r) => r.collectorState === 'reporting').length,
      stale: rows.filter((r) => r.collectorState === 'stale').length,
      notInstalled: rows.filter((r) => r.collectorState === 'not_installed').length,
      total: rows.length,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/posture/summary
// ---------------------------------------------------------------------------

/**
 * Fleet posture summary, optionally narrowed to one customer.
 *
 * `customerId` is a filter ON TOP of the caller's scope, never instead of
 * it — asking for a customer you cannot see returns that customer's empty
 * summary rather than its real one.
 */
export async function getSummary(orgId, scope, { customerId, environment } = {}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  const settings = await postureSettingsService.getSettings(orgId);

  // Servers bucket — scoped, active servers only (a terminated/inactive
  // server isn't part of the fleet a posture summary is reporting on).
  const servers = await prisma.server.findMany({
    where: {
      orgId,
      isActive: true,
      ...serverScopeWhere(scope),
      // ANDed, never merged into the scope predicate — a scoped caller
      // passing an out-of-scope customerId must still see nothing.
      ...(customerId || environment
        ? { AND: [...(customerId ? [{ customerId }] : []), ...(environment ? [{ environment }] : [])] }
        : {}),
    },
    select: { id: true },
  });
  const serverIds = servers.map((s) => s.id);

  let reporting = 0;
  let stale = 0;
  let notInstalled = 0;

  if (serverIds.length > 0) {
    const latestPerServer = await prisma.hostSnapshot.groupBy({
      by: ['serverId'],
      where: { orgId, serverId: { in: serverIds } },
      _max: { receivedAt: true },
    });
    const latestMap = new Map(latestPerServer.map((r) => [r.serverId, r._max.receivedAt]));
    const now = Date.now();
    for (const id of serverIds) {
      const lastReceivedAt = latestMap.get(id);
      if (!lastReceivedAt) {
        notInstalled += 1;
      } else if (isStale(lastReceivedAt, settings, now)) {
        stale += 1;
      } else {
        reporting += 1;
      }
    }
  }

  // Findings bucket — computed AFTER the scope filter (customer-scope-spec
  // §6.3: aggregates are the easiest place for a leak to slip through).
  const now = new Date();
  // Built as ONE `server` predicate rather than a scope spread plus an
  // optional serverId list. The old shape only narrowed the findings when a
  // customer or environment filter was set, so with no filters the servers
  // bucket counted active hosts while the findings bucket counted every
  // host in the org — the tiles and the table under them were describing
  // different populations, and only a deactivated server made it visible.
  const serverPredicate = { isActive: true };
  const relFilter = relationScopeWhere(scope, 'server');
  if (relFilter.server) Object.assign(serverPredicate, relFilter.server);
  if (customerId) serverPredicate.customerId = customerId;
  if (environment) serverPredicate.environment = environment;

  const findingWhere = {
    orgId,
    resolvedAt: null,
    server: serverPredicate,
  };

  const [severityGroups, mutedCount] = await Promise.all([
    prisma.exposureFinding.groupBy({
      by: ['severity'],
      where: { ...findingWhere, OR: [{ mutedUntil: null }, { mutedUntil: { lte: now } }] },
      _count: { _all: true },
    }),
    prisma.exposureFinding.count({ where: { ...findingWhere, mutedUntil: { gt: now } } }),
  ]);

  const findings = { critical: 0, high: 0, medium: 0, low: 0, info: 0, muted: mutedCount };
  for (const g of severityGroups) {
    const key = SEVERITY_KEYS[g.severity] || String(g.severity).toLowerCase();
    findings[key] = (findings[key] || 0) + g._count._all;
  }

  return {
    servers: { total: serverIds.length, reporting, stale, notInstalled },
    findings,
  };
}

// ---------------------------------------------------------------------------
// GET /api/posture/findings
// ---------------------------------------------------------------------------

export async function listFindings(orgId, query = {}, scope) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  const { severity, status, customerId, environment, serverId } = query;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);

  const where = { orgId };
  if (severity) where.severity = severity;
  if (serverId) where.serverId = serverId;

  // Scope + caller-chosen server filters must be ANDed, never overwrite one
  // another — a scoped caller passing an out-of-scope customerId must still
  // see nothing (same reasoning as serverService.listServers).
  const serverFilters = [];
  const relFilter = relationScopeWhere(scope, 'server');
  if (relFilter.server) serverFilters.push(relFilter.server);
  // getSummary counts active servers only. Without the same predicate here,
  // a finding on a deactivated host is in the list but not in the tiles
  // above it, and the two disagree for no reason a reader can see.
  serverFilters.push({ isActive: true });
  if (customerId) serverFilters.push({ customerId });
  if (environment) serverFilters.push({ environment });
  if (serverFilters.length === 1) where.server = serverFilters[0];
  else if (serverFilters.length > 1) where.server = { AND: serverFilters };

  const now = new Date();
  if (status === 'resolved') {
    where.resolvedAt = { not: null };
  } else if (status === 'muted') {
    where.resolvedAt = null;
    where.mutedUntil = { gt: now };
  } else if (status === 'open') {
    where.resolvedAt = null;
    where.OR = [{ mutedUntil: null }, { mutedUntil: { lte: now } }];
  }

  const [items, total] = await Promise.all([
    prisma.exposureFinding.findMany({
      where,
      include: FINDING_INCLUDE,
      orderBy: [{ lastSeenAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.exposureFinding.count({ where }),
  ]);

  return { findings: items.map(findingDto), total, page, limit };
}

// ---------------------------------------------------------------------------
// GET /api/posture/servers/:serverId
// ---------------------------------------------------------------------------

export async function getServerPosture(orgId, serverId, scope) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  if (!serverId) throw new ApiError(400, 'serverId is required');

  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId, ...serverScopeWhere(scope) },
    select: SERVER_SELECT,
  });
  if (!server) throw new ApiError(404, 'Server not found');

  const settings = await postureSettingsService.getSettings(orgId);

  // Server is already confirmed in-scope above, so the rest of these can be
  // plain serverId lookups — no need to re-apply the scope predicate.
  const latestSnapshot = await prisma.hostSnapshot.findFirst({
    where: { orgId, serverId },
    orderBy: { receivedAt: 'desc' },
  });

  const listeners = latestSnapshot
    ? await prisma.hostListener.findMany({
        where: { orgId, serverId, snapshotId: latestSnapshot.id },
        orderBy: [{ port: 'asc' }, { proto: 'asc' }],
      })
    : [];

  // Installed services and their state. Listeners only cover what is
  // LISTENING; a stopped container's published port and its firewall rule
  // both outlive the socket, so the ports view needs this to show the port
  // at all — and to say why nothing is on it.
  const services = latestSnapshot
    ? await prisma.hostService.findMany({
        where: { orgId, serverId, snapshotId: latestSnapshot.id },
        orderBy: [{ running: 'desc' }, { kind: 'asc' }, { name: 'asc' }],
      })
    : [];

  const findingRows = await prisma.exposureFinding.findMany({
    where: { orgId, serverId },
    include: FINDING_INCLUDE,
    orderBy: [{ resolvedAt: 'asc' }, { lastSeenAt: 'desc' }],
  });

  // Sparkline data — bounded read even if the retention job hasn't run yet
  // (spec §13 "the fleet page must never load every listener row"; the same
  // discipline applies to a single host's metric history).
  const metricRows = await prisma.hostMetricSample.findMany({
    where: { orgId, serverId },
    orderBy: { at: 'desc' },
    take: 1500,
  });

  const collector = latestSnapshot
    ? {
        installed: true,
        version: latestSnapshot.agentVersion || null,
        lastSeenAt: latestSnapshot.receivedAt,
        stale: isStale(latestSnapshot.receivedAt, settings),
      }
    : { installed: false, version: null, lastSeenAt: null, stale: false };

  return {
    server,
    snapshot: latestSnapshot
      ? {
          collectedAt: latestSnapshot.collectedAt,
          agentVersion: latestSnapshot.agentVersion,
          collectorOk: latestSnapshot.collectorOk,
          degradedReason: latestSnapshot.degradedReason,
          firewall: latestSnapshot.firewall,
          // Which halves of the service scan ran on this host. "No stopped
          // containers" and "never looked for containers" must not render
          // the same way.
          serviceScan: latestSnapshot.raw?.serviceScan || null,
        }
      : null,
    listeners,
    services,
    findings: findingRows.map(findingDto),
    metrics: metricRows
      .slice()
      .reverse()
      .map((m) => ({ at: m.at, cpuPct: m.cpuPct, memPct: m.memPct, diskPct: m.diskPct, load1: m.load1 })),
    collector,
  };
}

// ---------------------------------------------------------------------------
// Finding lifecycle: mute / unmute / acknowledge
// ---------------------------------------------------------------------------

async function getFindingInScope(orgId, findingId, scope) {
  const finding = await prisma.exposureFinding.findFirst({
    where: { id: findingId, orgId, ...relationScopeWhere(scope, 'server') },
    include: FINDING_INCLUDE,
  });
  if (!finding) throw new ApiError(404, 'Finding not found');
  return finding;
}

/**
 * Mute a finding until a fixed date or for N days, with a mandatory reason
 * (spec §7 "Mute/unmute, acknowledge"). A muted finding notifies nobody,
 * including escalations (§6 rule 2) — enforced by the alerting path reading
 * `mutedUntil`, not here.
 */
export async function muteFinding(orgId, findingId, { days, until, reason } = {}, actorId, scope) {
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!trimmedReason) throw new ApiError(400, 'reason is required');

  const finding = await getFindingInScope(orgId, findingId, scope);
  if (finding.resolvedAt) throw new ApiError(400, 'Cannot mute a resolved finding');

  let mutedUntil;
  if (until) {
    mutedUntil = new Date(until);
    if (Number.isNaN(mutedUntil.getTime())) throw new ApiError(400, 'until must be a valid date');
  } else if (days) {
    const n = parseInt(days, 10);
    if (!Number.isFinite(n) || n < 1) throw new ApiError(400, 'days must be a positive integer');
    mutedUntil = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  } else {
    throw new ApiError(400, 'days or until is required');
  }

  const updated = await prisma.exposureFinding.update({
    where: { id: finding.id },
    data: { mutedUntil, mutedReason: trimmedReason, mutedById: actorId || null },
    include: FINDING_INCLUDE,
  });
  return findingDto(updated);
}

export async function unmuteFinding(orgId, findingId, scope) {
  const finding = await getFindingInScope(orgId, findingId, scope);
  const updated = await prisma.exposureFinding.update({
    where: { id: finding.id },
    data: { mutedUntil: null, mutedReason: null, mutedById: null },
    include: FINDING_INCLUDE,
  });
  return findingDto(updated);
}

/** Acknowledging stops a finding's escalation clock without resolving it (§6 rule 5). */
export async function acknowledgeFinding(orgId, findingId, actorId, scope) {
  const finding = await getFindingInScope(orgId, findingId, scope);
  if (finding.resolvedAt) throw new ApiError(400, 'Cannot acknowledge a resolved finding');

  const updated = await prisma.exposureFinding.update({
    where: { id: finding.id },
    data: { acknowledgedAt: new Date(), acknowledgedById: actorId || null },
    include: FINDING_INCLUDE,
  });
  return findingDto(updated);
}

export default {
  getSummary,
  listFindings,
  getServerPosture,
  muteFinding,
  unmuteFinding,
  acknowledgeFinding,
};

// ---------------------------------------------------------------------------
// Resource history — the drill-down behind the sparklines
// ---------------------------------------------------------------------------

/** Bucket sizes offered to the client, smallest first. */
export const METRIC_BUCKETS = {
  raw: 0,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

const METRIC_FIELDS = ['cpuPct', 'memPct', 'diskPct', 'load1'];

/**
 * Pick a bucket that keeps a range under ~500 points when the caller said
 * "auto". A chart with 20k points is slower to draw and no more informative
 * than one with 500, and the raw rows still exist for anyone who asks.
 */
function autoBucket(rangeMs, intervalSeconds) {
  const sampleMs = Math.max((intervalSeconds || 300) * 1000, 60 * 1000);
  const target = 500;
  const needed = (rangeMs / sampleMs) / target;
  if (needed <= 1) return 'raw';
  const ordered = ['5m', '15m', '1h', '6h', '1d'];
  for (const key of ordered) {
    if (rangeMs / METRIC_BUCKETS[key] <= target) return key;
  }
  return '1d';
}

function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / values.length,
    p50: at(0.5),
    p95: at(0.95),
    samples: values.length,
  };
}

/**
 * Resource samples for one server over a window, bucketed for charting.
 *
 * Returns the aggregate for the whole window alongside the series, because
 * "was this host at 95% for an hour or for a week" is the question the
 * sparkline cannot answer — and the answer must come from the same rows the
 * chart draws, not a second query that could disagree with it.
 *
 * @param {string} orgId
 * @param {string} serverId
 * @param {object} scope   caller's customer scope — the server lookup applies it
 * @param {{from?: Date, to?: Date, bucket?: string}} opts
 */
export async function getServerMetrics(orgId, serverId, scope, { from, to, bucket = 'auto' } = {}) {
  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId, ...serverScopeWhere(scope) },
    select: SERVER_SELECT,
  });
  if (!server) throw new ApiError(404, 'Server not found');

  const settings = await postureSettingsService.getSettings(orgId);
  const until = to || new Date();
  const since = from || new Date(until.getTime() - 24 * 60 * 60 * 1000);
  if (since >= until) throw new ApiError(400, '`from` must be before `to`');

  const rows = await prisma.hostMetricSample.findMany({
    where: { orgId, serverId, at: { gte: since, lte: until } },
    orderBy: { at: 'asc' },
    select: { at: true, cpuPct: true, memPct: true, diskPct: true, load1: true },
  });

  const chosen =
    bucket === 'auto' ? autoBucket(until.getTime() - since.getTime(), settings.collectIntervalSeconds) : bucket;
  const width = METRIC_BUCKETS[chosen] ?? 0;

  let series;
  if (width === 0) {
    series = rows.map((r) => ({
      at: r.at,
      cpuPct: r.cpuPct,
      memPct: r.memPct,
      diskPct: r.diskPct,
      load1: r.load1,
      samples: 1,
    }));
  } else {
    // Floor each row into a fixed bucket and average within it. Buckets with
    // no rows are simply absent — inventing zeroes for a window when the
    // collector was down would read as "idle host" instead of "no data".
    const buckets = new Map();
    for (const r of rows) {
      const key = Math.floor(new Date(r.at).getTime() / width) * width;
      let b = buckets.get(key);
      if (!b) {
        b = { at: new Date(key), cpuPct: [], memPct: [], diskPct: [], load1: [] };
        buckets.set(key, b);
      }
      for (const f of METRIC_FIELDS) {
        if (r[f] !== null && r[f] !== undefined) b[f].push(r[f]);
      }
    }
    series = [...buckets.values()]
      .sort((a, b) => a.at - b.at)
      .map((b) => {
        const out = { at: b.at, samples: Math.max(...METRIC_FIELDS.map((f) => b[f].length)) };
        for (const f of METRIC_FIELDS) {
          out[f] = b[f].length ? b[f].reduce((x, y) => x + y, 0) / b[f].length : null;
        }
        return out;
      });
  }

  const summary = {};
  for (const f of METRIC_FIELDS) {
    summary[f] = summarize(rows.map((r) => r[f]).filter((v) => v !== null && v !== undefined));
  }

  // The oldest row we actually hold, so the UI can say "retention is 24h"
  // rather than drawing an empty chart for a range nobody can satisfy.
  const oldest = await prisma.hostMetricSample.findFirst({
    where: { orgId, serverId },
    orderBy: { at: 'asc' },
    select: { at: true },
  });

  return {
    server,
    range: { from: since, to: until },
    bucket: chosen,
    bucketMs: width,
    series,
    summary,
    retention: {
      hours: settings.metricRetentionHours,
      oldestSampleAt: oldest?.at || null,
      collectIntervalSeconds: settings.collectIntervalSeconds,
    },
  };
}
