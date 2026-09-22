import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { UNSCOPED, relationScopeWhere } from '../lib/scope.js';
import { NONE, buildGroupTree, parseGroupBy } from '../utils/groupTree.js';

/**
 * The fleet's service inventory — every listening port on every reporting
 * host, and the services behind them.
 *
 * Posture answers "what is wrong". This answers "what is running, and
 * where", which is a different question with its own users: find every host
 * running a service before a CVE window, prove nothing still listens on a
 * port you retired, hand an auditor the list. Those were only answerable by
 * opening each server's Ports tab one at a time.
 *
 * Reads HostListener directly with no snapshot join: postureService.ingest
 * deletes and recreates a server's listeners inside the snapshot
 * transaction, so the table only ever holds each host's current state. If
 * that ever changes, this becomes wrong rather than slow, so it is asserted
 * here rather than assumed silently.
 */

// A fleet's worth of listeners is thousands of rows, not millions, and the
// grouping key is computed rather than stored — so the catalogue aggregates
// in memory. The cap is what stops that being a promise we cannot keep.
const MAX_ROWS = 20000;

const SERVER_SELECT = {
  id: true,
  hostname: true,
  displayName: true,
  ipAddress: true,
  environment: true,
  osType: true,
  isActive: true,
  customer: { select: { id: true, name: true } },
};

/**
 * The name a listener is filed under in the catalogue.
 *
 * `service` is only set when the collector recognised an actual protocol.
 * Everything else is filed under what it calls itself — the container name,
 * the unit, the pm2 app — because that is the name someone searching for
 * "nginx" or "billing-api" actually types. Falling back to "unknown" would
 * pile every unattributed socket into one meaningless bucket.
 *
 * Mirrors the intent of frontend/src/lib/postureLabels.js `serviceLabel`;
 * that one words a row for display, this one buckets rows for grouping.
 */
export function serviceKey(listener) {
  const name = listener?.service || listener?.ownerName || listener?.ownerRef || null;
  if (!name) return { key: '__unattributed__', name: 'Unattributed', kind: 'unknown' };
  return {
    key: `${listener.service ? 'service' : listener.ownerKind || 'process'}:${String(name).toLowerCase()}`,
    name: String(name),
    kind: listener.service ? 'service' : listener.ownerKind || 'process',
  };
}

/** `ownerKind`/`ownerKinds` (csv or array) → an array of exact values, or null for "no filter". */
export function parseOwnerKinds(ownerKind, ownerKinds) {
  const csv = Array.isArray(ownerKinds) ? ownerKinds : String(ownerKinds || '').split(',');
  const set = new Set([...(ownerKind ? [ownerKind] : []), ...csv].map((v) => String(v || '').trim()).filter(Boolean));
  return set.size ? [...set] : null;
}

const isNone = (v) => v === NONE;

// A predicate no row satisfies. Used when a group-by level hands back NONE
// for a column that can never be empty (a listener always has a server, a
// server always has a customer and an environment): that group cannot
// exist, so opening it must show nothing rather than throw on a `null`
// Prisma would reject for a required column.
const MATCH_NOTHING = { id: { in: [] } };

/**
 * The server-relation predicates shared by listeners and host services.
 * Returned as a list to be ANDed — see the note in buildWhere().
 */
function serverRelationFilters(scope, { serverId, serverIds, customerId, environment }) {
  const serverFilters = [];
  const relFilter = relationScopeWhere(scope, 'server');
  if (relFilter.server) serverFilters.push(relFilter.server);
  if (serverId) serverFilters.push(isNone(serverId) ? MATCH_NOTHING : { id: serverId });
  else if (Array.isArray(serverIds) && serverIds.length) serverFilters.push({ id: { in: serverIds } });
  if (customerId) serverFilters.push(isNone(customerId) ? MATCH_NOTHING : { customerId });
  if (environment) serverFilters.push(isNone(environment) ? MATCH_NOTHING : { environment });
  // Terminated hosts keep their rows for audit; they are not part of "what is
  // running right now".
  serverFilters.push({ isActive: true });
  return serverFilters;
}

