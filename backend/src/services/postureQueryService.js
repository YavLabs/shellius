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
import { canInstallOn, isBootstrapped } from './bulkBootstrapService.js';
import { latestSnapshots, classifyCollector, degradedReasonsOf } from './postureCollectorState.js';
import { POSTURE_COLLECTOR_VERSION } from '../utils/postureCollectorVersion.js';
import { withContainerNames } from './postureInventoryService.js';

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
      osType: true,
      protocol: true,
      provisionStatus: true,
      agentId: true,
      credentialId: true,
      sudoCredentialId: true,
      postureRejectedAt: true,
      postureRejectReason: true,
      postureInstalledAt: true,
      customer: { select: { id: true, name: true } },
    },
    orderBy: [{ hostname: 'asc' }],
  });

  const latest = await latestSnapshots(orgId, servers.map((s) => s.id));
  const now = Date.now();

  const rows = servers.map((server) => {
    const snap = latest.get(server.id);
    // A host that cannot run the collector is not a gap to be closed. It gets
    // its own state so the UI can exclude it from "not installed" instead of
    // listing an Install button that could never work.
    const collectorState = classifyCollector(server, snap, settings, now);
    const { sudoCredentialId, ...rest } = server;
    return {
      ...rest,
      collectorState,
      lastReceivedAt: snap?.receivedAt || null,
      collectorVersion: snap?.agentVersion || null,
      degradedReasons: collectorState === 'degraded' ? snap?.degradedReasons || [] : [],
      notes: snap?.notes || [],
      hasSavedSudo: !!sudoCredentialId,
      // How a bulk install would authenticate here, so the coverage list and
      // the installer never disagree about what is actually actionable.
      credentialSource: server.credentialId
        ? 'server'
        : isBootstrapped(server)
          ? 'certificate'
          : null,
    };
  });

  const filtered = state ? rows.filter((r) => r.collectorState === state) : rows;
  const start = (Math.max(1, Number(page)) - 1) * Math.min(Number(limit) || 25, 100);
  const take = Math.min(Number(limit) || 25, 100);
  const count = (st) => rows.filter((r) => r.collectorState === st).length;

  return {
    items: filtered.slice(start, start + take),
    total: filtered.length,
    page: Math.max(1, Number(page)),
    limit: take,
    counts: {
      // `reporting` keeps meaning "fresh data is arriving", degraded or not —
      // coverage is about whether we hear from the host. `degraded` is the
      // part of it that cannot be fully trusted.
      reporting: count('reporting') + count('degraded'),
      healthy: count('reporting'),
      degraded: count('degraded'),
      rejected: count('rejected'),
      awaitingReport: count('awaiting_report'),
      stale: count('stale'),
      notInstalled: count('not_installed'),
      notApplicable: count('not_applicable'),
      total: rows.filter((r) => r.collectorState !== 'not_applicable').length,
      totalAll: rows.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared findings predicate — used by both getSummary (tiles/sections) and
// listFindings (rows), so the two can never disagree about what a filter
// means. Built as an array of conditions ANDed together at the call site
// (`{ AND: and }`), rather than one mutable `where` object: a section split
// (listFindings) and a live/muted split (getSummary) each need to add their
// own `OR` clause on top, and a single `where.OR = ...` assignment would
// silently clobber this one's `OR` (the free-text search) if both existed
// on the same object.
// ---------------------------------------------------------------------------

/**
 * Free-text match for a finding: message, code, owner label, recognised
 * service, server hostname/displayName, or an exact port number. Postgres
 * `contains`/`insensitive` rather than an in-memory filter — the findings
 * list and the summary counts are both server-paginated/aggregated queries,
 * and loading every row to filter in JS would defeat that.
 */
export function findingsSearchWhere(q) {
  const needle = typeof q === 'string' ? q.trim() : '';
  if (!needle) return null;
  const or = [
    { message: { contains: needle, mode: 'insensitive' } },
    { code: { contains: needle, mode: 'insensitive' } },
    { ownerLabel: { contains: needle, mode: 'insensitive' } },
    { service: { contains: needle, mode: 'insensitive' } },
    { server: { hostname: { contains: needle, mode: 'insensitive' } } },
    { server: { displayName: { contains: needle, mode: 'insensitive' } } },
  ];
  const asPort = Number(needle);
  if (Number.isInteger(asPort) && asPort >= 0 && asPort <= 65535) or.push({ port: asPort });
  return { OR: or };
}

/**
 * The predicate every findings read shares: org, customer scope (ANDed,
 * never overwritten by the caller's own filters — customer-scope-spec §6.3),
 * plus serverId/code/lastSeenAt range/free text. Severity and the
 * status/section partition are pushed on top by each caller, since they
 * differ between a list (one partition) and a summary (every partition's
 * count, computed from the same base).
 */
function buildFindingsWhere(orgId, scope, filters = {}) {
  const { customerId, environment, serverId, code, lastSeenFrom, lastSeenTo, q } = filters;

  const and = [{ orgId }];

  const serverFilters = [];
  const relFilter = relationScopeWhere(scope, 'server');
  if (relFilter.server) serverFilters.push(relFilter.server);
  // getSummary's server bucket counts active servers only; a finding on a
  // deactivated host staying out of these counts keeps the two buckets
  // describing the same population.
  serverFilters.push({ isActive: true });
  if (customerId) serverFilters.push({ customerId });
  if (environment) serverFilters.push({ environment });
  and.push({ server: serverFilters.length === 1 ? serverFilters[0] : { AND: serverFilters } });

  if (serverId) and.push({ serverId });
  if (code) and.push({ code });
  if (lastSeenFrom || lastSeenTo) {
    and.push({
      lastSeenAt: {
        ...(lastSeenFrom ? { gte: new Date(lastSeenFrom) } : {}),
        ...(lastSeenTo ? { lte: new Date(lastSeenTo) } : {}),
      },
    });
  }
  const search = findingsSearchWhere(q);
  if (search) and.push(search);

  return and;
}

// ---------------------------------------------------------------------------
// GET /api/posture/summary
// ---------------------------------------------------------------------------

/**
 * Fleet posture summary, optionally narrowed to one customer.
 *
 * `customerId` is a filter ON TOP of the caller's scope, never instead of
 * it — asking for a customer you cannot see returns that customer's empty
 * summary rather than its real one. The same is true of every filter here:
 * they narrow the findings inbox's tiles and section counts so they can
 * never disagree with the (equally filtered) rows under them.
 */
export async function getSummary(
  orgId,
  scope,
  { customerId, environment, serverId, code, lastSeenFrom, lastSeenTo, q } = {}
) {
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
    select: { id: true, osType: true, protocol: true, postureRejectedAt: true, postureInstalledAt: true },
  });
  // A Windows box and an RDP-only host cannot run the collector at all.
  // Counting them as "not installed" made the fleet read as permanently
  // short of covered, with no action that could ever close the gap — so
  // they are reported as their own number, excluded from the coverage math
  // rather than quietly folded into it.
  const applicable = servers.filter((s) => canInstallOn(s));
  const notApplicable = servers.length - applicable.length;
  const serverIds = applicable.map((s) => s.id);

  let reporting = 0;
  let degraded = 0;
  let rejected = 0;
  let awaitingReport = 0;
  let stale = 0;
  let notInstalled = 0;

  if (serverIds.length > 0) {
    const latest = await latestSnapshots(orgId, serverIds);
    const now = Date.now();
    for (const server of applicable) {
      const state = classifyCollector(server, latest.get(server.id), settings, now);
      if (state === 'not_installed') notInstalled += 1;
      else if (state === 'stale') stale += 1;
      else if (state === 'rejected') rejected += 1;
      else if (state === 'awaiting_report') awaitingReport += 1;
      else {
        // Degraded hosts ARE reporting — they are counted there, and
        // separately, so the tile can say "12 reporting · 3 degraded"
        // without the two numbers adding up to more than the fleet.
        reporting += 1;
        if (state === 'degraded') degraded += 1;
      }
    }
  }

  // Findings bucket — computed AFTER the scope filter (customer-scope-spec
  // §6.3: aggregates are the easiest place for a leak to slip through), and
  // after every filter the findings page itself offers: severity, server,
  // finding type, customer, environment, last-seen range, search. Sharing
  // `buildFindingsWhere` with `listFindings` is what keeps the tiles and the
  // rows under them from ever disagreeing.
  const now = new Date();
  const baseAnd = buildFindingsWhere(orgId, scope, {
    customerId, environment, serverId, code, lastSeenFrom, lastSeenTo, q,
  });
  const unresolvedAnd = [...baseAnd, { resolvedAt: null }];
  // The findings inbox is sections now, not tabs, so every section needs its
  // count before it is expanded — a collapsed section with no number is a
  // door with nothing written on it.
  const liveAnd = [...unresolvedAnd, { OR: [{ mutedUntil: null }, { mutedUntil: { lte: now } }] }];

  // The Finding-type picker's options: every code present in scope, under
  // every OTHER active filter but never narrowed by `code` itself — picking
  // one code must not make the picker forget the rest exist.
  const codesAnd = buildFindingsWhere(orgId, scope, {
    customerId, environment, serverId, lastSeenFrom, lastSeenTo, q,
  });

  const [severityGroups, mutedCount, acknowledgedCount, expectedCount, resolvedCount, codeGroups] =
    await Promise.all([
      prisma.exposureFinding.groupBy({
        by: ['severity'],
        where: { AND: liveAnd },
        _count: { _all: true },
      }),
      prisma.exposureFinding.count({ where: { AND: [...unresolvedAnd, { mutedUntil: { gt: now } }] } }),
      // Precedence, so the sections partition rather than overlap:
      // muted > expected > acknowledged > open. An EXPECTED_PUBLIC finding
      // that is also acknowledged belongs to Expected, counted once.
      prisma.exposureFinding.count({
        where: { AND: [...liveAnd, { acknowledgedAt: { not: null } }, { NOT: { code: 'EXPECTED_PUBLIC' } }] },
      }),
      prisma.exposureFinding.count({ where: { AND: [...liveAnd, { code: 'EXPECTED_PUBLIC' }] } }),
      prisma.exposureFinding.count({ where: { AND: [...baseAnd, { NOT: { resolvedAt: null } }] } }),
      prisma.exposureFinding.groupBy({ by: ['code'], where: { AND: codesAnd }, _count: { _all: true } }),
    ]);

  const findings = { critical: 0, high: 0, medium: 0, low: 0, info: 0, muted: mutedCount };
  for (const g of severityGroups) {
    const key = SEVERITY_KEYS[g.severity] || String(g.severity).toLowerCase();
    findings[key] = (findings[key] || 0) + g._count._all;
  }
  const liveTotal = findings.critical + findings.high + findings.medium + findings.low + findings.info;
  // `open` is what is left once the sections that have their own home are
  // taken out — an acknowledged or expected finding is not sitting in the
  // inbox waiting for someone.
  const sections = {
    open: Math.max(0, liveTotal - acknowledgedCount - expectedCount),
    expected: expectedCount,
    acknowledged: acknowledgedCount,
    muted: mutedCount,
    resolved: resolvedCount,
    total: liveTotal,
  };

  const codes = codeGroups
    .filter((g) => g.code)
    .map((g) => ({ value: g.code, count: g._count._all }))
    .sort((a, b) => b.count - a.count);

  return {
    servers: {
      // `total` is the population coverage is measured against: hosts that
      // could run the collector. `totalAll` keeps the true fleet size so the
      // UI can say "…and 12 hosts that cannot run it" without a second call.
      total: serverIds.length,
      totalAll: servers.length,
      reporting,
      degraded,
      rejected,
      awaitingReport,
      stale,
      notInstalled,
      notApplicable,
    },
    findings,
    sections,
    codes,
  };
}

