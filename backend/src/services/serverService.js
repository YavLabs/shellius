import net from 'net';
import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { encrypt } from '../utils/crypto.js';
import * as terminalService from './terminalService.js';
import { serverScopeWhere, assertCustomerInScope } from '../lib/scope.js';
import { statusesFor, filterIdsByStatus, SSH_TRUST_STATES, COLLECTOR_STATES, STATUS_SELECT } from './serverAgentStatus.js';
import { NONE, parseGroupBy, buildGroupTree } from '../utils/groupTree.js';
import { endOfDayInclusive } from '../utils/dateRange.js';

// Whitelisted sort keys for listServers — never pass sortBy straight into
// Prisma's orderBy, or a client could sort (and thereby probe existence of
// columns) on anything. "hostname" sorts on the display name first since
// that's what the Name column actually shows, falling back to hostname.
const SERVER_SORTABLE = {
  hostname: (dir) => [{ displayName: dir }, { hostname: dir }],
  displayName: (dir) => [{ displayName: dir }, { hostname: dir }],
  ipAddress: (dir) => [{ ipAddress: dir }],
  environment: (dir) => [{ environment: dir }],
  healthStatus: (dir) => [{ healthStatus: dir }],
  lastHealthCheck: (dir) => [{ lastHealthCheck: dir }],
  customer: (dir) => [{ customer: { name: dir } }],
};

const RDP_SENSITIVE_FIELDS = ['rdpPasswordEncrypted', 'rdpPasswordIv', 'rdpPasswordTag'];

function stripRdpSecrets(server) {
  if (!server) return server;
  const result = { ...server };
  result.hasRdpPassword = !!result.rdpPasswordEncrypted;
  for (const f of RDP_SENSITIVE_FIELDS) delete result[f];
  // Per-host agent token signal for the UI (ServerDetail "deprecated agent
  // auth" notice) — never expose the raw hash itself.
  //   'per-host' — Server.agentTokenHash is set (bootstrapped post per-host-
  //                token change, or re-bootstrapped/--upgrade since).
  //   'legacy'   — no per-host token yet, but the agent has successfully
  //                authenticated before (agentLastSeen set) — the only way
  //                that's possible without a per-host token is the global
  //                AGENT_SHARED_SECRET fallback in middleware/agentAuth.js.
  //   'none'     — never bootstrapped / no agent auth activity observed yet.
  result.agentAuth = result.agentTokenHash ? 'per-host' : (result.agentLastSeen ? 'legacy' : 'none');
  delete result.agentTokenHash;
  return result;
}

const READ_ONLY = [
  'healthStatus',
  'lastHealthCheck',
  'healthMessage',
  'agentId',
  'agentVersion',
  'agentLastSeen',
  'provisionStatus',
  'provisionError',
  'provisionedAt',
  'lastProvisionAt',
];

const MUTABLE_FIELDS = [
  'hostname',
  'displayName',
  'description',
  'ipAddress',
  'dynamicIp',
  'port',
  'protocol',
  'environment',
  'labels',
  'osType',
  'osVersion',
  'cloudProvider',
  'cloudInstanceId',
  'cloudRegion',
  'cloudAccountId',
  'sshUser',
  'sshKeyPath',
  'rdpUsername',
  'isActive',
  'authMode',
  'credentialId',
];

const CUSTOMER_SELECT = { select: { id: true, name: true, slug: true } };
const CREDENTIAL_SELECT = { select: { id: true, name: true, username: true, authType: true } };
// The saved sudo password's identity — name only; its secret never leaves the Keystore.
const SERVER_INCLUDE = {
  customer: CUSTOMER_SELECT,
  credential: CREDENTIAL_SELECT,
  sudoCredential: { select: { id: true, name: true, username: true } },
};

function validateIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return net.isIP(ip) !== 0;
}

/**
 * Validate authMode/credentialId consistency and that credentialId (when
 * present) belongs to this org. Returns a patch to merge into the write
 * payload (credentialId forced to null for authMode='certificate').
 */