function buildWhere(orgId, scope, filters = {}) {
  const {
    proto,
    reachability,
    ownerKind,
    ownerKinds,
    port,
    portMin,
    portMax,
    service,
  } = filters;

  const where = { orgId };

  // NONE on a column a listener always has (proto, ownerKind) matches no
  // listener. NONE on reachability / service is NOT pushed down here: it is
  // matched in memory after the merge (a declared port's reachability and
  // service ARE empty), and the sockets must still be loaded for that merge
  // — a socket filtered out at the query would stop shadowing the
  // declaration of the same port, which would then appear in its place.
  if (proto) where.proto = isNone(proto) ? { in: [] } : proto;
  if (reachability && !isNone(reachability)) where.reachability = reachability;
  if (service && !isNone(service)) where.service = service;
  const kinds = parseOwnerKinds(ownerKind, ownerKinds);
  if (kinds) {
    const real = kinds.filter((k) => !isNone(k));
    where.ownerKind = real.length === 1 ? real[0] : { in: real };
  }
  if (port !== undefined && port !== null && port !== '') where.port = isNone(port) ? { in: [] } : Number(port);
  else if (portMin != null || portMax != null) {
    where.port = {};
    if (portMin != null) where.port.gte = Number(portMin);
    if (portMax != null) where.port.lte = Number(portMax);
  }

  // Server-side predicates live on the relation, ANDed as an array rather
  // than merged into one object. A plain `{ ...scopeWhere.server,
  // ...callerWhere }` merge is a real leak here: scope's own predicate is
  // `{ customerId: { in: [...] } }`, and a caller-supplied `customerId` is a
  // bare string on the SAME key — the later spread silently overwrites the
  // former, so a scoped caller naming any other customerId outright replaces
  // their own scope instead of narrowing within it (customer-scope-spec
  // §6.3). `AND` keeps the two predicates as separate conditions that must
  // both hold, so an out-of-scope customerId/serverId can only ever narrow
  // the result to nothing.
  const serverFilters = serverRelationFilters(scope, filters);
  where.server = serverFilters.length === 1 ? serverFilters[0] : { AND: serverFilters };

  return where;
}

/**
 * Free-text match across the fields the row actually displays.
 *
 * Exported so the export path (postureExportService) filters `q` on
 * EXACTLY the same fields the page does — a customer name or IP address
 * that narrows the screen must narrow the file the same way.
 */
export function matchesQuery(row, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [
    row.service,
    row.ownerName,
    row.ownerRef,
    row.ownerDetail,
    row.ownerUser,
    row.sourcePath,
    row.bind,
    String(row.port),
    `${row.proto}/${row.port}`,
    row.server?.hostname,
    row.server?.displayName,
    row.server?.ipAddress,
    row.server?.customer?.name,
  ]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(needle));
}

/**
 * Attach the open findings for each listener's (server, proto, port), so the
 * inventory can flag a port that is also a problem without the caller having
 * to cross-reference two pages.
 */
async function attachFindings(orgId, rows) {
  if (rows.length === 0) return rows;
  const serverIds = [...new Set(rows.map((r) => r.serverId))];
  const findings = await prisma.exposureFinding.findMany({
    where: { orgId, serverId: { in: serverIds }, resolvedAt: null, port: { not: null } },
    select: { id: true, serverId: true, proto: true, port: true, severity: true, code: true },
  });
  const byKey = new Map();
  for (const f of findings) {
    // A finding with no proto applies to every protocol on that port.
    const keys = f.proto ? [`${f.serverId}:${f.proto}:${f.port}`] : ['tcp', 'udp'].map((p) => `${f.serverId}:${p}:${f.port}`);
    for (const k of keys) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(f);
    }
  }
  return rows.map((r) => ({
    ...r,
    findings: byKey.get(`${r.serverId}:${r.proto}:${r.port}`) || [],
  }));
}

/**
 * Installed services, with the ports they declare.
 *
 * Two kinds of row are invisible to a socket scan, and both belong in an
 * inventory:
 *
 *   stopped   no process, no socket — yet the firewall rule and the
 *             published port survive, and both come back the moment it
 *             starts.
 *   running, but listening only inside its own network namespace. A host
 *             running forty containers commonly shows eighteen open ports,
 *             because most containers only ever talk to each other. They
 *             are not exposed and must never be counted as such — but
 *             "what is running here" is exactly the question this page
 *             exists to answer, and leaving them out answers it wrongly.
 */
