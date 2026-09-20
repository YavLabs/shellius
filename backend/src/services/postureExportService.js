/**
 * postureExportService.js
 *
 * Exports exposure findings and host listeners as CSV, JSON or PDF, for one
 * server or across the fleet.
 *
 * Why this is server-side rather than a client-side CSV of the loaded rows:
 *
 *  - The findings inbox is server-paginated, so a browser export would ship
 *    the page you happen to be looking at, not the filter you asked for.
 *  - Customer scope has to be enforced on the rows that leave the system.
 *    An export is the highest-leverage place for a scope bug to matter.
 *  - It is auditable. This is security data leaving the product; who
 *    exported what, and when, belongs in the audit log.
 *
 * Field selection is honoured (the caller picks columns) but never widens:
 * unknown field names are dropped rather than becoming empty columns, so a
 * stale client cannot smuggle a column into the output.
 */

import AdmZip from 'adm-zip';
import PDFDocument from 'pdfkit';

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { serverScopeWhere, relationScopeWhere } from '../lib/scope.js';

export const FORMATS = ['csv', 'json', 'pdf'];
export const BUNDLES = ['single', 'zip'];

// ---------------------------------------------------------------------------
// Field catalogues — the single source of truth for what can be exported.
// Order here is the default column order.
// ---------------------------------------------------------------------------

export const FINDING_FIELDS = [
  { key: 'severity', label: 'Severity', get: (f) => f.severity },
  { key: 'status', label: 'Status', get: (f) => findingStatus(f) },
  { key: 'code', label: 'Code', get: (f) => f.code },
  { key: 'message', label: 'Message', get: (f) => f.message },
  { key: 'proto', label: 'Protocol', get: (f) => f.proto ?? '' },
  { key: 'port', label: 'Port', get: (f) => f.port ?? '' },
  { key: 'service', label: 'Service', get: (f) => f.service ?? '' },
  { key: 'ownerLabel', label: 'Owner', get: (f) => f.ownerLabel ?? '' },
  { key: 'server', label: 'Server', get: (f) => f.server?.displayName || f.server?.hostname || '' },
  { key: 'serverHostname', label: 'Hostname', get: (f) => f.server?.hostname ?? '' },
  { key: 'serverIp', label: 'IP address', get: (f) => f.server?.ipAddress ?? '' },
  { key: 'environment', label: 'Environment', get: (f) => f.server?.environment ?? '' },
  { key: 'customer', label: 'Customer', get: (f) => f.server?.customer?.name ?? '' },
  { key: 'firstSeenAt', label: 'First seen', get: (f) => iso(f.firstSeenAt) },
  { key: 'lastSeenAt', label: 'Last seen', get: (f) => iso(f.lastSeenAt) },
  { key: 'resolvedAt', label: 'Resolved', get: (f) => iso(f.resolvedAt) },
  { key: 'acknowledgedAt', label: 'Acknowledged', get: (f) => iso(f.acknowledgedAt) },
  { key: 'mutedUntil', label: 'Muted until', get: (f) => iso(f.mutedUntil) },
  { key: 'mutedReason', label: 'Mute reason', get: (f) => f.mutedReason ?? '' },
  { key: 'detail', label: 'Detail', get: (f) => (f.detail ? JSON.stringify(f.detail) : '') },
  { key: 'id', label: 'Finding ID', get: (f) => f.id },
];

export const LISTENER_FIELDS = [
  { key: 'proto', label: 'Protocol', get: (l) => l.proto },
  { key: 'port', label: 'Port', get: (l) => l.port },
  { key: 'bind', label: 'Bind address', get: (l) => l.bind },
  { key: 'containerPort', label: 'Container port', get: (l) => l.containerPort ?? '' },
  { key: 'reachability', label: 'Reachability', get: (l) => l.reachability },
  { key: 'bindClass', label: 'Bind class', get: (l) => l.bindClass },
  { key: 'service', label: 'Service', get: (l) => l.service ?? '' },
  { key: 'ownerKind', label: 'Owner kind', get: (l) => l.ownerKind ?? '' },
  { key: 'ownerName', label: 'Owner name', get: (l) => l.ownerName ?? '' },
  { key: 'ownerRef', label: 'Owner reference', get: (l) => l.ownerRef ?? '' },
  { key: 'ownerUser', label: 'Unix user', get: (l) => l.ownerUser ?? '' },
  { key: 'ownerDetail', label: 'Owner detail', get: (l) => l.ownerDetail ?? '' },
  { key: 'sourcePath', label: 'Source', get: (l) => l.sourcePath ?? '' },
  { key: 'pid', label: 'PID', get: (l) => l.pid ?? '' },
  { key: 'server', label: 'Server', get: (l) => l.server?.displayName || l.server?.hostname || '' },
  { key: 'environment', label: 'Environment', get: (l) => l.server?.environment ?? '' },
  { key: 'customer', label: 'Customer', get: (l) => l.server?.customer?.name ?? '' },
];