async function validateAuthMode(orgId, { authMode, credentialId }) {
  if (authMode === undefined && credentialId === undefined) return {};
  if (authMode === 'credential') {
    if (!credentialId) {
      throw new ApiError(400, 'credentialId is required when authMode is "credential"');
    }
    // Org identities only: a personal vault identity is never bound to a server.
    const credential = await prisma.credential.findFirst({ where: { id: credentialId, orgId, ownerId: null } });
    if (!credential) throw new ApiError(400, 'credentialId not found in organization');
    return { authMode: 'credential', credentialId };
  }
  if (authMode === 'certificate') {
    return { authMode: 'certificate', credentialId: null };
  }
  // authMode not changing, but credentialId was — validate it belongs to org.
  if (credentialId) {
    const credential = await prisma.credential.findFirst({ where: { id: credentialId, orgId, ownerId: null } });
    if (!credential) throw new ApiError(400, 'credentialId not found in organization');
  }
  return credentialId !== undefined ? { credentialId } : {};
}

const LIST_FILTER_KEYS = [
  'customerId',
  'environment',
  'healthStatus',
  'cloudProvider',
  'search',
  'isActive',
  'sshTrust',
  'collector',
  'protocol',
  'osType',
  'healthCheckFrom',
  'healthCheckTo',
];

// A filter no row can match — for NONE on a column that is never empty
// (environment, customer…), so "__none__" narrows to nothing rather than
// reaching Prisma as an invalid enum value.
const MATCH_NOTHING = Object.freeze({ id: { in: [] } });

/**
 * The stored-column half of the server list's `where`: org, customer scope,
 * search and every stored-column filter. NONE (utils/groupTree.js) on a
 * nullable column means "is empty" (null or ''), so a "No OS reported"
 * group opens to exactly the rows it counted.
 *
 * Pure — no DB. `resolveServerWhere` adds the computed-status narrowing.
 */