async function loadHostServices(orgId, scope, filters = {}) {
  const { serverId, serverIds, customerId, environment, ownerKind, ownerKinds, port, proto, state } = filters;
  const where = {
    orgId,
    ...(state === 'stopped' ? { running: false } : {}),
    ...(state === 'running' ? { running: true } : {}),
  };
  // Same `AND`-array reasoning as buildWhere() above: scope's own
  // `customerId: { in: [...] }` must never share a plain merge with a
  // caller-supplied `customerId`, or the caller's value silently replaces
  // the scope instead of narrowing within it.
  const serverFilters = serverRelationFilters(scope, { serverId, serverIds, customerId, environment });
  where.server = serverFilters.length === 1 ? serverFilters[0] : { AND: serverFilters };
  // `kind` on HostService is the same vocabulary as `ownerKind` on a
  // listener (docker/podman/pm2/systemd), so one filter drives both views.
  const kinds = parseOwnerKinds(ownerKind, ownerKinds);
  if (kinds) {
    const real = kinds.filter((k) => !isNone(k));
    where.kind = real.length === 1 ? real[0] : { in: real };
  }

  const rows = await prisma.hostService.findMany({
    where,
    include: { server: { select: SERVER_SELECT } },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    take: MAX_ROWS,
  });

  // A declared port filter can only be applied after the JSON is read.
  if (port || proto) {
    return rows.filter((r) =>
      (Array.isArray(r.ports) ? r.ports : []).some(
        (dp) =>
          (!port || Number(dp.port) === Number(port)) &&
          (!proto || (isNone(proto) ? !dp.proto : dp.proto === proto))
      )
    );
  }
  return rows;
}

/**
 * A service's declared ports, shaped like listeners so the flat port view can
 * show them in one table. What distinguishes them:
 *
 *   listening: false          nothing is on this port right now
 *   reachability: 'CONTAINER' bound inside the container's namespace only —
 *                             a real listening port that the host cannot
 *                             reach, so it gets a reachability of its own
 *                             rather than being left null and read as
 *                             "unknown".
 *
 * The collector writes bind='container' for a port a container EXPOSEs
 * without publishing (`3000/tcp` rather than `0.0.0.0:3000->3000/tcp`).
 */
function declaredPortRows(service) {
  const ports = Array.isArray(service.ports) ? service.ports : [];
  return ports.map((dp) => {
    const internal = dp.bind === 'container';
    return {
      id: `service-${service.id}-${dp.proto}-${dp.port}-${internal ? 'c' : 'h'}`,
      serverId: service.serverId,
      server: service.server,
      proto: dp.proto,
      port: Number(dp.port),
      containerPort: dp.containerPort ?? null,
      bind: internal ? null : dp.bind || null,
      bindClass: null,
      reachability: internal ? 'CONTAINER' : null,
      // A running container's internal port IS listening — just not
      // anywhere the host can reach.
      listening: internal ? !!service.running : false,
      containerInternal: internal,
      service: null,
      ownerKind: service.kind,
      ownerName: service.name,
      ownerRef: service.ref,
      ownerDetail: service.detail,
      ownerUser: null,
      sourcePath: service.sourcePath,
      serviceState: service.state,
      serviceRunning: !!service.running,
      serviceStatusText: service.statusText,
      findings: [],
    };
  });
}

/**
 * Name the container behind a port.
 *
 * A socket owned by a container is attributed from its cgroup, which gives
 * an id and nothing else (no Docker socket, by design). When the host also
 * runs the container scan, the same container is in HostService with its
 * name and image — keyed by the same 12-character id. Pure: pass the rows
 * and the host's services; returns rows with containerName/containerImage.
 */
export function withContainerNames(rows, services) {
  const byRef = new Map();
  for (const svc of services || []) {
    if ((svc.kind === 'docker' || svc.kind === 'podman') && svc.ref) {
      byRef.set(`${svc.serverId}:${String(svc.ref).slice(0, 12)}`, svc);
    }
  }
  if (byRef.size === 0) return rows;
  return rows.map((r) => {
    if (r.ownerKind !== 'container') return r;
    const id = String(r.ownerRef || r.ownerName || '').replace(/^(docker|podman):/, '').slice(0, 12);
    const svc = byRef.get(`${r.serverId}:${id}`);
    return svc ? { ...r, containerName: svc.name, containerImage: svc.detail || null } : r;
  });
}

async function attachContainerNames(orgId, rows) {
  const serverIds = [...new Set(rows.filter((r) => r.ownerKind === 'container').map((r) => r.serverId))];
  if (serverIds.length === 0) return rows;
  const services = await prisma.hostService.findMany({
    where: { orgId, serverId: { in: serverIds }, kind: { in: ['docker', 'podman'] } },
    select: { serverId: true, kind: true, ref: true, name: true, detail: true },
  });
  return withContainerNames(rows, services);
}