// ---------------------------------------------------------------------------
// GET /api/posture/findings
// ---------------------------------------------------------------------------

export async function listFindings(orgId, query = {}, scope) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  const { severity, status, section, customerId, environment, serverId, code, lastSeenFrom, lastSeenTo, q } = query;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);

  // Same predicate getSummary's tiles are built from (org + scope, ANDed —
  // never overwritten — with the caller's own server/customer/environment/
  // code/date/search filters), so a section's rows and its count can never
  // disagree.
  const and = buildFindingsWhere(orgId, scope, {
    customerId, environment, serverId, code, lastSeenFrom, lastSeenTo, q,
  });
  // The column stores CRITICAL/HIGH/…; the UI keys its counts lowercase
  // because that is the shape getSummary returns. Normalising here as well
  // as at the route means any caller can pass either and a severity filter
  // can never silently match nothing.
  if (severity) and.push({ severity: String(severity).toUpperCase() });

  const now = new Date();
  // `section` is the inbox's partition (see getSummary's `sections` and
  // frontend/src/lib/postureLabels.js findingSection) — the same precedence,
  // expressed once here so a section's rows and its count can never
  // disagree. `status` stays for callers that want the coarser buckets.
  const live = () => and.push({ resolvedAt: null }, { OR: [{ mutedUntil: null }, { mutedUntil: { lte: now } }] });
  if (section === 'resolved') {
    and.push({ resolvedAt: { not: null } });
  } else if (section === 'muted') {
    and.push({ resolvedAt: null }, { mutedUntil: { gt: now } });
  } else if (section === 'expected') {
    live();
    and.push({ code: 'EXPECTED_PUBLIC' });
  } else if (section === 'acknowledged') {
    live();
    and.push({ acknowledgedAt: { not: null } }, { NOT: { code: 'EXPECTED_PUBLIC' } });
  } else if (section === 'open') {
    live();
    and.push({ acknowledgedAt: null }, { NOT: { code: 'EXPECTED_PUBLIC' } });
  } else if (status === 'resolved') {
    and.push({ resolvedAt: { not: null } });
  } else if (status === 'muted') {
    and.push({ resolvedAt: null }, { mutedUntil: { gt: now } });
  } else if (status === 'open') {
    live();
  }

  const where = { AND: and };

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

  const serverRow = await prisma.server.findFirst({
    where: { id: serverId, orgId, ...serverScopeWhere(scope) },
    select: {
      ...SERVER_SELECT,
      protocol: true,
      sshUser: true,
      provisionStatus: true,
      agentId: true,
      credentialId: true,
      postureRejectedAt: true,
      postureRejectReason: true,
      postureInstalledAt: true,
      sudoCredential: { select: { id: true, name: true, username: true } },
    },
  });
  if (!serverRow) throw new ApiError(404, 'Server not found');
  const {
    postureRejectedAt, postureRejectReason, postureInstalledAt, sudoCredential, protocol, sshUser, provisionStatus, agentId, credentialId,
    ...server
  } = serverRow;

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

  const state = classifyCollector(
    { osType: server.osType, protocol, postureRejectedAt, postureInstalledAt },
    latestSnapshot ? { receivedAt: latestSnapshot.receivedAt, collectorOk: latestSnapshot.collectorOk } : undefined,
    settings
  );
  const collector = {
    installed: !!latestSnapshot,
    version: latestSnapshot?.agentVersion || null,
    // What a reinstall would put there now.
    latestVersion: POSTURE_COLLECTOR_VERSION,
    lastSeenAt: latestSnapshot?.receivedAt || null,
    installedAt: postureInstalledAt || null,
    stale: latestSnapshot ? isStale(latestSnapshot.receivedAt, settings) : false,
    // One word for "what should the page say about the collector", so the
    // Server page, the coverage list and the installer never disagree.
    state,
    // A refusal newer than the newest accepted snapshot. The host is alive
    // and sending; Shellius is refusing what it sends.
    rejection:
      postureRejectedAt && (!latestSnapshot || postureRejectedAt > latestSnapshot.receivedAt)
        ? { at: postureRejectedAt, reason: postureRejectReason }
        : null,
    // What a reinstall would need, so the page can offer the right button
    // instead of a generic one that then asks for credentials it has.
    install: {
      canInstall: canInstallOn({ osType: server.osType, protocol }),
      bootstrapped: isBootstrapped({ provisionStatus, agentId }),
      hasIdentity: !!credentialId,
      sshUser,
      savedSudo: sudoCredential ? { id: sudoCredential.id, name: sudoCredential.name } : null,
    },
  };

  return {
    server,
    snapshot: latestSnapshot
      ? {
          collectedAt: latestSnapshot.collectedAt,
          agentVersion: latestSnapshot.agentVersion,
          collectorOk: latestSnapshot.collectorOk,
          degradedReason: latestSnapshot.degradedReason,
          degradedReasons: degradedReasonsOf(latestSnapshot),
          notes: Array.isArray(latestSnapshot.raw?.notes) ? latestSnapshot.raw.notes : [],
          firewall: latestSnapshot.firewall,
          // Which halves of the service scan ran on this host. "No stopped
          // containers" and "never looked for containers" must not render
          // the same way.
          serviceScan: latestSnapshot.raw?.serviceScan || null,
        }
      : null,
    listeners: withContainerNames(listeners, services),
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