export function buildServerWhere(orgId, filters = {}, scope) {
  const {
    customerId,
    environment,
    healthStatus,
    cloudProvider,
    search,
    isActive,
    protocol,
    osType,
    healthCheckFrom,
    healthCheckTo,
  } = filters;
  const where = { orgId };
  const and = [];
  // Scope narrows further, as an AND rather than merged onto `customerId`
  // directly — a scoped caller who passes a specific (out-of-scope)
  // customerId must still see nothing, not have the scope filter clobbered
  // by their own query param. serverScopeWhere is a no-op ({}) for unscoped
  // callers, so today's behaviour is unchanged.
  const scopeFilter = serverScopeWhere(scope);
  if (scopeFilter.customerId) and.push(scopeFilter);

  // Columns that are never empty: NONE matches nothing.
  const required = { customerId, environment, healthStatus, protocol };
  for (const [col, value] of Object.entries(required)) {
    if (!value) continue;
    if (value === NONE) and.push(MATCH_NOTHING);
    else where[col] = value;
  }
  // Nullable text columns: NONE is "null or empty".
  const nullable = { cloudProvider, osType };
  for (const [col, value] of Object.entries(nullable)) {
    if (!value) continue;
    if (value === NONE) and.push({ OR: [{ [col]: null }, { [col]: '' }] });
    else where[col] = value;
  }
  if (isActive !== undefined && isActive !== '') {
    if (isActive === NONE) and.push(MATCH_NOTHING);
    else where.isActive = isActive === true || isActive === 'true';
  }
  if (healthCheckFrom || healthCheckTo) {
    where.lastHealthCheck = {};
    if (healthCheckFrom) where.lastHealthCheck.gte = new Date(healthCheckFrom);
    if (healthCheckTo) where.lastHealthCheck.lte = endOfDayInclusive(healthCheckTo);
  }
  if (search) {
    where.OR = [
      { hostname: { contains: search, mode: 'insensitive' } },
      { displayName: { contains: search, mode: 'insensitive' } },
      { ipAddress: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (and.length) where.AND = and;
  return where;
}

/**
 * The full server list `where`, shared by the list and its group tree so a
 * group always opens to the rows it counted: buildServerWhere, then — SSH
 * trust / collector status being computed, not stored — the candidates
 * narrowed to the ids whose status matches.
 */
export async function resolveServerWhere(orgId, filters = {}, scope) {
  const where = buildServerWhere(orgId, filters, scope);
  // No status is ever empty: NONE on either matches nothing.
  if (filters.sshTrust === NONE || filters.collector === NONE) {
    where.AND = [...(where.AND || []), MATCH_NOTHING];
    return where;
  }
  const wantTrust = SSH_TRUST_STATES.includes(filters.sshTrust) ? filters.sshTrust : null;
  const wantCollector = COLLECTOR_STATES.includes(filters.collector) ? filters.collector : null;
  if (wantTrust || wantCollector) {
    const ids = await filterIdsByStatus(orgId, where, { sshTrust: wantTrust, collector: wantCollector });
    where.id = { in: ids };
  }
  return where;
}

/** Only the list's filter params from a query (never page / sort / groupBy). */
export function pickServerFilters(query = {}) {
  const out = {};
  for (const k of LIST_FILTER_KEYS) if (query[k] !== undefined) out[k] = query[k];
  return out;
}

export async function listServers(orgId, query = {}, scope) {
  const { sortBy, sortDir } = query;
  const page = parseInt(query.page, 10) || 1;
  const pageSize = Math.min(parseInt(query.pageSize, 10) || 25, 100);

  const where = await resolveServerWhere(orgId, pickServerFilters(query), scope);

  const dir = sortDir === 'desc' ? 'desc' : 'asc';
  const orderBy = SERVER_SORTABLE[sortBy] ? SERVER_SORTABLE[sortBy](dir) : { createdAt: 'desc' };

  const [items, total] = await Promise.all([
    prisma.server.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy,
      include: SERVER_INCLUDE,
    }),
    prisma.server.count({ where }),
  ]);

  // Both statuses for the page, in two snapshot queries.
  const statuses = await statusesFor(orgId, items);
  return {
    items: items.map((it) => ({ ...stripRdpSecrets(it), ...(statuses.get(it.id) || {}) })),
    total,
    page,
    pageSize,
  };
}

// ---------------------------------------------------------------------------
// Group by — GET /api/servers/groups
// ---------------------------------------------------------------------------

const ENV_LABELS = { prod: 'Production', staging: 'Staging', dev: 'Dev', demo: 'Demo' };
const HEALTH_LABELS = { healthy: 'Healthy', unhealthy: 'Unhealthy', unknown: 'Unknown', maintenance: 'Maintenance' };
const PROTOCOL_LABELS = { ssh: 'SSH', rdp: 'RDP', both: 'SSH + RDP' };
const CLOUD_LABELS = { aws: 'AWS', azure: 'Azure', gcp: 'GCP' };
const titleCase = (v) => String(v).charAt(0).toUpperCase() + String(v).slice(1);

/**
 * The levels the Servers list can be grouped by. `column` is a stored
 * column (counted with a Prisma groupBy), `computed` a status derived per
 * server; `param` is the list filter a group's value goes back through.
 */
export const SERVER_GROUP_DIMS = {
  customer: { column: 'customerId', param: 'customerId' },
  environment: {
    column: 'environment',
    param: 'environment',
    order: ['prod', 'staging', 'dev', 'demo'],
    label: (v) => ENV_LABELS[v] || v,
  },
  health: {
    column: 'healthStatus',
    param: 'healthStatus',
    order: ['unhealthy', 'maintenance', 'unknown', 'healthy'],
    label: (v) => HEALTH_LABELS[v] || v,
  },
  sshTrust: { computed: 'sshTrust', param: 'sshTrust', order: SSH_TRUST_STATES },
  collector: { computed: 'collector', param: 'collector', order: COLLECTOR_STATES },
  protocol: {
    column: 'protocol',
    param: 'protocol',
    order: ['ssh', 'rdp', 'both'],
    label: (v) => PROTOCOL_LABELS[v] || v,
  },
  osType: {
    column: 'osType',
    param: 'osType',
    label: (v) => (v === NONE ? 'No OS reported' : titleCase(v)),
  },
  cloudProvider: {
    column: 'cloudProvider',
    param: 'cloudProvider',
    label: (v) => (v === NONE ? 'Not cloud-discovered' : CLOUD_LABELS[String(v).toLowerCase()] || v),
  },
  active: {
    column: 'isActive',
    param: 'isActive',
    order: ['true', 'false'],
    label: (v) => (v === 'true' ? 'Active' : v === 'false' ? 'Inactive' : 'None'),
  },
};

/**
 * The group tree for the Servers list over the whole filtered set — the
 * same `where` as the list (org + customer scope included), so every group
 * opens, through the list endpoint, to exactly the rows it counted.
 *
 * @returns {Promise<{ groupBy: string[], tree: Array }>}
 */
export async function listServerGroups(orgId, query = {}, scope) {
  const groupBy = parseGroupBy(query.groupBy, Object.keys(SERVER_GROUP_DIMS));
  if (!groupBy.length) return { groupBy, tree: [] };

  const where = await resolveServerWhere(orgId, pickServerFilters(query), scope);
  const dims = groupBy.map((key) => ({ key, ...SERVER_GROUP_DIMS[key] }));
  const columns = [...new Set(dims.filter((d) => d.column).map((d) => d.column))];

  let rows;
  const computedLabels = new Map();
  if (dims.some((d) => d.computed)) {
    // A status is derived per server, so count per server: a narrow select
    // of the grouped columns plus what the statuses need.
    const select = { ...STATUS_SELECT };
    for (const c of columns) select[c] = true;
    const servers = await prisma.server.findMany({ where, select });
    const statuses = await statusesFor(orgId, servers);
    rows = servers.map((s) => {
      const values = {};
      for (const d of dims) {
        if (d.column) {
          values[d.key] = s[d.column];
        } else {
          const st = statuses.get(s.id)?.[d.computed];
          values[d.key] = st?.state ?? null;
          if (st?.state) computedLabels.set(`${d.key}:${st.state}`, st.label);
        }
      }
      return { values };
    });
  } else {
    const counted = await prisma.server.groupBy({ by: columns, where, _count: { _all: true } });
    rows = counted.map((r) => {
      const values = {};
      for (const d of dims) values[d.key] = r[d.column];
      return { values, count: r._count?._all ?? 0 };
    });
  }

  // Customer names for the labels — this org's customers only.
  let customerNames = new Map();
  if (groupBy.includes('customer')) {
    const ids = [...new Set(rows.map((r) => r.values.customer).filter(Boolean))];
    if (ids.length) {
      const customers = await prisma.customer.findMany({
        where: { orgId, id: { in: ids } },
        select: { id: true, name: true },
      });
      customerNames = new Map(customers.map((c) => [c.id, c.name]));
    }
  }

  const labelFor = (d) => {
    if (d.key === 'customer') return (v) => (v === NONE ? 'No customer' : customerNames.get(v) || 'Unknown customer');
    if (d.computed) return (v) => (v === NONE ? 'None' : computedLabels.get(`${d.key}:${v}`) || v);
    return (v) => (d.label ? d.label(v) : v === NONE ? 'None' : v);
  };
  const treeDims = dims.map((d) => ({ key: d.key, order: d.order, label: labelFor(d) }));

  return { groupBy, tree: buildGroupTree(rows, treeDims) };
}

/**
 * Distinct OS types present in the org's (scoped) inventory, for the
 * Servers "OS" filter — a static list would offer options nothing matches
 * and hide ones that do.
 */
export async function listOsTypes(orgId, scope) {
  const where = { orgId, osType: { not: null } };
  const scopeFilter = serverScopeWhere(scope);
  if (scopeFilter.customerId) where.AND = [scopeFilter];
  const rows = await prisma.server.findMany({
    where,
    distinct: ['osType'],
    select: { osType: true },
    orderBy: { osType: 'asc' },
  });
  return rows.map((r) => r.osType).filter(Boolean);
}

export async function getServer(orgId, serverId, scope) {
  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId, ...serverScopeWhere(scope) },
    include: SERVER_INCLUDE,
  });
  if (!server) throw new ApiError(404, 'Server not found');
  const statuses = await statusesFor(orgId, [server]);
  return { ...stripRdpSecrets(server), ...(statuses.get(server.id) || {}) };
}