/**
 * Where a row stands, as ONE value — the State column's reading of it and
 * the `status` filter / group level. Unlike the older `state` filter (whose
 * `internal` and `stopped` overlap on a stopped container's internal port),
 * these three never overlap, so a group of them opens to exactly its count.
 */
export function listenerStatus(row) {
  if (row.listening === false) return 'stopped';
  return row.containerInternal ? 'internal' : 'exposed';
}

const isTrue = (v) => v === true || v === 'true';
const isFalse = (v) => v === false || v === 'false';

/**
 * Every row the listeners view shows for these filters — the whole filtered
 * set, before sorting and paging. The list, its export and its group tree
 * all read this, so a group's count, the rows it opens to and the rows a
 * file carries can never disagree.
 *
 * @returns {Promise<{ rows: object[], truncated: boolean, findingsAttached: boolean }>}
 */
async function collectListenerRows(orgId, query, scope, { withFindings = false } = {}) {
  const where = buildWhere(orgId, scope, query);
  const reach = query.reachability;

  // Free text spans a computed label and several columns, so it is applied
  // after the indexed predicates rather than as a pile of ORed `contains`.
  const [listenerRows, services] = await Promise.all([
    prisma.hostListener.findMany({
      where,
      include: { server: { select: SERVER_SELECT } },
      orderBy: [{ port: 'asc' }, { proto: 'asc' }],
      take: MAX_ROWS,
    }),
    // A reachability filter for a HOST reachability is asking only about
    // host sockets; CONTAINER and "none" are the values that live on
    // declarations. A recognised-service filter likewise: a declaration
    // never carries one.
    (reach && reach !== 'CONTAINER' && !isNone(reach)) || (query.service && !isNone(query.service))
      ? Promise.resolve([])
      : loadHostServices(orgId, scope, query),
  ]);

  // Host sockets first, then declarations. A listener wins its (server,
  // proto, port) against a HOST-published declaration — the socket is the
  // better evidence for the same port. A container-internal declaration is
  // a different namespace entirely, so it never collides and is never
  // dropped: 3000/tcp inside a container and 3000/tcp on the host are two
  // facts, not one.
  //
  // Whether a socket shadows a declaration cannot depend on filters that
  // only narrow sockets (type, reachability, recognised service): a
  // docker-proxy socket on 8000 still shadows the docker declaration of
  // 8000 when the list is narrowed to ownerKind=docker — otherwise opening
  // a "docker" group would show a declared row that no group counted.
  const narrowsSockets = !!(query.ownerKind || query.ownerKinds || reach || query.service);
  const shadowRows =
    services.length && narrowsSockets
      ? await prisma.hostListener.findMany({
          where: buildWhere(orgId, scope, {
            ...query,
            ownerKind: undefined,
            ownerKinds: undefined,
            reachability: undefined,
            service: undefined,
          }),
          select: { serverId: true, proto: true, port: true },
          take: MAX_ROWS,
        })
      : listenerRows;
  const listeningKeys = new Set(shadowRows.map((r) => `${r.serverId}:${r.proto}:${r.port}`));
  const declared = services
    .flatMap(declaredPortRows)
    .filter((r) => r.containerInternal || !listeningKeys.has(`${r.serverId}:${r.proto}:${r.port}`));

  const all = [...listenerRows.map((r) => ({ ...r, listening: true })), ...declared].sort(
    (a, b) => a.port - b.port || String(a.proto).localeCompare(String(b.proto))
  );

  let rows = query.q ? all.filter((r) => matchesQuery(r, query.q)) : all;
  // Reachability and recognised service are empty on declarations, so they
  // are matched here, on the merged rows, where NONE means "empty".
  if (reach) rows = rows.filter((r) => (isNone(reach) ? !r.reachability : r.reachability === reach));
  if (query.service) {
    rows = rows.filter((r) => (isNone(query.service) ? !r.service : r.service === query.service));
  }
  if (query.state === 'stopped') rows = rows.filter((r) => !r.listening);
  else if (query.state === 'running') rows = rows.filter((r) => r.listening);
  else if (query.state === 'internal') rows = rows.filter((r) => r.containerInternal);
  else if (query.state === 'exposed') rows = rows.filter((r) => r.listening && !r.containerInternal);
  if (query.status) rows = rows.filter((r) => listenerStatus(r) === query.status);
  if (query.serviceKey) rows = rows.filter((r) => serviceKey(r).key === query.serviceKey);

  const truncated = listenerRows.length >= MAX_ROWS;
  const wantsFindingsFilter = isTrue(query.hasFindings) || isFalse(query.hasFindings) || !!query.findingSeverity;
  if (!wantsFindingsFilter && !withFindings) return { rows, truncated, findingsAttached: false };

  rows = await attachFindings(orgId, rows);
  rows = rows.filter((r) => {
    if (isTrue(query.hasFindings) && r.findings.length === 0) return false;
    if (isFalse(query.hasFindings) && r.findings.length > 0) return false;
    if (query.findingSeverity && !r.findings.some((f) => f.severity === query.findingSeverity)) return false;
    return true;
  });
  return { rows, truncated, findingsAttached: true };
}

