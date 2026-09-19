#!/usr/bin/env node
// Writes docs/rbac/permission-matrix.csv from the permission catalogue
// (src/config/permissions.js), so the doc can never drift from the code.
//   node scripts/rbac-matrix.mjs            write the file
//   node scripts/rbac-matrix.mjs --check    exit 1 if the file is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS, PERMISSION_GROUPS, TIERS } from '../src/config/permissions.js';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/rbac/permission-matrix.csv');
const groupLabel = Object.fromEntries(PERMISSION_GROUPS.map((g) => [g.key, g.label]));
const yn = (list, tier) => (tier === 'super_admin' || list.includes(tier) ? 'Y' : 'N');
const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const header = [
  'permission',
  'area',
  'label',
  'description',
  'sensitive',
  ...TIERS.map((t) => `before_${t}`),
  ...TIERS.map((t) => `default_${t}`),
  'changed',
  'endpoints',
  'audit_findings',
];

const rows = PERMISSIONS.map((p) => {
  const before = TIERS.map((t) => (p.current.length === 0 ? '-' : yn(p.current, t)));
  const after = TIERS.map((t) => yn(p.defaults, t));
  const changed = p.current.length === 0 ? 'new' : before.join() === after.join() ? '' : 'changed';
  return [
    p.key,
    groupLabel[p.group],
    p.label,
    p.description,
    p.sensitive ? 'yes' : '',
    ...before,
    ...after,
    changed,
    p.endpoints.join('; '),
    p.findings.join(' '),
  ];
});

const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {
    /* missing */
  }
  if (current !== csv) {
    console.error('docs/rbac/permission-matrix.csv is stale — run: node backend/scripts/rbac-matrix.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(out, csv);
  console.log(`wrote ${rows.length} permissions to ${out}`);
}