const DATASETS = {
  findings: { fields: FINDING_FIELDS, title: 'Exposure findings' },
  listeners: { fields: LISTENER_FIELDS, title: 'Listening ports' },
};

export function fieldCatalogue(dataset) {
  const spec = DATASETS[dataset];
  if (!spec) throw new ApiError(400, `Unknown dataset: ${dataset}`);
  return spec.fields.map((f) => ({ key: f.key, label: f.label }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const iso = (d) => (d ? new Date(d).toISOString() : '');

function findingStatus(f, now = new Date()) {
  if (f.resolvedAt) return 'resolved';
  if (f.mutedUntil && new Date(f.mutedUntil) > now) return 'muted';
  if (f.acknowledgedAt) return 'acknowledged';
  return 'open';
}

function csvCell(value) {
  const str = String(value ?? '');
  // Excel and Sheets treat a leading =, +, - or @ as a formula. Findings carry
  // strings read off a host, so this is reachable by an attacker who controls
  // a process name. Prefix with a quote to neutralise it.
  const guarded = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  if (guarded.includes(',') || guarded.includes('"') || guarded.includes('\n')) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/** Resolve requested field keys to catalogue entries, preserving catalogue order. */
function resolveFields(dataset, requested) {
  const all = DATASETS[dataset].fields;
  if (!requested || requested.length === 0) return all;
  const wanted = new Set(requested);
  const picked = all.filter((f) => wanted.has(f.key));
  if (picked.length === 0) throw new ApiError(400, 'No valid fields selected');
  return picked;
}

function slug(text) {
  return String(text || 'server')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'server';
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function toCsv(rows, fields) {
  const lines = [fields.map((f) => csvCell(f.label)).join(',')];
  for (const row of rows) {
    lines.push(fields.map((f) => csvCell(f.get(row))).join(','));
  }
  // A trailing newline — some tools drop the final record without it.
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function toJson(rows, fields, meta) {
  const items = rows.map((row) => {
    const out = {};
    for (const f of fields) out[f.key] = f.get(row);
    return out;
  });
  return Buffer.from(JSON.stringify({ ...meta, count: items.length, items }, null, 2), 'utf8');
}

/**
 * A printable report rather than a paginated table dump: a table wide enough
 * for every field would be unreadable on A4, so the PDF leads with a summary
 * and renders each row as a labelled block. People who want a grid take the
 * CSV; the PDF exists to be read and attached to a ticket.
 */
function toPdf(rows, fields, meta) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).text(meta.title);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9).fillColor('#666');
    doc.text(meta.subtitle);
    doc.text(`Generated ${new Date().toISOString()} · ${rows.length} record${rows.length === 1 ? '' : 's'}`);
    doc.fillColor('#000');

    if (meta.summary) {
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(10).text('Summary');
      doc.font('Helvetica').fontSize(9).fillColor('#333');
      doc.text(meta.summary);
      doc.fillColor('#000');
    }

    if (rows.length === 0) {
      doc.moveDown(1);
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#666').text('Nothing matched this export.');
      doc.end();
      return;
    }

    for (const row of rows) {
      doc.moveDown(0.9);
      // Keep a record together where it reasonably can be.
      if (doc.y > doc.page.height - 140) doc.addPage();

      const heading = fields[0] ? String(fields[0].get(row) ?? '') : '';
      const second = fields[1] ? String(fields[1].get(row) ?? '') : '';
      doc.font('Helvetica-Bold').fontSize(10).text([heading, second].filter(Boolean).join(' · '));
      doc.moveDown(0.15);

      for (const f of fields.slice(2)) {
        const value = String(f.get(row) ?? '');
        if (!value) continue;
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text(`${f.label}: `, { continued: true });
        doc.font('Helvetica').fillColor('#000').text(value);
      }
      doc
        .moveTo(48, doc.y + 4)
        .lineTo(doc.page.width - 48, doc.y + 4)
        .strokeColor('#e5e5e5')
        .stroke();
    }

    doc.end();
  });
}

async function render({ rows, fields, format, meta }) {
  if (format === 'csv') return { buffer: toCsv(rows, fields), contentType: 'text/csv', ext: 'csv' };
  if (format === 'json') return { buffer: toJson(rows, fields, meta), contentType: 'application/json', ext: 'json' };
  if (format === 'pdf') {
    return { buffer: await toPdf(rows, fields, meta), contentType: 'application/pdf', ext: 'pdf' };
  }
  throw new ApiError(400, `Unsupported format: ${format}`);
}

// ---------------------------------------------------------------------------
// Data loading — every query carries orgId AND the caller's customer scope.
// ---------------------------------------------------------------------------

const SERVER_INCLUDE = {
  select: {
    id: true,
    hostname: true,
    displayName: true,
    environment: true,
    ipAddress: true,
    customer: { select: { id: true, name: true } },
  },
};

/** Hard ceiling so one export can never try to buffer an unbounded fleet. */
const MAX_ROWS = 50000;

async function loadFindings(orgId, scope, { serverId, serverIds, status, severity, code, environment, customerId }) {
  const where = { orgId, ...relationScopeWhere(scope, 'server') };
  if (serverId) where.serverId = serverId;
  else if (serverIds?.length) where.serverId = { in: serverIds };
  if (severity) where.severity = severity;
  if (code) where.code = code;
  if (environment || customerId) {
    where.server = {
      ...(environment ? { environment } : {}),
      ...(customerId ? { customerId } : {}),
    };
  }

  const now = new Date();
  if (status === 'open') {
    where.resolvedAt = null;
    where.OR = [{ mutedUntil: null }, { mutedUntil: { lt: now } }];
  } else if (status === 'muted') {
    where.resolvedAt = null;
    where.mutedUntil = { gt: now };
  } else if (status === 'resolved') {
    where.NOT = { resolvedAt: null };
  }

  return prisma.exposureFinding.findMany({
    where,
    include: { server: SERVER_INCLUDE },
    orderBy: [{ severity: 'asc' }, { lastSeenAt: 'desc' }],
    take: MAX_ROWS,
  });
}

/**
 * Listeners from each server's most recent snapshot. Older snapshots exist
 * for history, but "what is listening" means "right now" — exporting every
 * snapshot's rows would multiply the file by the retention window.
 */
async function loadListeners(orgId, scope, { serverId, serverIds }) {
  const serverWhere = { orgId, ...serverScopeWhere(scope) };
  if (serverId) serverWhere.id = serverId;
  else if (serverIds?.length) serverWhere.id = { in: serverIds };

  const servers = await prisma.server.findMany({ where: serverWhere, ...SERVER_INCLUDE });
  if (servers.length === 0) return [];

  const snapshots = await prisma.hostSnapshot.findMany({
    where: { orgId, serverId: { in: servers.map((s) => s.id) } },
    orderBy: { receivedAt: 'desc' },
    select: { id: true, serverId: true },
  });
  const latestByServer = new Map();
  for (const snap of snapshots) {
    if (!latestByServer.has(snap.serverId)) latestByServer.set(snap.serverId, snap.id);
  }
  if (latestByServer.size === 0) return [];

  const rows = await prisma.hostListener.findMany({
    where: { orgId, snapshotId: { in: [...latestByServer.values()] } },
    orderBy: [{ port: 'asc' }, { proto: 'asc' }],
    take: MAX_ROWS,
  });

  const byId = new Map(servers.map((s) => [s.id, s]));
  return rows.map((r) => ({ ...r, server: byId.get(r.serverId) || null }));
}

async function loadRows(dataset, orgId, scope, filters) {
  if (dataset === 'findings') return loadFindings(orgId, scope, filters);
  if (dataset === 'listeners') return loadListeners(orgId, scope, filters);
  throw new ApiError(400, `Unknown dataset: ${dataset}`);
}

function summarize(dataset, rows) {
  if (dataset !== 'findings') {
    const internet = rows.filter((r) => r.reachability === 'INTERNET').length;
    return `${rows.length} listening port${rows.length === 1 ? '' : 's'}, ${internet} reachable from any source address.`;
  }
  const counts = rows.reduce((acc, r) => {
    acc[r.severity] = (acc[r.severity] || 0) + 1;
    return acc;
  }, {});
  return ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s.toLowerCase()}`)
    .join(' · ') || 'No findings matched.';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an export.
 *
 * @param {object} p
 * @param {string} p.orgId
 * @param {object} p.scope           caller's customer scope
 * @param {'findings'|'listeners'} p.dataset
 * @param {'csv'|'json'|'pdf'} p.format
 * @param {'single'|'zip'} p.bundle  zip = one file per server inside an archive
 * @param {string[]} [p.fields]      catalogue keys; empty = every field
 * @param {object} [p.filters]       serverId | serverIds | status | severity | code | environment | customerId
 * @returns {Promise<{buffer: Buffer, contentType: string, filename: string, rowCount: number, serverCount: number}>}
 */
export async function buildExport({ orgId, scope, dataset, format, bundle = 'single', fields, filters = {} }) {
  if (!DATASETS[dataset]) throw new ApiError(400, `Unknown dataset: ${dataset}`);
  if (!FORMATS.includes(format)) throw new ApiError(400, `Unsupported format: ${format}`);
  if (!BUNDLES.includes(bundle)) throw new ApiError(400, `Unsupported bundle: ${bundle}`);

  const picked = resolveFields(dataset, fields);
  const rows = await loadRows(dataset, orgId, scope, filters);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const title = DATASETS[dataset].title;

  if (bundle === 'zip') {
    // One file per server. A server with no rows still gets a file: an empty
    // export for a host you selected is a result ("nothing is listening"),
    // and a silently missing file reads as an error.
    const grouped = new Map();
    for (const row of rows) {
      const key = row.server?.id || row.serverId || 'unknown';
      if (!grouped.has(key)) grouped.set(key, { server: row.server, rows: [] });
      grouped.get(key).rows.push(row);
    }
    for (const id of filters.serverIds || []) {
      if (!grouped.has(id)) grouped.set(id, { server: null, rows: [] });
    }

    const zip = new AdmZip();
    const used = new Set();
    for (const [id, group] of grouped) {
      const base = slug(group.server?.displayName || group.server?.hostname || id);
      let name = `${base}-${dataset}`;
      let n = 2;
      while (used.has(name)) name = `${base}-${dataset}-${n++}`; // two hosts can share a display name
      used.add(name);

      const { buffer, ext } = await render({
        rows: group.rows,
        fields: picked,
        format,
        meta: {
          title,
          subtitle: group.server?.displayName || group.server?.hostname || id,
          summary: summarize(dataset, group.rows),
          exportedAt: new Date().toISOString(),
        },
      });
      zip.addFile(`${name}.${ext}`, buffer);
    }

    return {
      buffer: zip.toBuffer(),
      contentType: 'application/zip',
      filename: `shellius-${dataset}-${stamp}.zip`,
      rowCount: rows.length,
      serverCount: grouped.size,
    };
  }

  const serverIds = new Set(rows.map((r) => r.server?.id || r.serverId).filter(Boolean));
  const { buffer, contentType, ext } = await render({
    rows,
    fields: picked,
    format,
    meta: {
      title,
      subtitle:
        serverIds.size === 1
          ? rows[0]?.server?.displayName || rows[0]?.server?.hostname || 'One server'
          : `${serverIds.size} server${serverIds.size === 1 ? '' : 's'}`,
      summary: summarize(dataset, rows),
      exportedAt: new Date().toISOString(),
    },
  });

  return {
    buffer,
    contentType,
    filename: `shellius-${dataset}-${stamp}.${ext}`,
    rowCount: rows.length,
    serverCount: serverIds.size,
  };
}

export default { buildExport, fieldCatalogue, FINDING_FIELDS, LISTENER_FIELDS, FORMATS, BUNDLES };