// ---------------------------------------------------------------------------
// Sorting — a whitelist, never a caller-supplied field name
// ---------------------------------------------------------------------------

const ENV_ORDER = ['prod', 'staging', 'dev', 'demo'];
const REACH_ORDER = ['INTERNET', 'LAN', 'FIREWALLED', 'LOOPBACK', 'CONTAINER', 'UNKNOWN'];
const STATUS_ORDER = ['exposed', 'internal', 'stopped'];

const lower = (v) => (v === null || v === undefined ? '' : String(v).toLowerCase());
const rankIn = (order) => (v) => {
  const i = order.indexOf(v);
  return i === -1 ? order.length : i;
};

/**
 * The name the Service column shows (frontend lib/serviceIdentity
 * describeListener), close enough to sort by: the container's own name when
 * the container scan knows it, the unit without its suffix, else what the
 * socket calls itself.
 */
export function listenerDisplayName(r) {
  const clean = (v) => (v && v !== '-' ? String(v) : '');
  switch (r.ownerKind) {
    case 'systemd':
    case 'systemd-user':
      return clean(r.ownerName).replace(/\.(service|scope|socket)$/, '') || clean(r.service);
    case 'container':
    case 'docker-proxy':
      return clean(r.containerName) || clean(r.service) || clean(r.ownerName);
    case 'docker':
    case 'podman':
    case 'pm2':
      return clean(r.containerName) || clean(r.ownerName) || clean(r.service);
    case 'process':
      return clean(r.ownerName) || clean(r.process) || clean(r.service);
    default:
      return clean(r.service) || clean(r.process) || (r.ownerName !== 'unknown' ? clean(r.ownerName) : '');
  }
}

/**
 * sortBy → how to read the value it sorts on. Everything here is computed on
 * the merged rows (host sockets + declared ports are one list built in
 * memory, so there is no single table to ORDER BY). Keys match the page's
 * column keys.
 */
export const LISTENER_SORTS = {
  service: (r) => lower(listenerDisplayName(r)),
  type: (r) => lower(r.ownerKind),
  port: (r) => r.port,
  proto: (r) => lower(r.proto),
  bind: (r) => lower(r.bind),
  state: (r) => rankIn(STATUS_ORDER)(listenerStatus(r)),
  server: (r) => lower(r.server?.displayName || r.server?.hostname),
  customer: (r) => lower(r.server?.customer?.name),
  environment: (r) => rankIn(ENV_ORDER)(r.server?.environment),
  reachability: (r) => rankIn(REACH_ORDER)(r.reachability),
  findings: (r) => (r.findings || []).length,
};

/** `sortBy`/`sortDir` → `{ key, dir }`, or null (the default order) for anything not whitelisted. */
export function parseListenerSort(sortBy, sortDir) {
  if (!sortBy || !Object.prototype.hasOwnProperty.call(LISTENER_SORTS, sortBy)) return null;
  return { key: sortBy, dir: String(sortDir).toLowerCase() === 'desc' ? 'desc' : 'asc' };
}

const compareValues = (a, b) =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));

/**
 * Sort rows by a parsed sort. Ties fall back to port, protocol, then id, so
 * a page boundary never lands in a different place between two requests.
 */
export function sortListenerRows(rows, sort) {
  if (!sort) return rows;
  const read = LISTENER_SORTS[sort.key];
  const sign = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort(
    (a, b) =>
      sign * compareValues(read(a), read(b)) ||
      a.port - b.port ||
      String(a.proto).localeCompare(String(b.proto)) ||
      String(a.id).localeCompare(String(b.id))
  );
}

/**
 * GET /api/posture/inventory/listeners — the flat port list across the fleet.
 *
 * `opts.maxLimit` lifts the page-size cap for internal callers (the export
 * reads the whole filtered set through here); the HTTP route never sets it.
 */