export async function createServer(orgId, customerId, data = {}, scope) {
  if (!customerId) throw new ApiError(400, 'customerId is required');
  // Creating under an out-of-scope customer must fail exactly like the
  // customer doesn't exist — same 404 a scoped read would give.
  assertCustomerInScope(scope, customerId);
  const customer = await prisma.customer.findFirst({ where: { id: customerId, orgId } });
  if (!customer) throw new ApiError(400, 'Customer not found in organization');

  if (!data.hostname) throw new ApiError(400, 'hostname is required');
  // dynamicIp servers resolve their address at connect time, so an ipAddress is
  // optional at create. If one is supplied it must still be valid. Static
  // servers require a valid IP.
  const isDynamic = data.dynamicIp === true;
  const ip = (data.ipAddress ?? '').trim();
  if (isDynamic) {
    if (ip && !validateIp(ip)) throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');
  } else if (!validateIp(ip)) {
    throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');
  }

  const payload = {
    orgId,
    customerId,
    hostname: data.hostname,
    ipAddress: ip,
    healthStatus: 'unknown',
  };
  for (const f of MUTABLE_FIELDS) {
    if (data[f] !== undefined && payload[f] === undefined) {
      payload[f] = data[f];
    }
  }
  if (data.rdpPassword) {
    payload.rdpPasswordEncrypted = encrypt(data.rdpPassword);
  }

  const authPatch = await validateAuthMode(orgId, { authMode: data.authMode, credentialId: data.credentialId });
  Object.assign(payload, authPatch);

  const server = await prisma.server.create({
    data: payload,
    include: SERVER_INCLUDE,
  });
  return stripRdpSecrets(server);
}

