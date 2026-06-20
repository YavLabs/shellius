/**
 * importParsers — turn an uploaded CSV / JSON / ZIP into normalized per-entity
 * row arrays (+ a file map for ZIP key files). Never throws on bad rows; the
 * caller validates each row downstream.
 */

import { parse as parseCsvSync } from 'csv-parse/sync';
import AdmZip from 'adm-zip';

export const ENTITIES = ['customers', 'servers', 'users', 'groups', 'policies', 'memberships'];

// Map a singular declared `type` to the plural entity bucket.
const SINGULAR_TO_PLURAL = {
  customer: 'customers',
  server: 'servers',
  user: 'users',
  group: 'groups',
  policy: 'policies',
  membership: 'memberships',
  customers: 'customers',
  servers: 'servers',
  users: 'users',
  groups: 'groups',
  policies: 'policies',
  memberships: 'memberships',
};

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Determine the entity bucket from a file stem inside a ZIP. Tolerant of
 * descriptive names: an exact match wins; otherwise any token (split on
 * non-letters) that names an entity is used — so "servers-ithena-onprem",
 * "servers_prod", "01-servers" all map to "servers".
 */
function entityFromStem(stem) {
  const s = String(stem).toLowerCase();
  if (SINGULAR_TO_PLURAL[s]) return SINGULAR_TO_PLURAL[s];
  for (const token of s.split(/[^a-z]+/).filter(Boolean)) {
    if (SINGULAR_TO_PLURAL[token]) return SINGULAR_TO_PLURAL[token];
  }
  return undefined;
}

/** Parse CSV text into an array of plain objects (string values, trimmed headers). */
export function parseCsv(text) {
  const clean = stripBom(String(text));
  if (!clean.trim()) return [];
  return parseCsvSync(clean, {
    columns: (header) => header.map((h) => String(h).trim()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  });
}

function emptyBuckets() {
  return { customers: [], servers: [], users: [], groups: [], policies: [], memberships: [] };
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} [declaredType] - singular entity for a single-entity csv/json
 * @returns {{ source: string, entities: object, files: Map<string,Buffer>, warnings: string[] }}
 */
export function parseUpload(buffer, filename, declaredType) {
  const lower = String(filename || '').toLowerCase();
  const warnings = [];
  const files = new Map();

  if (lower.endsWith('.zip')) {
    return parseZip(buffer, warnings);
  }

  if (lower.endsWith('.json') || (!lower.endsWith('.csv') && looksLikeJson(buffer))) {
    return { source: 'json', entities: parseJsonPayload(buffer, declaredType, warnings), files, warnings };
  }

  // Default: CSV single-entity.
  const bucket = SINGULAR_TO_PLURAL[String(declaredType || '').toLowerCase()];
  const entities = emptyBuckets();
  if (!bucket) {
    warnings.push('CSV upload requires a "type" (customers|servers|users|groups|policies|memberships).');
    return { source: 'csv', entities, files, warnings };
  }
  entities[bucket] = parseCsv(buffer.toString('utf8'));
  return { source: 'csv', entities, files, warnings };
}

function looksLikeJson(buffer) {
  const head = buffer.slice(0, 64).toString('utf8').trimStart();
  return head.startsWith('{') || head.startsWith('[');
}

function parseJsonPayload(buffer, declaredType, warnings) {
  const entities = emptyBuckets();
  let data;
  try {
    data = JSON.parse(stripBom(buffer.toString('utf8')));
  } catch (err) {
    warnings.push(`Invalid JSON: ${err.message}`);
    return entities;
  }

  if (Array.isArray(data)) {
    const bucket = SINGULAR_TO_PLURAL[String(declaredType || '').toLowerCase()];
    if (!bucket) {
      warnings.push('JSON array upload requires a "type".');
      return entities;
    }
    entities[bucket] = data;
    return entities;
  }

  if (data && typeof data === 'object') {
    for (const key of Object.keys(data)) {
      const bucket = SINGULAR_TO_PLURAL[key.toLowerCase()];
      if (bucket && Array.isArray(data[key])) entities[bucket] = data[key];
      else if (!bucket) warnings.push(`Ignoring unknown JSON key "${key}".`);
    }
    return entities;
  }

  warnings.push('Unsupported JSON shape.');
  return entities;
}

function parseZip(buffer, warnings) {
  const entities = emptyBuckets();
  const files = new Map();
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    warnings.push(`Invalid ZIP: ${err.message}`);
    return { source: 'zip', entities, files, warnings };
  }

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    // Zip-slip guard: ignore absolute / parent-traversal paths.
    if (name.startsWith('/') || name.includes('..')) {
      warnings.push(`Skipped unsafe zip path: ${name}`);
      continue;
    }
    const base = name.split('/').pop().toLowerCase();
    const stem = base.replace(/\.(csv|json)$/i, '');
    const bucket = entityFromStem(stem);
    const isCsv = /\.csv$/i.test(base);
    const isJson = /\.json$/i.test(base);

    if (bucket && isCsv) {
      entities[bucket] = parseCsv(entry.getData().toString('utf8'));
    } else if (bucket && isJson) {
      try {
        const data = JSON.parse(stripBom(entry.getData().toString('utf8')));
        entities[bucket] = Array.isArray(data) ? data : [];
      } catch (err) {
        warnings.push(`Invalid JSON in ${name}: ${err.message}`);
      }
    } else if (isCsv || isJson) {
      // A data file we couldn't map to an entity — tell the user instead of
      // silently dropping it (this is the usual "0 rows parsed" cause).
      warnings.push(
        `Could not determine the entity for "${name}". Name it so a token matches one of: ${ENTITIES.join(', ')} (e.g. servers-prod.csv).`
      );
      const data = entry.getData();
      files.set(name.replace(/\\/g, '/').toLowerCase(), data);
      files.set(base, data);
    } else {
      // Treat everything else (e.g. keys/*.pem, *.ppk) as a referenceable file.
      // Index under several normalized keys so a CSV reference resolves
      // regardless of folder nesting, case, or path separator.
      const data = entry.getData();
      const norm = name.replace(/\\/g, '/').toLowerCase();
      files.set(norm, data); // full normalized path
      files.set(norm.split('/').pop(), data); // basename
      files.set(name, data); // original (back-compat)
      files.set(base, data); // original basename lower
    }
  }

  return { source: 'zip', entities, files, warnings };
}

/**
 * Resolve a CSV-referenced file (e.g. "keys/foo.pem") against the zip's file
 * map. Tolerant of backslashes, leading "./", case, and folder nesting — a
 * basename or path-suffix match wins.
 *
 * @param {Map<string, Buffer>} files
 * @param {string} ref
 * @returns {Buffer|null}
 */
export function resolveFile(files, ref) {
  if (!ref || !files) return null;
  const r = String(ref).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  if (files.has(r)) return files.get(r);
  const base = r.split('/').pop();
  if (files.has(base)) return files.get(base);
  // Suffix / basename match against any stored entry.
  for (const [k, v] of files) {
    const kn = k.replace(/\\/g, '/').toLowerCase();
    if (kn === r || kn.endsWith('/' + r) || kn === base || kn.endsWith('/' + base)) return v;
  }
  return null;
}

export default { parseUpload, parseCsv, resolveFile, ENTITIES };