export async function listListeners(orgId, query = {}, scope = UNSCOPED, { maxLimit = 200 } = {}) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), maxLimit);
  const sort = parseListenerSort(query.sortBy, query.sortDir);

  const collected = await collectListenerRows(orgId, query, scope, {
    withFindings: sort?.key === 'findings',
  });
  let { rows } = collected;

  // The Service column shows a container's scanned name, so sorting on it
  // needs the names for every row, not just this page's.
  const named = sort?.key === 'service';
  if (named) rows = await attachContainerNames(orgId, rows);
  rows = sortListenerRows(rows, sort);

  const total = rows.length;
  let pageRows = rows.slice((page - 1) * limit, page * limit);
  if (!named) pageRows = await attachContainerNames(orgId, pageRows);
  if (!collected.findingsAttached) pageRows = await attachFindings(orgId, pageRows);
  return { items: pageRows, meta: { total, page, limit, truncated: collected.truncated } };
}

// ---------------------------------------------------------------------------
// Group by
// ---------------------------------------------------------------------------

/**
 * The levels the listeners view can be grouped by, and the list filter each
 * one hands back when a group is opened:
 *
 *   server → serverId        customer → customerId   environment → environment
 *   type → ownerKind         protocol → service      port → port
 *   proto → proto            reachability → reachability
 *   status → status          findings → hasFindings
 */
export const LISTENER_GROUP_DIMS = [
  'server',
  'customer',
  'environment',
  'type',
  'protocol',
  'port',
  'proto',
  'reachability',
  'status',
  'findings',
];

const STATUS_LABELS = {
  exposed: 'Listening on the host',
  internal: 'Container-internal',
  stopped: 'Installed, stopped',
};

function groupValue(dim, r) {
  switch (dim) {
    case 'server':
      return r.serverId;
    case 'customer':
      return r.server?.customer?.id;
    case 'environment':
      return r.server?.environment;
    case 'type':
      return r.ownerKind;
    case 'protocol':
      return r.service;
    case 'port':
      return r.port;
    case 'proto':
      return r.proto;
    case 'reachability':
      return r.reachability;
    case 'status':
      return listenerStatus(r);
    case 'findings':
      return (r.findings || []).length > 0 ? 'true' : 'false';
    default:
      return null;
  }
}

/**
 * GET /api/posture/inventory/listeners/groups — the group tree over the
 * WHOLE filtered set (same filters, same customer scope as the list; built
 * from the very rows the list pages through), not over one page of it.
 *
 * Not a Prisma `groupBy`: the list is host sockets merged in memory with
 * services' declared ports, then filtered in memory (search, state,
 * findings). A count over HostListener alone would disagree with the rows a
 * group opens to, so the tree folds the same rows the list pages.
 */
export async function listListenerGroups(orgId, query = {}, scope = UNSCOPED) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  const groupBy = parseGroupBy(query.groupBy, LISTENER_GROUP_DIMS);
  if (groupBy.length === 0) return { groupBy, tree: [], total: 0, truncated: false };

  const { rows, truncated } = await collectListenerRows(orgId, query, scope, {
    withFindings: groupBy.includes('findings'),
  });

  // Labels come off the rows themselves: every server and customer named
  // here was loaded through the scoped query, so nothing out of scope can
  // be named.
  const serverLabels = new Map();
  const customerLabels = new Map();
  for (const r of rows) {
    if (r.server) serverLabels.set(r.server.id, r.server.displayName || r.server.hostname);
    if (r.server?.customer) customerLabels.set(r.server.customer.id, r.server.customer.name);
  }
  const ports = [...new Set(rows.map((r) => r.port))].sort((a, b) => a - b).map(String);
  const orNone = (fallback) => (v) => (v === NONE ? fallback : v);

  const DIMS = {
    server: { key: 'server', label: (v) => (v === NONE ? 'No server' : serverLabels.get(v) || v) },
    customer: { key: 'customer', label: (v) => (v === NONE ? 'No customer' : customerLabels.get(v) || v) },
    environment: { key: 'environment', order: ENV_ORDER, label: orNone('No environment') },
    type: { key: 'type', label: orNone('Unknown') },
    protocol: { key: 'protocol', label: orNone('Not recognised') },
    port: { key: 'port', order: ports, label: orNone('No port') },
    proto: { key: 'proto', label: (v) => (v === NONE ? 'No protocol' : v.toUpperCase()) },
    reachability: { key: 'reachability', order: REACH_ORDER, label: orNone('Not listening') },
    status: { key: 'status', order: STATUS_ORDER, label: (v) => STATUS_LABELS[v] || v },
    findings: {
      key: 'findings',
      order: ['true', 'false'],
      label: (v) => (v === 'true' ? 'Has open findings' : 'No open findings'),
    },
  };

  const tree = buildGroupTree(
    rows.map((r) => ({ values: Object.fromEntries(groupBy.map((d) => [d, groupValue(d, r)])) })),
    groupBy.map((d) => DIMS[d])
  );
  return { groupBy, tree, total: rows.length, truncated };
}