export async function updateServer(orgId, serverId, data = {}, scope) {
  const existing = await prisma.server.findFirst({ where: { id: serverId, orgId, ...serverScopeWhere(scope) } });
  if (!existing) throw new ApiError(404, 'Server not found');

  const updateData = {};
  for (const key of Object.keys(data)) {
    if (READ_ONLY.includes(key)) continue;
    if (!MUTABLE_FIELDS.includes(key)) continue;
    updateData[key] = data[key];
  }

  if (updateData.ipAddress !== undefined) {
    // Determine the effective dynamicIp state after this update.
    const willBeDynamic =
      data.dynamicIp !== undefined ? data.dynamicIp === true : existing.dynamicIp === true;
    const ip = (updateData.ipAddress ?? '').trim();
    if (willBeDynamic) {
      if (ip && !validateIp(ip)) {
        throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');
      }
    } else if (!validateIp(ip)) {
      throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');
    }
    updateData.ipAddress = ip;
  }
  if (data.rdpPassword) {
    updateData.rdpPasswordEncrypted = encrypt(data.rdpPassword);
  }

  if (updateData.authMode !== undefined || updateData.credentialId !== undefined) {
    const authPatch = await validateAuthMode(orgId, {
      authMode: updateData.authMode,
      credentialId: updateData.credentialId,
    });
    Object.assign(updateData, authPatch);
  }

  const server = await prisma.server.update({
    where: { id: serverId },
    data: updateData,
    include: SERVER_INCLUDE,
  });
  return stripRdpSecrets(server);
}

/**
 * Clear a server's pinned SSH host key (TOFU reset). Admin-only at the route
 * level; audited. The next ssh2 connect will re-pin on first contact.
 */
export async function resetHostKey(orgId, serverId, scope) {
  const existing = await prisma.server.findFirst({ where: { id: serverId, orgId, ...serverScopeWhere(scope) } });
  if (!existing) throw new ApiError(404, 'Server not found');
  const server = await prisma.server.update({
    where: { id: serverId },
    data: { hostKeyFingerprint: null, hostKeyAlgorithm: null, hostKeyPinnedAt: null },
    include: SERVER_INCLUDE,
  });
  return stripRdpSecrets(server);
}

/** Dependents removed when this server is deleted (for the confirm dialog). */
export async function getDeleteImpact(orgId, serverId, scope) {
  const server = await prisma.server.findFirst({ where: { id: serverId, orgId, ...serverScopeWhere(scope) } });
  if (!server) throw new ApiError(404, 'Server not found');
  const [activeSessions, totalSessions, pendingRequests, certificates] = await Promise.all([
    prisma.session.count({ where: { orgId, serverId, status: 'ACTIVE' } }),
    prisma.session.count({ where: { orgId, serverId } }),
    prisma.accessRequest.count({ where: { orgId, serverId, status: { in: ['PENDING', 'APPROVED'] } } }),
    prisma.certificate.count({ where: { orgId, issuedForId: serverId } }),
  ]);
  return {
    server: { id: server.id, hostname: server.hostname, displayName: server.displayName },
    isCloud: !!server.cloudProvider,
    cloudProvider: server.cloudProvider || null,
    activeSessions,
    totalSessions,
    pendingRequests,
    certificates,
  };
}