/**
 * GET /api/posture/inventory/services — one row per distinct service, with
 * where it runs.
 *
 * This is the "where is nginx deployed" view: the thing a flat port list
 * makes you assemble by eye across pages.
 */
export async function listServices(orgId, query = {}, scope = UNSCOPED) {
  if (!orgId) throw new ApiError(400, 'orgId is required');

  const where = buildWhere(orgId, scope, query);
  const [listenerRows, services] = await Promise.all([
    prisma.hostListener.findMany({
      where,
      include: { server: { select: SERVER_SELECT } },
      take: MAX_ROWS,
    }),
    query.reachability && query.reachability !== 'CONTAINER'
      ? Promise.resolve([])
      : loadHostServices(orgId, scope, query),
  ]);
  const rows = await attachFindings(orgId, listenerRows.map((r) => ({ ...r, listening: true })));

  const groups = new Map();
  const ensureGroup = (key, name, kind) => {
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name,
        kind,
        servers: new Map(),
        ports: new Set(),
        protos: new Set(),
        environments: new Set(),
        customers: new Map(),
        reachability: new Set(),
        instances: 0,
        internetExposed: 0,
        openFindings: 0,
        criticalOrHigh: 0,
        severityCounts: {},
        // A service that runs on one host and is stopped on another is ONE
        // row with both counts, not two rows that look like two services.
        runningOn: new Set(),
        stoppedOn: new Set(),
      });
    }
    return groups.get(key);
  };

  for (const row of rows) {
    const { key, name, kind } = serviceKey(row);
    const g = ensureGroup(key, name, kind);
    g.runningOn.add(row.serverId);
    g.instances += 1;
    g.ports.add(row.port);
    g.protos.add(row.proto);
    g.reachability.add(row.reachability);
    if (row.reachability === 'INTERNET') g.internetExposed += 1;
    g.openFindings += row.findings.length;
    g.criticalOrHigh += row.findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').length;
    for (const f of row.findings) g.severityCounts[f.severity] = (g.severityCounts[f.severity] || 0) + 1;
    if (row.server) {
      g.servers.set(row.server.id, {
        id: row.server.id,
        hostname: row.server.hostname,
        displayName: row.server.displayName,
        environment: row.server.environment,
      });
      if (row.server.environment) g.environments.add(row.server.environment);
      if (row.server.customer) g.customers.set(row.server.customer.id, row.server.customer);
    }
  }

  // Every service joins a group, running or not. Their ports are DECLARED
  // rather than observed on the host, so they add to the service's
  // footprint without inflating its exposure counts — neither a stopped
  // container nor a container-internal port is internet-facing.
  for (const svc of services) {
    const { key, name, kind } = serviceKey({ ownerKind: svc.kind, ownerName: svc.name, ownerRef: svc.ref });
    const g = ensureGroup(key, name, kind);
    if (svc.running) g.runningOn.add(svc.serverId);
    else g.stoppedOn.add(svc.serverId);
    for (const dp of Array.isArray(svc.ports) ? svc.ports : []) {
      g.ports.add(Number(dp.port));
      if (dp.proto) g.protos.add(dp.proto);
    }
    if (svc.server) {
      g.servers.set(svc.server.id, {
        id: svc.server.id,
        hostname: svc.server.hostname,
        displayName: svc.server.displayName,
        environment: svc.server.environment,
        state: svc.state,
      });
      if (svc.server.environment) g.environments.add(svc.server.environment);
      if (svc.server.customer) g.customers.set(svc.server.customer.id, svc.server.customer);
    }
  }

  let items = [...groups.values()].map((g) => ({
    key: g.key,
    name: g.name,
    kind: g.kind,
    instances: g.instances,
    serverCount: g.servers.size,
    servers: [...g.servers.values()],
    ports: [...g.ports].sort((a, b) => a - b),
    protos: [...g.protos].sort(),
    environments: [...g.environments].sort(),
    customers: [...g.customers.values()],
    reachability: [...g.reachability].sort(),
    internetExposed: g.internetExposed,
    openFindings: g.openFindings,
    criticalOrHigh: g.criticalOrHigh,
    severityCounts: g.severityCounts,
    runningOn: g.runningOn.size,
    stoppedOn: g.stoppedOn.size,
  }));

  if (query.state === 'stopped') items = items.filter((i) => i.stoppedOn > 0);
  else if (query.state === 'running') items = items.filter((i) => i.runningOn > 0);
  if (query.hasFindings === true || query.hasFindings === 'true') {
    items = items.filter((i) => i.openFindings > 0);
  }
  if (query.findingSeverity) {
    items = items.filter((i) => (i.severityCounts[query.findingSeverity] || 0) > 0);
  }

  if (query.q) {
    const needle = String(query.q).toLowerCase();
    items = items.filter(
      (i) =>
        i.name.toLowerCase().includes(needle) ||
        i.kind.toLowerCase().includes(needle) ||
        i.ports.some((p) => String(p).includes(needle)) ||
        i.servers.some((s) => `${s.hostname} ${s.displayName || ''}`.toLowerCase().includes(needle))
    );
  }

  // Most-deployed first: the services worth knowing about are the ones on
  // many hosts, and within that the ones that are exposed.
  items.sort(
    (a, b) =>
      b.serverCount - a.serverCount ||
      b.internetExposed - a.internetExposed ||
      a.name.localeCompare(b.name)
  );

  return {
    items,
    meta: {
      total: items.length,
      listeners: rows.length,
      services: services.length,
      stoppedServices: services.filter((s) => !s.running).length,
      servers: new Set([...rows.map((r) => r.serverId), ...services.map((s) => s.serverId)]).size,
      truncated: listenerRows.length >= MAX_ROWS,
    },
  };
}

/**
 * Distinct values for the filter selects, computed from what is in scope.
 *
 * NOTE: the scope predicate must be MERGED onto `where.server`, not
 * overwritten by the `isActive` filter — a literal `server: { isActive:
 * true }` placed after `...relationScopeWhere(scope, 'server')` replaces the
 * whole `server` key, silently dropping the customerId scope for a scoped
 * caller (docs/rbac/customer-scope-spec.md §6.3: an aggregate is still a
 * leak). Every query below builds `where.server` by merging, never spreading
 * a scope object and then re-assigning the same key.
 */
export async function listFacets(orgId, scope = UNSCOPED) {
  if (!orgId) throw new ApiError(400, 'orgId is required');
  const where = { orgId, ...relationScopeWhere(scope, 'server') };
  where.server = { ...(where.server || {}), isActive: true };

  const [protos, kinds, reach, serviceKinds] = await Promise.all([
    prisma.hostListener.groupBy({ by: ['proto'], where, _count: { _all: true } }),
    prisma.hostListener.groupBy({ by: ['ownerKind'], where, _count: { _all: true } }),
    prisma.hostListener.groupBy({ by: ['reachability'], where, _count: { _all: true } }),
    // HostService rows carry stopped / declared-only services a socket scan
    // never sees (a stopped `systemd-user` timer, a bare `process` entry
    // with no live listener) — without this half, their `kind` never shows
    // up as a Type option at all.
    prisma.hostService.groupBy({ by: ['kind'], where, _count: { _all: true } }),
  ]);
  const shape = (rows, field) =>
    rows
      .filter((r) => r[field])
      .map((r) => ({ value: r[field], count: r._count._all }))
      .sort((a, b) => b.count - a.count);

  // One kind can appear in both tables (a running `docker` container has a
  // HostListener; the same host's stopped one only has a HostService) — the
  // facet is the union, counts summed, not two competing rows for "docker".
  const ownerKindCounts = new Map();
  for (const r of shape(kinds, 'ownerKind')) {
    ownerKindCounts.set(r.value, (ownerKindCounts.get(r.value) || 0) + r.count);
  }
  for (const r of shape(serviceKinds, 'kind')) {
    ownerKindCounts.set(r.value, (ownerKindCounts.get(r.value) || 0) + r.count);
  }

  return {
    protos: shape(protos, 'proto'),
    ownerKinds: [...ownerKindCounts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
    reachability: shape(reach, 'reachability'),
  };
}

export default {
  listListeners,
  listListenerGroups,
  listServices,
  listFacets,
  serviceKey,
  matchesQuery,
  parseOwnerKinds,
  parseListenerSort,
  sortListenerRows,
};