/**
 * Hard-delete a server. Force-terminates any live session first (so the cascade
 * removes already-terminated rows), then deletes — which cascades AccessRequest
 * + Session rows and SetNulls issued certificates.
 */
export async function deleteServer(orgId, serverId, callerId = null, scope) {
  const existing = await prisma.server.findFirst({ where: { id: serverId, orgId, ...serverScopeWhere(scope) } });
  if (!existing) throw new ApiError(404, 'Server not found');
  await terminalService.terminateActiveSessionsFor(orgId, { serverId }, callerId);
  await prisma.server.delete({ where: { id: serverId } });
  return { success: true };
}

export async function bulkUpdateEnvironment(orgId, serverIds, environment, scope) {
  return bulkUpdate(orgId, serverIds, { environment }, scope);
}

// Fields that can be changed in bulk. customerId is validated below.
const BULK_FIELDS = ['environment', 'protocol', 'osType', 'osVersion', 'sshUser', 'isActive', 'customerId'];

export async function bulkUpdate(orgId, serverIds, patch = {}, scope) {
  if (!Array.isArray(serverIds) || serverIds.length === 0) {
    throw new ApiError(400, 'serverIds must be a non-empty array');
  }
  const data = {};
  for (const f of BULK_FIELDS) {
    if (patch[f] !== undefined) data[f] = patch[f];
  }
  if (Object.keys(data).length === 0) {
    throw new ApiError(400, 'No updatable fields provided');
  }
  // If reassigning the customer, ensure it belongs to this org AND, for a
  // scoped caller, that the destination is a customer they can see — scope
  // must guard both where servers land and where they start.
  if (data.customerId) {
    assertCustomerInScope(scope, data.customerId);
    const customer = await prisma.customer.findFirst({ where: { id: data.customerId, orgId } });
    if (!customer) throw new ApiError(400, 'Customer not found in organization');
  }
  // Scope the `where` too, not just validate the target: out-of-scope ids in
  // `serverIds` must be silently skipped (updateMany just won't match them),
  // so `updated` only ever counts rows the caller could actually see.
  const result = await prisma.server.updateMany({
    where: { id: { in: serverIds }, orgId, ...serverScopeWhere(scope) },
    data,
  });
  return { updated: result.count };
}

/**
 * Update just the connection IP of a server whose IP is marked non-static.
 * Available to anyone who can connect (members included) so a changed cloud IP
 * doesn't block access; only allowed when the server is flagged dynamicIp.
 */
export async function updateConnectionIp(orgId, serverId, ipAddress, scope) {
  const server = await prisma.server.findFirst({ where: { id: serverId, orgId, ...serverScopeWhere(scope) } });
  if (!server) throw new ApiError(404, 'Server not found');
  if (!server.dynamicIp) {
    throw new ApiError(400, 'This server does not have a changeable IP');
  }
  if (!validateIp(ipAddress)) {
    throw new ApiError(400, 'ipAddress must be a valid IPv4 or IPv6 address');
  }
  const updated = await prisma.server.update({
    where: { id: serverId },
    data: { ipAddress },
    include: SERVER_INCLUDE,
  });
  return stripRdpSecrets(updated);
}

export async function getServersByLabel(orgId, labels, scope) {
  const labelArray = Array.isArray(labels) ? labels : [labels];
  try {
    return await prisma.server.findMany({
      where: { orgId, labels: { array_contains: labelArray }, ...serverScopeWhere(scope) },
      include: SERVER_INCLUDE,
    });
  } catch {
    const all = await prisma.server.findMany({
      where: { orgId, ...serverScopeWhere(scope) },
      include: SERVER_INCLUDE,
    });
    return all.filter((s) => {
      const arr = Array.isArray(s.labels) ? s.labels : [];
      return labelArray.every((l) => arr.includes(l));
    });
  }
}
